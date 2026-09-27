-- A workspace may create up to five additional storefronts alongside its primary storefront.
-- Keep the per-workspace lock so concurrent requests cannot exceed the cap.

CREATE OR REPLACE FUNCTION public.enforce_workspace_additional_storefront_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_existing_storefront_count integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
  THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(7821, hashtext(NEW.workspace_id::text));

  SELECT count(*)
  INTO v_existing_storefront_count
  FROM public.workspace_storefronts AS storefront
  WHERE storefront.workspace_id = NEW.workspace_id
    AND storefront.id IS DISTINCT FROM NEW.id;

  IF v_existing_storefront_count >= 5 THEN
    RAISE EXCEPTION 'A workspace can have no more than five additional storefronts'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
