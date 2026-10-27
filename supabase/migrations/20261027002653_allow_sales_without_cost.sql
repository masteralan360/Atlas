-- Missing product cost must not block a sale. Preserve product/workspace
-- validation, and write zero when no cost snapshot or product cost exists.
CREATE OR REPLACE FUNCTION public.enforce_sale_product_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_workspace_id uuid;
  v_product_name text;
  v_product_cost_price numeric;
BEGIN
  SELECT workspace_id
  INTO v_workspace_id
  FROM public.sales
  WHERE id = NEW.sale_id;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Sale not found for sale item';
  END IF;

  SELECT name, cost_price
  INTO v_product_name, v_product_cost_price
  FROM public.products
  WHERE id = NEW.product_id
    AND workspace_id = v_workspace_id
    AND COALESCE(is_deleted, false) = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found for this workspace';
  END IF;

  NEW.cost_price := COALESCE(NEW.cost_price, v_product_cost_price, 0);
  NEW.converted_cost_price := COALESCE(
    NEW.converted_cost_price,
    CASE
      WHEN lower(NEW.original_currency) = lower(NEW.settlement_currency)
        THEN NEW.cost_price
      ELSE 0
    END,
    0
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_sale_product_cost() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_sale_product_cost() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION crm.enforce_sales_order_product_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, crm
AS $function$
DECLARE
  v_item jsonb;
  v_old_item jsonb;
  v_previous_items jsonb;
  v_previous_partner_id uuid;
  v_normalized_items jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_product_name text;
  v_snapshot_product_name text;
  v_snapshot_product_sku text;
  v_product_cost_price numeric;
  v_item_cost_price numeric;
  v_item_converted_cost_price numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_previous_items := OLD.items;
    v_previous_partner_id := OLD.business_partner_id;
  ELSIF TG_TABLE_SCHEMA = 'crm' AND TG_TABLE_NAME = 'sales_orders' THEN
    SELECT existing_order.items, existing_order.business_partner_id
    INTO v_previous_items, v_previous_partner_id
    FROM crm.sales_orders AS existing_order
    WHERE existing_order.id = NEW.id
      AND existing_order.workspace_id = NEW.workspace_id;
  END IF;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb))
  LOOP
    v_product_id := NULLIF(COALESCE(v_item->>'productId', v_item->>'product_id'), '')::uuid;
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'Sales order contains an invalid product';
    END IF;

    v_old_item := NULL;
    IF v_previous_items IS NOT NULL AND v_item ? 'id' THEN
      SELECT candidate.value INTO v_old_item
      FROM jsonb_array_elements(v_previous_items) AS candidate(value)
      WHERE candidate.value->>'id' = v_item->>'id'
      LIMIT 1;
    END IF;

    IF NEW.business_partner_id IS NOT DISTINCT FROM v_previous_partner_id
      AND v_old_item IS NOT NULL
      AND v_item IS NOT DISTINCT FROM v_old_item
    THEN
      v_item_cost_price := COALESCE(
        NULLIF(v_item->>'costPrice', '')::numeric,
        NULLIF(v_item->>'cost_price', '')::numeric,
        NULLIF(v_item->>'uomCostPrice', '')::numeric,
        NULLIF(v_item->>'uom_cost_price', '')::numeric,
        0
      );
      v_item_converted_cost_price := COALESCE(
        NULLIF(v_item->>'convertedCostPrice', '')::numeric,
        NULLIF(v_item->>'converted_cost_price', '')::numeric,
        NULLIF(v_item->>'convertedUomCostPrice', '')::numeric,
        NULLIF(v_item->>'converted_uom_cost_price', '')::numeric,
        v_item_cost_price
      );
      v_item := v_item || jsonb_build_object(
        'costPrice', v_item_cost_price,
        'convertedCostPrice', v_item_converted_cost_price
      );
      v_normalized_items := v_normalized_items || jsonb_build_array(v_item);
      CONTINUE;
    END IF;

    v_snapshot_product_name := COALESCE(
      NULLIF(v_item->>'productName', ''),
      NULLIF(v_item->>'product_name', ''),
      'Unknown product'
    );
    v_snapshot_product_sku := COALESCE(
      NULLIF(v_item->>'productSku', ''),
      NULLIF(v_item->>'product_sku', ''),
      NULLIF(v_item->>'sku', ''),
      'not recorded'
    );

    SELECT name, cost_price
    INTO v_product_name, v_product_cost_price
    FROM public.products
    WHERE id = v_product_id
      AND workspace_id = NEW.workspace_id
      AND COALESCE(is_deleted, false) = false;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Product "%" (SKU: %, ID: %) is not available in this workspace. Restore it in Products or replace it in the order before continuing.',
        v_snapshot_product_name,
        v_snapshot_product_sku,
        v_product_id;
    END IF;

    v_item_cost_price := COALESCE(
      NULLIF(v_item->>'costPrice', '')::numeric,
      NULLIF(v_item->>'cost_price', '')::numeric,
      NULLIF(v_item->>'uomCostPrice', '')::numeric,
      NULLIF(v_item->>'uom_cost_price', '')::numeric,
      v_product_cost_price,
      0
    );
    v_item_converted_cost_price := COALESCE(
      NULLIF(v_item->>'convertedCostPrice', '')::numeric,
      NULLIF(v_item->>'converted_cost_price', '')::numeric,
      NULLIF(v_item->>'convertedUomCostPrice', '')::numeric,
      NULLIF(v_item->>'converted_uom_cost_price', '')::numeric,
      v_item_cost_price
    );
    v_item := v_item || jsonb_build_object(
      'costPrice', v_item_cost_price,
      'convertedCostPrice', v_item_converted_cost_price
    );
    v_normalized_items := v_normalized_items || jsonb_build_array(v_item);
  END LOOP;

  NEW.items := v_normalized_items;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION crm.enforce_sales_order_product_cost() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.enforce_sales_order_product_cost() TO authenticated, service_role;

-- The atomic Quick Order RPC also had its own product-cost prerequisite. Its
-- batch allocation and fallback cost calculation already resolve missing
-- product costs to zero, so remove only that guard and preserve its other checks.
DO $allow_quick_orders_without_cost$
DECLARE
  function_sql text;
  old_cost_guard constant text := $old_guard$
    IF NOT v_product.is_service AND (v_product.cost_price IS NULL OR v_product.cost_price < 0) THEN
      RAISE EXCEPTION 'Product cost is required before sale'
        USING ERRCODE = '23514';
    END IF;
$old_guard$;
  new_cost_guard constant text :=
    '    -- Missing product and item costs use zero in the fallback snapshot below.';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(quick_order.oid)
  INTO function_sql
  FROM pg_catalog.pg_proc AS quick_order
  WHERE quick_order.oid = 'public.complete_quick_sales_order(jsonb)'::regprocedure;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Atomic Quick Order function was not found';
  END IF;

  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');

  IF pg_catalog.strpos(function_sql, old_cost_guard) = 0 THEN
    IF pg_catalog.strpos(function_sql, 'Product cost is required before sale') = 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Atomic Quick Order cost guard did not match the expected definition';
  END IF;

  IF pg_catalog.strpos(function_sql, 'COALESCE(NULLIF(v_item->>''costPrice'', '''')::numeric / NULLIF(v_unit_factor, 0), v_product.cost_price, 0)') = 0 THEN
    RAISE EXCEPTION 'Atomic Quick Order zero-cost fallback was not found';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_cost_guard, new_cost_guard);

  IF pg_catalog.strpos(function_sql, 'Product cost is required before sale') > 0
    OR pg_catalog.strpos(function_sql, 'Missing product and item costs use zero') = 0
  THEN
    RAISE EXCEPTION 'Atomic Quick Order cost guard removal failed its preservation checks';
  END IF;

  EXECUTE function_sql;
END;
$allow_quick_orders_without_cost$;

NOTIFY pgrst, 'reload schema';
