CREATE OR REPLACE FUNCTION public.request_commerce_order_notification_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_is_commerce_order boolean := false;
BEGIN
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'commerce_operations_records' THEN
    v_is_commerce_order := NEW.record_type = 'order_details'
      AND COALESCE(NEW.is_deleted, false) = false
      AND NEW.related_order_id IS NOT NULL
      AND COALESCE(NEW.payload ->> 'channel', '') IN ('social', 'wholesale');
  ELSIF TG_TABLE_SCHEMA = 'crm' AND TG_TABLE_NAME = 'sales_orders' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.commerce_operations_records AS record
      WHERE record.workspace_id = NEW.workspace_id
        AND record.related_order_id = NEW.id
        AND record.record_type = 'order_details'
        AND COALESCE(record.is_deleted, false) = false
        AND COALESCE(record.payload ->> 'channel', '') IN ('social', 'wholesale')
    ) INTO v_is_commerce_order;
  END IF;

  IF v_is_commerce_order THEN
    BEGIN
      -- Queue an immediate, workspace-scoped Edge Function dispatch. The scheduled
      -- dispatcher remains in place to retry if the asynchronous request fails.
      PERFORM public.request_dispatch_notifications(NEW.workspace_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not request immediate commerce order notification dispatch: %', SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_commerce_order_notification_dispatch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_dispatch_commerce_order_created_from_intake ON public.commerce_operations_records;
CREATE TRIGGER zz_dispatch_commerce_order_created_from_intake
  AFTER INSERT ON public.commerce_operations_records
  FOR EACH ROW
  EXECUTE FUNCTION public.request_commerce_order_notification_dispatch();

DROP TRIGGER IF EXISTS zz_dispatch_commerce_order_created_from_sales_order ON crm.sales_orders;
CREATE TRIGGER zz_dispatch_commerce_order_created_from_sales_order
  AFTER INSERT ON crm.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.request_commerce_order_notification_dispatch();
