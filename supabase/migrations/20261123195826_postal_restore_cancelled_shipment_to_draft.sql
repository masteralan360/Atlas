BEGIN;

CREATE FUNCTION public.postal_restore_shipment_to_draft(
  p_workspace_id uuid,
  p_shipment_id uuid,
  p_expected_revision integer,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_workspace uuid := public.current_workspace_id();
  v_actor uuid := auth.uid();
  v_role text;
  v_payload jsonb;
  v_cached postal_private.requests;
  v_shipment public.postal_shipments;
  v_before jsonb;
  v_origin_id uuid;
  v_origin_name text;
  v_actor_name text;
  v_result jsonb;
BEGIN
  v_role := postal_private.access_role(v_workspace);
  IF v_actor IS NULL OR v_role IS DISTINCT FROM 'admin'
    OR p_workspace_id IS DISTINCT FROM v_workspace
    OR p_shipment_id IS NULL
    OR p_expected_revision IS NULL
    OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;

  v_payload := jsonb_build_object(
    'workspace_id', v_workspace,
    'shipment_id', p_shipment_id,
    'expected_revision', p_expected_revision
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_workspace::text || v_actor::text || p_request_id::text, 0)
  );

  SELECT * INTO v_cached
  FROM postal_private.requests
  WHERE workspace_id = v_workspace
    AND actor_id = v_actor
    AND request_id = p_request_id;
  IF FOUND THEN
    IF v_cached.command <> 'restore_shipment_to_draft'
      OR v_cached.payload <> v_payload THEN
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
  IF v_shipment.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'postal_stale_shipment' USING ERRCODE = '40001';
  END IF;
  IF v_shipment.state <> 'cancelled' THEN
    RAISE EXCEPTION 'postal_invalid_transition' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.postal_cod_records WHERE shipment_id = v_shipment.id
  ) OR EXISTS (
    SELECT 1 FROM public.postal_delivery_fee_records WHERE shipment_id = v_shipment.id
  ) THEN
    RAISE EXCEPTION 'postal_restore_has_financial_activity' USING ERRCODE = '23514';
  END IF;

  v_before := to_jsonb(v_shipment);
  v_origin_id := v_shipment.current_branch_id;
  SELECT COALESCE(name, '') INTO v_actor_name
  FROM public.profiles WHERE id = v_actor;
  SELECT name INTO v_origin_name
  FROM public.postal_branches
  WHERE workspace_id = v_workspace AND id = v_origin_id;

  UPDATE public.postal_shipments
  SET state = 'draft',
      current_branch_id = NULL,
      driver_id = NULL,
      driver_name = NULL,
      revision = revision + 1,
      updated_at = now()
  WHERE workspace_id = v_workspace AND id = v_shipment.id
  RETURNING * INTO v_shipment;

  -- Clear the archive flag in a separate update because its guard only permits
  -- archive-only changes; the transaction keeps both updates atomic.
  IF v_shipment.is_archive THEN
    UPDATE public.postal_shipments
    SET is_archive = false
    WHERE workspace_id = v_workspace AND id = v_shipment.id
    RETURNING * INTO v_shipment;
  END IF;

  v_result := to_jsonb(v_shipment);
  INSERT INTO public.postal_events(
    workspace_id, shipment_id, event_type, previous_state, resulting_state,
    actor_id, actor_name, origin_id, notes, metadata
  ) VALUES (
    v_workspace, v_shipment.id, 'restore_to_draft', 'cancelled', 'draft',
    v_actor, COALESCE(v_actor_name, ''), v_origin_id, NULL,
    jsonb_build_object('origin_name', v_origin_name)
  );
  INSERT INTO public.postal_admin_audit(
    workspace_id, actor_id, action, entity_id, before_data, after_data
  ) VALUES (
    v_workspace, v_actor, 'restore_shipment_to_draft', v_shipment.id,
    v_before, v_result
  );
  INSERT INTO postal_private.requests(
    workspace_id, actor_id, request_id, command, payload, response
  ) VALUES (
    v_workspace, v_actor, p_request_id, 'restore_shipment_to_draft', v_payload, v_result
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.postal_restore_shipment_to_draft(uuid,uuid,integer,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_restore_shipment_to_draft(uuid,uuid,integer,uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
