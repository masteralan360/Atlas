-- Services are catalog-only items: their product quantity snapshot is
-- intentionally NULL because they do not participate in inventory. The
-- inventory guard still applies to every physical product and inventory row.
CREATE OR REPLACE FUNCTION private.guard_nonnegative_quantity_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_old_quantity numeric;
  v_new_quantity numeric;
BEGIN
  -- The same guard is installed on products and inventory. Inspecting the
  -- trigger row keeps the shared function compatible with inventory rows,
  -- which have no is_service field, while allowing the deliberate NULL
  -- snapshot used by services.
  IF COALESCE((pg_catalog.to_jsonb(NEW) ->> 'is_service')::boolean, false) THEN
    RETURN NEW;
  END IF;

  v_new_quantity := NEW.quantity;

  IF v_new_quantity IS NULL
    OR v_new_quantity::text IN ('NaN', 'Infinity', '-Infinity')
  THEN
    RAISE EXCEPTION 'Inventory quantity must be a finite number'
      USING ERRCODE = '23514',
            CONSTRAINT = TG_TABLE_NAME || '_quantity_finite';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_quantity < 0 THEN
      RAISE EXCEPTION 'Inventory quantity cannot be negative'
        USING ERRCODE = '23514',
              CONSTRAINT = TG_TABLE_NAME || '_quantity_nonnegative';
    END IF;
    RETURN NEW;
  END IF;

  v_old_quantity := OLD.quantity;

  -- A legacy invalid/non-finite value may only be replaced by a finite value.
  IF v_old_quantity IS NULL
    OR v_old_quantity::text IN ('NaN', 'Infinity', '-Infinity')
  THEN
    RETURN NEW;
  END IF;

  IF v_old_quantity < 0 THEN
    IF v_new_quantity < v_old_quantity THEN
      RAISE EXCEPTION 'A legacy inventory deficit cannot be increased'
        USING ERRCODE = '23514',
              CONSTRAINT = TG_TABLE_NAME || '_quantity_legacy_not_worsened';
    END IF;
  ELSIF v_new_quantity < 0 THEN
    RAISE EXCEPTION 'Inventory quantity cannot be negative'
      USING ERRCODE = '23514',
            CONSTRAINT = TG_TABLE_NAME || '_quantity_nonnegative';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_nonnegative_quantity_transition() FROM PUBLIC, anon, authenticated;
