-- E-commerce orders must be fulfillable even when a catalog item has no cost
-- recorded yet. Keep product availability checks, but skip both product and
-- assigned Price Book cost requirements for marketplace sourced sales orders.
DO $allow_marketplace_orders_without_cost$
DECLARE
  function_sql text;
  old_variable_declaration constant text := '  v_price_book_cost numeric;';
  new_variable_declaration constant text := E'  v_price_book_cost numeric;\n  v_is_marketplace_order boolean := false;';
  old_begin_marker constant text := E'BEGIN\n  IF TG_OP = ''UPDATE'' THEN';
  new_begin_marker constant text := $new_begin_marker$
BEGIN
  v_is_marketplace_order := NEW.source_channel = 'marketplace'
    AND NEW.marketplace_order_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.marketplace_orders AS marketplace_order
      WHERE marketplace_order.id = NEW.marketplace_order_id
        AND marketplace_order.workspace_id = NEW.workspace_id
    );

  IF TG_OP = 'UPDATE' THEN$new_begin_marker$;
  old_product_cost_guard constant text :=
    '    IF NOT v_is_service AND (v_cost_price IS NULL OR v_cost_price < 0) THEN';
  new_product_cost_guard constant text :=
    '    IF NOT v_is_marketplace_order AND NOT v_is_service AND (v_cost_price IS NULL OR v_cost_price < 0) THEN';
  old_price_book_guard constant text :=
    '    IF NOT v_is_service AND v_partner_price_book_id IS NOT NULL THEN';
  new_price_book_guard constant text :=
    '    IF NOT v_is_marketplace_order AND NOT v_is_service AND v_partner_price_book_id IS NOT NULL THEN';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(validation_proc.oid)
  INTO function_sql
  FROM pg_catalog.pg_proc AS validation_proc
  WHERE validation_proc.oid = 'crm.enforce_sales_order_product_cost()'::regprocedure;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Sales Order product cost validator was not found';
  END IF;

  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');

  IF pg_catalog.strpos(function_sql, new_variable_declaration) > 0
    AND pg_catalog.strpos(function_sql, new_begin_marker) > 0
    AND pg_catalog.strpos(function_sql, new_product_cost_guard) > 0
    AND pg_catalog.strpos(function_sql, new_price_book_guard) > 0
  THEN
    RETURN;
  END IF;

  IF pg_catalog.strpos(function_sql, old_product_cost_guard) = 0
    OR pg_catalog.strpos(function_sql, old_price_book_guard) = 0
    OR pg_catalog.strpos(function_sql, old_variable_declaration) = 0
    OR pg_catalog.strpos(function_sql, old_begin_marker) = 0
    OR pg_catalog.strpos(function_sql, 'v_previous_items') = 0
    OR pg_catalog.strpos(function_sql, 'is not available in this workspace.') = 0
  THEN
    RAISE EXCEPTION 'Sales Order product cost validator did not match the expected current definition';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_variable_declaration, new_variable_declaration);
  function_sql := pg_catalog.replace(function_sql, old_begin_marker, new_begin_marker);
  function_sql := pg_catalog.replace(function_sql, old_product_cost_guard, new_product_cost_guard);
  function_sql := pg_catalog.replace(function_sql, old_price_book_guard, new_price_book_guard);

  IF pg_catalog.strpos(function_sql, new_variable_declaration) = 0
    OR pg_catalog.strpos(function_sql, 'marketplace_order.workspace_id = NEW.workspace_id') = 0
    OR pg_catalog.strpos(function_sql, new_product_cost_guard) = 0
    OR pg_catalog.strpos(function_sql, new_price_book_guard) = 0
    OR pg_catalog.strpos(function_sql, 'v_previous_items') = 0
    OR pg_catalog.strpos(function_sql, 'is not available in this workspace.') = 0
  THEN
    RAISE EXCEPTION 'Marketplace cost exemption patch failed its preservation checks';
  END IF;

  EXECUTE function_sql;
END;
$allow_marketplace_orders_without_cost$;

NOTIFY pgrst, 'reload schema';
