ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.enforce_sales_archive_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_archived, false) THEN
      RAISE EXCEPTION 'sale_archive_requires_existing_sale'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.is_archived IS NOT DISTINCT FROM NEW.is_archived THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'is_archived') IS DISTINCT FROM (to_jsonb(OLD) - 'is_archived') THEN
    RAISE EXCEPTION 'sale_archive_must_not_change_sale_data'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.is_archived
    AND NOT COALESCE(NEW.is_returned, false)
    AND lower(COALESCE(NEW.return_status, '')) <> 'full' THEN
    RAISE EXCEPTION 'sale_archive_not_allowed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sales_archive_guard ON public.sales;
CREATE TRIGGER sales_archive_guard
  BEFORE INSERT OR UPDATE OF is_archived ON public.sales
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_sales_archive_rules();

COMMENT ON COLUMN public.sales.is_archived IS
  'Hides a fully returned sale from normal sales history and analytics without deleting its records.';

NOTIFY pgrst, 'reload schema';
