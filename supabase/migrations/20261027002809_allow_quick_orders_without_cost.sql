-- Quick Order validation and inventory posting run in the private helper.
-- Preserve product availability checks and batch costing, while allowing the
-- existing zero-cost fallback to handle catalog items without a stored cost.
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
  WHERE quick_order.oid = 'private.complete_quick_sales_order_once(jsonb)'::regprocedure;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Atomic Quick Order helper was not found';
  END IF;

  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');

  IF pg_catalog.strpos(function_sql, old_cost_guard) = 0 THEN
    IF pg_catalog.strpos(function_sql, 'Product cost is required before sale') = 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Atomic Quick Order helper cost guard did not match the expected definition';
  END IF;

  IF pg_catalog.strpos(
    function_sql,
    'v_fallback_original_cost := COALESCE(NULLIF(v_item->>''costPrice'', '''')::numeric / NULLIF(v_unit_factor, 0), v_product.cost_price, 0);'
  ) = 0 THEN
    RAISE EXCEPTION 'Atomic Quick Order helper zero-cost fallback was not found';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_cost_guard, new_cost_guard);

  IF pg_catalog.strpos(function_sql, 'Product cost is required before sale') > 0
    OR pg_catalog.strpos(function_sql, 'Missing product and item costs use zero') = 0
  THEN
    RAISE EXCEPTION 'Atomic Quick Order helper cost guard removal failed its preservation checks';
  END IF;

  EXECUTE function_sql;
END;
$allow_quick_orders_without_cost$;

NOTIFY pgrst, 'reload schema';
