-- Allow the non-northern Extra Large Carton tariff in draft creation and intake.
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
        (v_size = 'carton' AND v_fee IN (8000,12000,15000,20000))
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

REVOKE ALL ON FUNCTION postal_private.apply_intake_tariff() FROM PUBLIC, anon, authenticated;
