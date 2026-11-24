BEGIN;

CREATE OR REPLACE FUNCTION public.postal_add_shipment_attachments(
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
  v_count integer;
  v_existing_count integer;
  v_existing_key_count integer;
  v_existing_match_count integer;
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
    OR jsonb_array_length(p_attachments) < 1 OR jsonb_array_length(p_attachments) > 5 THEN
    RAISE EXCEPTION 'postal_attachment_limit' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_shipment
  FROM public.postal_shipments
  WHERE workspace_id = v_workspace_id AND id = p_shipment_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR NOT postal_private.can_read(v_workspace_id, v_shipment.organization_id) THEN
    RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_shipment.state <> 'draft'
    AND NOT (v_role = 'admin' AND v_shipment.state <> 'cancelled') THEN
    RAISE EXCEPTION 'postal_attachment_shipment_locked' USING ERRCODE = '42501';
  END IF;

  v_count := jsonb_array_length(p_attachments);
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
  END LOOP;

  IF (SELECT count(DISTINCT item->>'object_key') FROM jsonb_array_elements(p_attachments) supplied(item)) <> v_count THEN
    RAISE EXCEPTION 'postal_attachment_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_existing_count
  FROM public.postal_shipment_attachments
  WHERE workspace_id = v_workspace_id AND shipment_id = p_shipment_id;

  SELECT count(*) INTO v_existing_key_count
  FROM public.postal_shipment_attachments attachment
  JOIN jsonb_array_elements(p_attachments) supplied(item)
    ON attachment.object_key = supplied.item->>'object_key'
  WHERE attachment.workspace_id = v_workspace_id AND attachment.shipment_id = p_shipment_id;

  SELECT count(*) INTO v_existing_match_count
  FROM public.postal_shipment_attachments attachment
  JOIN jsonb_array_elements(p_attachments) supplied(item)
    ON attachment.object_key = supplied.item->>'object_key'
   AND attachment.content_type = supplied.item->>'content_type'
   AND attachment.size_bytes = (supplied.item->>'size_bytes')::integer
   AND attachment.width = (supplied.item->>'width')::integer
   AND attachment.height = (supplied.item->>'height')::integer
  WHERE attachment.workspace_id = v_workspace_id AND attachment.shipment_id = p_shipment_id;

  IF v_existing_key_count = v_count AND v_existing_match_count = v_count THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(attachment) ORDER BY attachment.created_at, attachment.id), '[]'::jsonb)
    INTO v_result
    FROM public.postal_shipment_attachments attachment
    WHERE attachment.workspace_id = v_workspace_id AND attachment.shipment_id = p_shipment_id;
    RETURN v_result;
  END IF;
  IF v_existing_key_count > 0 THEN
    RAISE EXCEPTION 'postal_attachment_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_existing_count + v_count > 5 THEN
    RAISE EXCEPTION 'postal_attachment_limit' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_attachments)
  LOOP
    INSERT INTO public.postal_shipment_attachments(
      workspace_id, shipment_id, object_key, content_type, size_bytes,
      width, height, created_by
    ) VALUES (
      v_workspace_id, p_shipment_id, v_item->>'object_key', v_item->>'content_type',
      (v_item->>'size_bytes')::integer, (v_item->>'width')::integer,
      (v_item->>'height')::integer, v_actor_id
    );
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(attachment) ORDER BY attachment.created_at, attachment.id), '[]'::jsonb)
  INTO v_result
  FROM public.postal_shipment_attachments attachment
  WHERE attachment.workspace_id = v_workspace_id AND attachment.shipment_id = p_shipment_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.postal_add_shipment_attachments(uuid, uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_add_shipment_attachments(uuid, uuid, jsonb)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
