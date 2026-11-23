BEGIN;

CREATE TABLE public.postal_shipment_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512),
  content_type text NOT NULL CHECK (content_type = 'image/webp'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 2560),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 2560),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, object_key),
  FOREIGN KEY (workspace_id, shipment_id)
    REFERENCES public.postal_shipments(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX postal_shipment_attachments_shipment
  ON public.postal_shipment_attachments(workspace_id, shipment_id, created_at, id);

ALTER TABLE public.postal_shipment_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.postal_shipment_attachments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.postal_shipment_attachments TO authenticated;
GRANT ALL ON public.postal_shipment_attachments TO service_role;

CREATE POLICY postal_shipment_attachments_read
  ON public.postal_shipment_attachments FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND postal_private.can_read_shipment(workspace_id, shipment_id)
    AND EXISTS (
      SELECT 1 FROM public.postal_shipments shipment
      WHERE shipment.workspace_id = postal_shipment_attachments.workspace_id
        AND shipment.id = postal_shipment_attachments.shipment_id
        AND shipment.deleted_at IS NULL
    )
  );

-- This queue keeps object keys available for an idempotent R2 cleanup retry if
-- an object delete fails after a shipment has been deleted.
CREATE TABLE public.postal_shipment_attachment_cleanup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  object_key text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, object_key)
);

CREATE INDEX postal_shipment_attachment_cleanup_shipment
  ON public.postal_shipment_attachment_cleanup(workspace_id, shipment_id, queued_at, id);

ALTER TABLE public.postal_shipment_attachment_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.postal_shipment_attachment_cleanup FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.postal_shipment_attachment_cleanup TO authenticated;
GRANT ALL ON public.postal_shipment_attachment_cleanup TO service_role;

CREATE POLICY postal_shipment_attachment_cleanup_read
  ON public.postal_shipment_attachment_cleanup FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (
      postal_private.access_role(workspace_id) IN ('admin', 'office')
      OR postal_private.can_read_shipment(workspace_id, shipment_id)
    )
  );

CREATE FUNCTION postal_private.queue_shipment_attachment_cleanup()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_workspace_id uuid;
  v_shipment_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_workspace_id := OLD.workspace_id;
    v_shipment_id := OLD.id;
  ELSE
    IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
      RETURN NEW;
    END IF;
    v_workspace_id := NEW.workspace_id;
    v_shipment_id := NEW.id;
  END IF;

  INSERT INTO public.postal_shipment_attachment_cleanup(workspace_id, shipment_id, object_key)
  SELECT workspace_id, shipment_id, object_key
  FROM public.postal_shipment_attachments
  WHERE workspace_id = v_workspace_id AND shipment_id = v_shipment_id
  ON CONFLICT (workspace_id, object_key) DO NOTHING;

  DELETE FROM public.postal_shipment_attachments
  WHERE workspace_id = v_workspace_id AND shipment_id = v_shipment_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION postal_private.queue_shipment_attachment_cleanup()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER postal_shipment_attachment_soft_delete_cleanup
  AFTER UPDATE OF deleted_at ON public.postal_shipments
  FOR EACH ROW EXECUTE FUNCTION postal_private.queue_shipment_attachment_cleanup();

CREATE TRIGGER postal_shipment_attachment_delete_cleanup
  BEFORE DELETE ON public.postal_shipments
  FOR EACH ROW EXECUTE FUNCTION postal_private.queue_shipment_attachment_cleanup();

CREATE FUNCTION public.postal_save_shipment_attachments(
  p_workspace_id uuid,
  p_shipment_id uuid,
  p_attachments jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_actor_id uuid := auth.uid();
  v_role text;
  v_shipment public.postal_shipments;
  v_item jsonb;
  v_object_key text;
  v_content_type text;
  v_size_text text;
  v_width_text text;
  v_height_text text;
  v_existing_keys text[];
  v_incoming_keys text[];
  v_existing_count integer;
  v_count integer;
  v_result jsonb;
BEGIN
  IF v_actor_id IS NULL OR p_workspace_id IS DISTINCT FROM v_workspace_id OR p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  v_role := postal_private.access_role(v_workspace_id);
  IF COALESCE(v_role, '') NOT IN ('admin', 'office', 'merchant') THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_attachments IS NULL OR jsonb_typeof(p_attachments) <> 'array'
    OR jsonb_array_length(p_attachments) > 5 THEN
    RAISE EXCEPTION 'postal_attachment_limit' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_shipment
  FROM public.postal_shipments
  WHERE workspace_id = v_workspace_id AND id = p_shipment_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR NOT postal_private.can_read(v_workspace_id, v_shipment.organization_id) THEN
    RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_shipment.state <> 'draft' THEN
    RAISE EXCEPTION 'postal_attachment_shipment_locked' USING ERRCODE = '42501';
  END IF;

  SELECT count(*), array_agg(object_key ORDER BY object_key)
  INTO v_existing_count, v_existing_keys
  FROM public.postal_shipment_attachments
  WHERE workspace_id = v_workspace_id AND shipment_id = p_shipment_id;

  SELECT array_agg(item->>'object_key' ORDER BY item->>'object_key')
  INTO v_incoming_keys
  FROM jsonb_array_elements(p_attachments) WITH ORDINALITY AS supplied(item, item_order);

  IF v_existing_count > 0 THEN
    IF v_existing_keys IS DISTINCT FROM v_incoming_keys THEN
      RAISE EXCEPTION 'postal_attachment_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT COALESCE(jsonb_agg(to_jsonb(attachment) ORDER BY attachment.created_at, attachment.id), '[]'::jsonb)
    INTO v_result
    FROM public.postal_shipment_attachments attachment
    WHERE attachment.workspace_id = v_workspace_id AND attachment.shipment_id = p_shipment_id;
    RETURN v_result;
  END IF;

  v_count := jsonb_array_length(p_attachments);
  IF v_count = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_attachments)
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'postal_attachment_invalid' USING ERRCODE = '22023';
    END IF;
    v_object_key := v_item->>'object_key';
    v_content_type := v_item->>'content_type';
    v_size_text := v_item->>'size_bytes';
    v_width_text := v_item->>'width';
    v_height_text := v_item->>'height';

    IF v_content_type IS DISTINCT FROM 'image/webp'
      OR v_object_key IS NULL
      OR v_object_key !~ (
        '^' || v_workspace_id::text || '/shipment-attachments/' || p_shipment_id::text ||
        '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}--atlas-shipment-attachment-v1[.]webp$'
      )
      OR v_size_text IS NULL OR v_size_text !~ '^[1-9][0-9]{0,6}$'
      OR v_width_text IS NULL OR v_width_text !~ '^[1-9][0-9]{0,3}$'
      OR v_height_text IS NULL OR v_height_text !~ '^[1-9][0-9]{0,3}$'
      OR v_size_text::integer > 5242880
      OR v_width_text::integer > 2560
      OR v_height_text::integer > 2560 THEN
      RAISE EXCEPTION 'postal_attachment_invalid' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.postal_shipment_attachments(
      workspace_id, shipment_id, object_key, content_type, size_bytes,
      width, height, created_by
    ) VALUES (
      v_workspace_id, p_shipment_id, v_object_key, v_content_type,
      v_size_text::integer, v_width_text::integer, v_height_text::integer, v_actor_id
    );
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(attachment) ORDER BY attachment.created_at, attachment.id), '[]'::jsonb)
  INTO v_result
  FROM public.postal_shipment_attachments attachment
  WHERE attachment.workspace_id = v_workspace_id AND attachment.shipment_id = p_shipment_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.postal_save_shipment_attachments(uuid, uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_save_shipment_attachments(uuid, uuid, jsonb)
  TO authenticated, service_role;

CREATE FUNCTION public.postal_finish_shipment_attachment_cleanup(
  p_workspace_id uuid,
  p_shipment_id uuid,
  p_object_keys text[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_actor_id uuid := auth.uid();
  v_role text;
  v_authorized integer;
  v_removed integer;
BEGIN
  IF v_actor_id IS NULL OR p_workspace_id IS DISTINCT FROM v_workspace_id OR p_shipment_id IS NULL
    OR p_object_keys IS NULL OR cardinality(p_object_keys) > 100 THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  v_role := postal_private.access_role(v_workspace_id);
  IF COALESCE(v_role, '') NOT IN ('admin', 'office', 'merchant') THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_authorized
  FROM public.postal_shipment_attachment_cleanup cleanup
  WHERE cleanup.workspace_id = v_workspace_id
    AND cleanup.shipment_id = p_shipment_id
    AND cleanup.object_key = ANY(p_object_keys)
    AND (
      v_role IN ('admin', 'office')
      OR postal_private.can_read_shipment(v_workspace_id, cleanup.shipment_id)
    );
  IF v_authorized <> cardinality(ARRAY(SELECT DISTINCT unnest(p_object_keys))) THEN
    RAISE EXCEPTION 'postal_attachment_cleanup_unavailable' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.postal_shipment_attachment_cleanup cleanup
  WHERE cleanup.workspace_id = v_workspace_id
    AND cleanup.shipment_id = p_shipment_id
    AND cleanup.object_key = ANY(p_object_keys);
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$function$;

REVOKE ALL ON FUNCTION public.postal_finish_shipment_attachment_cleanup(uuid, uuid, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_finish_shipment_attachment_cleanup(uuid, uuid, text[])
  TO authenticated, service_role;

CREATE FUNCTION public.postal_queue_shipment_attachment_cleanup(
  p_workspace_id uuid,
  p_shipment_id uuid,
  p_object_keys text[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_actor_id uuid := auth.uid();
  v_role text;
  v_shipment public.postal_shipments;
  v_key text;
  v_queued integer;
BEGIN
  IF v_actor_id IS NULL OR p_workspace_id IS DISTINCT FROM v_workspace_id OR p_shipment_id IS NULL
    OR p_object_keys IS NULL OR cardinality(p_object_keys) > 100 THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  v_role := postal_private.access_role(v_workspace_id);
  IF COALESCE(v_role, '') NOT IN ('admin', 'office', 'merchant') THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_shipment
  FROM public.postal_shipments
  WHERE workspace_id = v_workspace_id AND id = p_shipment_id
  FOR UPDATE;
  IF NOT FOUND OR NOT postal_private.can_read(v_workspace_id, v_shipment.organization_id) THEN
    RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
  END IF;

  FOREACH v_key IN ARRAY p_object_keys LOOP
    IF v_key !~ (
      '^' || v_workspace_id::text || '/shipment-attachments/' || p_shipment_id::text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}--atlas-shipment-attachment-v1[.]webp$'
    ) THEN
      RAISE EXCEPTION 'postal_attachment_invalid' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.postal_shipment_attachment_cleanup(workspace_id, shipment_id, object_key)
  SELECT v_workspace_id, p_shipment_id, supplied.object_key
  FROM unnest(p_object_keys) AS supplied(object_key)
  ON CONFLICT (workspace_id, object_key) DO NOTHING;
  GET DIAGNOSTICS v_queued = ROW_COUNT;
  RETURN v_queued;
END;
$function$;

REVOKE ALL ON FUNCTION public.postal_queue_shipment_attachment_cleanup(uuid, uuid, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_queue_shipment_attachment_cleanup(uuid, uuid, text[])
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
