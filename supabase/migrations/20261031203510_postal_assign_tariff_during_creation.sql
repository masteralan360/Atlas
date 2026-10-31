-- Assign a draft's tariff at creation; office intake confirms or replaces it.
-- The command already performs a final UPDATE before saving its response/event,
-- so the same trigger validates creation, draft edits, and physical receipt.
CREATE OR REPLACE FUNCTION postal_private.apply_intake_tariff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
  v_size text;
  v_fee_text text;
  v_fee bigint;
  v_zone text;
  v_is_northern boolean;
  v_is_center boolean;
BEGIN
  IF OLD.state = 'draft' AND NEW.state IN ('draft','received')
    AND current_setting('postal.tariff_authorized', true) = 'true' THEN
    -- An omitted review selection retains the current assignment. An explicit
    -- but incomplete selection must still fail validation.
    v_size := current_setting('postal.tariff_size', true);
    v_fee_text := current_setting('postal.tariff_fee', true);
    IF COALESCE(v_size, '') = '' AND COALESCE(v_fee_text, '') = '' THEN
      v_size := OLD.shipment_size;
      v_fee_text := OLD.delivery_fee::text;
    END IF;
    IF v_size IS NULL OR COALESCE(v_fee_text, '') = '' THEN
      RAISE EXCEPTION 'postal_tariff_required' USING ERRCODE = '23514';
    END IF;
    IF v_fee_text !~ '^[0-9]{1,12}$' THEN
      RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
    END IF;
    v_fee := v_fee_text::bigint;
    v_is_northern := NEW.governorate IN ('sulaymaniyah','erbil','duhok');
    v_is_center := lower(NEW.area) LIKE '%center%' OR lower(NEW.area) LIKE '%centre%';
    IF v_is_northern THEN
      v_zone := CASE WHEN v_is_center THEN 'center' ELSE 'outside' END;
      IF v_size IS DISTINCT FROM 'small_package'
        OR v_fee IS DISTINCT FROM (CASE WHEN v_is_center THEN 5000::bigint ELSE 6000::bigint END) THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
    ELSE
      v_zone := NULL;
      IF NOT COALESCE((
        (v_size = 'carton' AND v_fee IN (8000,12000,15000))
        OR (v_size = 'ship' AND v_fee IN (15000,24000,35000,55000))
      ), false) THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
    END IF;

    NEW.shipment_size := v_size;
    NEW.tariff_zone := v_zone;
    NEW.delivery_fee := v_fee;
    IF OLD.tariff_assigned_at IS NULL
      OR ROW(v_size, v_zone, v_fee)
        IS DISTINCT FROM ROW(OLD.shipment_size, OLD.tariff_zone, OLD.delivery_fee) THEN
      NEW.tariff_assigned_by := auth.uid();
      NEW.tariff_assigned_at := now();
    END IF;
  ELSIF OLD.state = 'draft' AND NEW.state = 'received' THEN
    RAISE EXCEPTION 'postal_tariff_required' USING ERRCODE = '23514';
  ELSIF ROW(NEW.shipment_size, NEW.tariff_zone, NEW.delivery_fee,
            NEW.tariff_assigned_by, NEW.tariff_assigned_at)
    IS DISTINCT FROM ROW(OLD.shipment_size, OLD.tariff_zone, OLD.delivery_fee,
                          OLD.tariff_assigned_by, OLD.tariff_assigned_at) THEN
    RAISE EXCEPTION 'postal_tariff_locked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.postal_command(
  p_command text,
  p_payload jsonb,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  -- Reset these for every command, including multiple commands in one transaction.
  PERFORM set_config('postal.tariff_authorized',
    CASE WHEN p_command IN ('create_shipment','edit_shipment','receive') THEN 'true' ELSE 'false' END, true);
  PERFORM set_config('postal.tariff_size', COALESCE(p_payload->>'tariff_size',''), true);
  PERFORM set_config('postal.tariff_fee', COALESCE(p_payload->>'delivery_fee',''), true);
  IF p_command = 'delivery_fee_collection' THEN
    RETURN postal_private.delivery_fee_collection(p_payload,p_request_id);
  END IF;
  RETURN postal_private.command(p_command,p_payload,p_request_id);
END;
$$;

-- Draft edits keep their normal history, excluding replaceable tariff fields.
-- Request replay records must not retain a superseded assignment either.
-- Remove tariff data from earlier draft responses once it is replaced. Replays
-- then read the current tariff while preserving their other response fields.
CREATE INDEX postal_draft_request_shipment
  ON postal_private.requests (workspace_id, (response->>'id'))
  WHERE command IN ('create_shipment','edit_shipment');

DO $$
DECLARE
  v_source text;
  v_updated text;
BEGIN
  SELECT prosrc INTO v_source FROM pg_proc
  WHERE oid = 'postal_private.command(text,jsonb,uuid)'::regprocedure;

  v_updated := replace(v_source,
    'detail:=jsonb_build_object(''before'',to_jsonb(s),''reason'',p_payload->>''reason'');',
    $code$detail:=jsonb_build_object('before',
      CASE WHEN s.state = 'draft' THEN to_jsonb(s) - ARRAY[
        'shipment_size','tariff_zone','delivery_fee','tariff_assigned_by','tariff_assigned_at'
      ] ELSE to_jsonb(s) END, 'reason',p_payload->>'reason');$code$);
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft correction snapshot';
  END IF;
  v_source := v_updated;

  v_updated := replace(v_source,
    'cached.payload<>p_payload',
    $code$(cached.payload<>p_payload AND NOT (
      p_command IN ('create_shipment','edit_shipment')
      AND NOT (cached.response ? 'shipment_size')
      AND cached.payload = p_payload - ARRAY['tariff_size','delivery_fee']
    ))$code$);
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft replay comparison';
  END IF;
  v_source := v_updated;

  v_updated := replace(v_source, 'RETURN cached.response;',
    $code$IF p_command IN ('create_shipment','edit_shipment')
      AND NOT (cached.response ? 'shipment_size') THEN
      RETURN cached.response || COALESCE((
        SELECT jsonb_build_object(
          'shipment_size', current_shipment.shipment_size,
          'tariff_zone', current_shipment.tariff_zone,
          'delivery_fee', current_shipment.delivery_fee,
          'tariff_assigned_by', current_shipment.tariff_assigned_by,
          'tariff_assigned_at', current_shipment.tariff_assigned_at
        ) FROM public.postal_shipments current_shipment
        WHERE current_shipment.workspace_id = w
          AND current_shipment.id = (cached.response->>'id')::uuid
      ), '{}'::jsonb);
    END IF;
    RETURN cached.response;$code$);
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft replay response';
  END IF;
  v_source := v_updated;

  -- Run after successful validation, under the shipment lock. This also handles
  -- a tariff replaced while editing a draft before physical receipt.
  v_updated := replace(v_source,
    'INSERT INTO postal_private.requests VALUES(w,actor,p_request_id,p_command,p_payload,result);',
    $code$IF p_command IN ('edit_shipment','receive') AND previous = 'draft' THEN
      UPDATE postal_private.requests saved_request
      SET payload = saved_request.payload - ARRAY['tariff_size','delivery_fee'],
          response = saved_request.response - ARRAY[
            'shipment_size','tariff_zone','delivery_fee','tariff_assigned_by','tariff_assigned_at'
          ]
      WHERE saved_request.workspace_id = w
        AND saved_request.command IN ('create_shipment','edit_shipment')
        AND saved_request.response->>'id' = s.id::text;
    END IF;
    INSERT INTO postal_private.requests VALUES(w,actor,p_request_id,p_command,p_payload,result);$code$);
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft request snapshots';
  END IF;
  EXECUTE format(
    $ddl$CREATE OR REPLACE FUNCTION postal_private.command(
      p_command text, p_payload jsonb, p_request_id uuid
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS %L$ddl$,
    v_updated
  );
END;
$$;

-- CREATE OR REPLACE preserves existing privileges; keep explicit API boundaries.
REVOKE ALL ON FUNCTION postal_private.apply_intake_tariff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION postal_private.command(text,jsonb,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.postal_command(text,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_command(text,jsonb,uuid) TO authenticated, service_role;
