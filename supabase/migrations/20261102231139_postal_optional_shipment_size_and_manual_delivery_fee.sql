-- Let shipment creation store a manually entered fee without requiring a size.
-- When a size is selected without a manual fee, the existing tariff values remain
-- authoritative. When both are supplied, the manual fee replaces the tariff fee.
ALTER TABLE public.postal_shipments
  DROP CONSTRAINT postal_shipment_tariff_snapshot_check,
  ADD CONSTRAINT postal_shipment_tariff_snapshot_check CHECK (
    (
      shipment_size IS NULL
      AND tariff_zone IS NULL
      AND delivery_fee IS NULL
      AND tariff_assigned_at IS NULL
      AND tariff_assigned_by IS NULL
    )
    OR (
      delivery_fee IS NOT NULL
      AND tariff_assigned_at IS NOT NULL
      AND (
        (shipment_size IS NULL AND tariff_zone IS NULL)
        OR (
          shipment_size IS NOT NULL
          AND (
            (shipment_size = 'small_package' AND tariff_zone IN ('center', 'outside'))
            OR (shipment_size IN ('carton', 'ship') AND tariff_zone IS NULL)
          )
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION postal_private.apply_intake_tariff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
  v_size text;
  v_fee_text text;
  v_fee bigint;
  v_zone text;
  v_manual_override boolean;
  v_is_northern boolean;
  v_is_center boolean;
BEGIN
  IF OLD.state = 'draft' AND NEW.state IN ('draft','received')
    AND current_setting('postal.tariff_authorized', true) = 'true' THEN
    v_size := NULLIF(current_setting('postal.tariff_size', true), '');
    v_fee_text := NULLIF(current_setting('postal.tariff_fee', true), '');
    v_manual_override := COALESCE(
      current_setting('postal.tariff_fee_override', true) = 'true', false);

    -- An omitted selection keeps the existing assignment, including a previously
    -- entered fee. New manual fees are distinguished by the override flag.
    IF v_size IS NULL AND v_fee_text IS NULL THEN
      v_size := OLD.shipment_size;
      v_fee_text := OLD.delivery_fee::text;
      v_manual_override := OLD.delivery_fee IS NOT NULL;
    END IF;
    IF v_fee_text IS NULL THEN
      RAISE EXCEPTION 'postal_tariff_required' USING ERRCODE = '23514';
    END IF;
    IF v_fee_text !~ '^[0-9]{1,12}$' THEN
      RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
    END IF;
    v_fee := v_fee_text::bigint;
    IF v_fee <= 0 THEN
      RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
    END IF;

    v_is_northern := NEW.governorate IN ('sulaymaniyah','erbil','duhok');
    v_is_center := lower(NEW.area) LIKE '%center%' OR lower(NEW.area) LIKE '%centre%';
    IF v_size IS NULL THEN
      IF NOT v_manual_override THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      v_zone := NULL;
    ELSIF v_is_northern THEN
      v_zone := CASE WHEN v_is_center THEN 'center' ELSE 'outside' END;
      IF v_size IS DISTINCT FROM 'small_package'
        OR (NOT v_manual_override AND v_fee IS DISTINCT FROM
          (CASE WHEN v_is_center THEN 5000::bigint ELSE 6000::bigint END)) THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
    ELSE
      v_zone := NULL;
      IF v_size NOT IN ('carton','ship')
        OR (NOT v_manual_override AND NOT COALESCE((
          (v_size = 'carton' AND v_fee IN (8000,12000,15000,20000))
          OR (v_size = 'ship' AND v_fee IN (15000,24000,35000,55000))
        ), false)) THEN
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
  -- Reset command-scoped settings for every call in a transaction.
  PERFORM set_config('postal.tariff_authorized',
    CASE WHEN p_command IN ('create_shipment','edit_shipment','receive') THEN 'true' ELSE 'false' END, true);
  PERFORM set_config('postal.tariff_size', COALESCE(p_payload->>'tariff_size',''), true);
  PERFORM set_config('postal.tariff_fee', COALESCE(p_payload->>'delivery_fee',''), true);
  PERFORM set_config('postal.tariff_fee_override',
    CASE WHEN p_payload->>'delivery_fee_override' = 'true' THEN 'true' ELSE 'false' END, true);
  IF p_command IN ('generate_qr_batch','set_qr_batch_active','delete_qr_batch') THEN
    RETURN postal_private.qr_batch_command(p_command,p_payload,p_request_id);
  END IF;
  IF p_command = 'delivery_fee_collection' THEN
    RETURN postal_private.delivery_fee_collection(p_payload,p_request_id);
  END IF;
  RETURN postal_private.command(p_command,p_payload,p_request_id);
END;
$$;

REVOKE ALL ON FUNCTION postal_private.apply_intake_tariff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.postal_command(text,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_command(text,jsonb,uuid) TO authenticated, service_role;
