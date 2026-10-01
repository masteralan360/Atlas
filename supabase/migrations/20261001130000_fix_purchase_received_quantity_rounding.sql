-- Purchase receipt snapshots are the sum of the individually rounded paid
-- and free inventory quantities. Comparing them with one rounded product of
-- the combined commercial quantity can differ by one base-unit micro-step.
DO $patch_purchase_received_quantity_rounding$
DECLARE
  function_sql text;
  old_expression text := 'round(v_received_quantity, 6) IS DISTINCT FROM round(v_quantity * v_factor + v_free_quantity * v_factor, 6)';
  new_expression text := 'round(v_received_quantity, 6) IS DISTINCT FROM round(COALESCE(v_inventory_quantity, round(v_quantity * v_factor, 6)) + v_free_inventory_quantity, 6)';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'private.validate_order_unit_items()'::regprocedure
  ) INTO function_sql;

  IF pg_catalog.strpos(function_sql, new_expression) > 0 THEN
    RETURN;
  END IF;

  IF pg_catalog.strpos(function_sql, old_expression) = 0 THEN
    RAISE EXCEPTION 'Purchase received quantity validation expression was not found';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_expression, new_expression);
  EXECUTE function_sql;
END;
$patch_purchase_received_quantity_rounding$;

NOTIFY pgrst, 'reload schema';
