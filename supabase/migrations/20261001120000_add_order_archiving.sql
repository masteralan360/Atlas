ALTER TABLE crm.sales_orders
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

ALTER TABLE crm.purchase_orders
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION crm.enforce_order_archive_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, crm
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_archived, false) THEN
      RAISE EXCEPTION 'order_archive_requires_existing_order'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.is_archived IS NOT DISTINCT FROM NEW.is_archived THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'is_archived') IS DISTINCT FROM (to_jsonb(OLD) - 'is_archived') THEN
    RAISE EXCEPTION 'order_archive_must_not_change_order_data'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.is_archived THEN
    IF TG_TABLE_NAME = 'sales_orders' THEN
      IF lower(COALESCE(NEW.status, '')) NOT IN ('cancelled', 'returned')
        AND lower(COALESCE(NEW.return_status, '')) <> 'full' THEN
        RAISE EXCEPTION 'order_archive_not_allowed'
          USING ERRCODE = '23514';
      END IF;
    ELSIF lower(COALESCE(NEW.status, '')) NOT IN ('cancelled', 'returned') THEN
      RAISE EXCEPTION 'order_archive_not_allowed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS crm_sales_orders_archive_guard ON crm.sales_orders;
CREATE TRIGGER crm_sales_orders_archive_guard
  BEFORE INSERT OR UPDATE OF is_archived ON crm.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION crm.enforce_order_archive_rules();

DROP TRIGGER IF EXISTS crm_purchase_orders_archive_guard ON crm.purchase_orders;
CREATE TRIGGER crm_purchase_orders_archive_guard
  BEFORE INSERT OR UPDATE OF is_archived ON crm.purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION crm.enforce_order_archive_rules();

NOTIFY pgrst, 'reload schema';
