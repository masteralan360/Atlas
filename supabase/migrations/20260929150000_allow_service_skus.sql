-- Services may carry an optional SKU for catalog search and POS barcode
-- lookup. They remain stockless and cannot participate in product variants.

CREATE OR REPLACE FUNCTION public.prevent_duplicate_workspace_product_sku()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_sku_key text;
BEGIN
  IF NEW.is_deleted = true OR NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_sku_key := lower(btrim(NEW.sku));
  IF v_sku_key IS NULL OR v_sku_key = '' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.workspace_id::text || ':' || v_sku_key));

  IF EXISTS (
    SELECT 1
    FROM public.products AS product
    WHERE product.workspace_id = NEW.workspace_id
      AND product.id <> NEW.id
      AND product.is_deleted = false
      AND lower(btrim(product.sku)) = v_sku_key
      AND NOT (
        (NEW.parent_product_id IS NOT NULL AND (
          product.id = NEW.parent_product_id
          OR product.parent_product_id = NEW.parent_product_id
        ))
        OR (
          NEW.parent_product_id IS NULL
          AND product.parent_product_id = NEW.id
        )
      )
  ) THEN
    RAISE EXCEPTION 'This SKU is already used by another product group. It may only be shared by a parent product and its direct variants.'
      USING ERRCODE = '23505',
            CONSTRAINT = 'products_workspace_sku_active_unique';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_service_product_invariants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF COALESCE(NEW.is_service, false) THEN
    IF NOT public.services_module_allowed(NEW.workspace_id) THEN
      RAISE EXCEPTION 'Services feature is not enabled for this workspace'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.parent_product_id IS NOT NULL THEN
      RAISE EXCEPTION 'Services cannot be variant parents or variants.';
    END IF;

    IF TG_OP = 'UPDATE' AND NOT COALESCE(OLD.is_service, false) AND EXISTS (
      SELECT 1
      FROM public.inventory AS i
      WHERE i.workspace_id = NEW.workspace_id
        AND i.product_id = NEW.id
        AND NOT COALESCE(i.is_deleted, false)
    ) THEN
      RAISE EXCEPTION 'A stocked product cannot be converted into a service.' USING ERRCODE = '23514';
    END IF;

    NEW.unit := NULL;
    NEW.quantity := NULL;
    NEW.min_stock_level := NULL;
    NEW.storage_id := NULL;
  ELSIF TG_OP = 'UPDATE' AND COALESCE(OLD.is_service, false) AND NOT COALESCE(NEW.is_service, false) THEN
    RAISE EXCEPTION 'Services cannot be converted into inventory products.' USING ERRCODE = '23514';
  ELSIF TG_OP = 'UPDATE' AND COALESCE(OLD.is_service, false) AND NOT public.services_module_allowed(OLD.workspace_id) THEN
    RAISE EXCEPTION 'Services feature is not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
