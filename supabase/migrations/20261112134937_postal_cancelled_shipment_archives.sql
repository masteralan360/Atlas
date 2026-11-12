BEGIN;

ALTER TABLE public.postal_shipments
  ADD COLUMN IF NOT EXISTS is_archive boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.postal_shipments.is_archive IS
  'Hides an eligible cancelled shipment from the regular Post Service list while retaining its history.';

CREATE INDEX IF NOT EXISTS postal_shipments_archive_inbox
  ON public.postal_shipments (workspace_id, created_at DESC, id DESC)
  WHERE is_archive = true AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION postal_private.enforce_shipment_archive_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_archive, false) THEN
      RAISE EXCEPTION 'postal_archive_requires_existing_shipment'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.is_archive IS NOT DISTINCT FROM NEW.is_archive THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'is_archive') IS DISTINCT FROM (to_jsonb(OLD) - 'is_archive') THEN
    RAISE EXCEPTION 'postal_archive_must_not_change_shipment_data'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.is_archive AND NEW.state <> 'cancelled' THEN
    RAISE EXCEPTION 'postal_archive_not_allowed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS postal_shipments_archive_guard ON public.postal_shipments;
CREATE TRIGGER postal_shipments_archive_guard
  BEFORE INSERT OR UPDATE OF is_archive ON public.postal_shipments
  FOR EACH ROW
  EXECUTE FUNCTION postal_private.enforce_shipment_archive_rules();

-- Keep the established page RPC signature and add archive exclusion in place.
DO $block$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  v_definition := pg_get_functiondef(
    'public.postal_shipment_page(uuid,integer,integer,text,text,timestamptz,timestamptz)'::regprocedure
  );
  v_updated := replace(
    v_definition,
    'AND s.deleted_at IS NULL',
    'AND s.deleted_at IS NULL
      AND NOT COALESCE(s.is_archive, false)'
  );
  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'Could not add archive filtering to postal_shipment_page';
  END IF;
  EXECUTE v_updated;
END;
$block$;

-- Keep archived shipments out of the regular Post Service dashboard totals.
DO $block$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  v_definition := pg_get_functiondef(
    'postal_private.dashboard_summary(uuid,text,text,timestamptz,timestamptz)'::regprocedure
  );
  v_updated := replace(
    v_definition,
    'WHERE s.workspace_id = p_workspace_id AND s.deleted_at IS NULL',
    'WHERE s.workspace_id = p_workspace_id AND s.deleted_at IS NULL
      AND NOT COALESCE(s.is_archive, false)'
  );
  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'Could not add archive filtering to postal dashboard summary';
  END IF;
  EXECUTE v_updated;
END;
$block$;

CREATE FUNCTION public.postal_archived_shipment_page(
  p_workspace_id uuid,
  p_page integer,
  p_page_size integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  v_role text := postal_private.access_role(p_workspace_id);
  v_result jsonb;
BEGIN
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_page IS NULL OR p_page < 1 OR p_page > 1000000
    OR p_page_size IS NULL OR p_page_size NOT IN (20, 50, 100) THEN
    RAISE EXCEPTION 'postal_invalid_filter' USING ERRCODE = '22023';
  END IF;

  WITH matched AS MATERIALIZED (
    SELECT
      s.*,
      o.name AS organization_name
    FROM public.postal_shipments s
    LEFT JOIN public.postal_organizations o
      ON o.workspace_id = s.workspace_id AND o.id = s.organization_id
    WHERE s.workspace_id = p_workspace_id
      AND s.deleted_at IS NULL
      AND s.is_archive = true
      AND s.state = 'cancelled'
  ), page_rows AS MATERIALIZED (
    SELECT * FROM matched
    ORDER BY created_at DESC, id DESC
    OFFSET ((p_page - 1) * p_page_size)
    LIMIT p_page_size
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(page_rows) ORDER BY page_rows.created_at DESC, page_rows.id DESC)
      FROM page_rows
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM matched)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.postal_archived_shipment_page(uuid,integer,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_archived_shipment_page(uuid,integer,integer)
  TO authenticated, service_role;

CREATE FUNCTION public.postal_set_shipment_archive(
  p_workspace_id uuid,
  p_shipment_id uuid,
  p_is_archive boolean,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_workspace uuid := public.current_workspace_id();
  v_actor uuid := auth.uid();
  v_role text;
  v_request_payload jsonb;
  v_cached postal_private.requests;
  v_shipment public.postal_shipments;
  v_result jsonb;
BEGIN
  v_role := postal_private.access_role(v_workspace);
  IF v_actor IS NULL OR v_role IS DISTINCT FROM 'admin'
    OR p_workspace_id IS DISTINCT FROM v_workspace
    OR p_request_id IS NULL OR p_is_archive IS NULL THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;

  v_request_payload := jsonb_build_object(
    'workspace_id', v_workspace,
    'shipment_id', p_shipment_id,
    'is_archive', p_is_archive
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_workspace::text || v_actor::text || p_request_id::text, 0)
  );

  SELECT * INTO v_cached
  FROM postal_private.requests
  WHERE workspace_id = v_workspace AND actor_id = v_actor AND request_id = p_request_id;
  IF FOUND THEN
    IF v_cached.command <> 'archive_shipment'
      OR v_cached.payload <> v_request_payload THEN
      RAISE EXCEPTION 'postal_request_conflict';
    END IF;
    RETURN v_cached.response;
  END IF;

  SELECT * INTO v_shipment
  FROM public.postal_shipments
  WHERE workspace_id = v_workspace
    AND id = p_shipment_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR NOT postal_private.can_read(v_workspace, v_shipment.organization_id) THEN
    RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_is_archive AND v_shipment.state <> 'cancelled' THEN
    RAISE EXCEPTION 'postal_archive_not_allowed' USING ERRCODE = '23514';
  END IF;

  IF v_shipment.is_archive IS DISTINCT FROM p_is_archive THEN
    UPDATE public.postal_shipments
    SET is_archive = p_is_archive
    WHERE workspace_id = v_workspace AND id = p_shipment_id
    RETURNING * INTO v_shipment;
  END IF;
  v_result := to_jsonb(v_shipment);

  INSERT INTO postal_private.requests(workspace_id, actor_id, request_id, command, payload, response)
  VALUES(v_workspace, v_actor, p_request_id, 'archive_shipment', v_request_payload, v_result);

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.postal_set_shipment_archive(uuid,uuid,boolean,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_set_shipment_archive(uuid,uuid,boolean,uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
