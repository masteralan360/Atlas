-- PostgREST upserts run the INSERT trigger before resolving ON CONFLICT.
-- For an existing Sales Order, reuse its prior line snapshots during that
-- trigger so unchanged historical lines do not need a product/UoM that may
-- have since been archived. Changed/new lines still pass the normal checks.
DO $patch_sales_order_upsert_history$
DECLARE
  function_sql text;
  function_is_security_definer boolean;
  old_declaration constant text := '  v_old_item jsonb;';
  new_declaration constant text := E'  v_old_item jsonb;\n  v_previous_items jsonb;\n  v_previous_status text;';
  old_context_marker constant text := '  v_result := ''[]''::jsonb;';
  new_context constant text := $new_context$
  IF TG_OP = 'UPDATE' THEN
    v_previous_items := OLD.items;
    v_previous_status := OLD.status;
  ELSIF TG_TABLE_SCHEMA = 'crm' AND TG_TABLE_NAME = 'sales_orders' THEN
    SELECT existing_order.items, existing_order.status
    INTO v_previous_items, v_previous_status
    FROM crm.sales_orders AS existing_order
    WHERE existing_order.id = NEW.id
      AND existing_order.workspace_id = NEW.workspace_id;
  END IF;

  v_result := '[]'::jsonb;
$new_context$;
  old_item_lookup constant text := $old_item_lookup$
    IF TG_OP = 'UPDATE' AND OLD.items IS NOT NULL AND v_item ? 'id' THEN
      SELECT candidate.value INTO v_old_item
      FROM jsonb_array_elements(OLD.items) AS candidate(value)
      WHERE candidate.value->>'id' = v_item->>'id'
      LIMIT 1;
    END IF;
$old_item_lookup$;
  new_item_lookup constant text := $new_item_lookup$
    IF v_previous_items IS NOT NULL AND v_item ? 'id' THEN
      SELECT candidate.value INTO v_old_item
      FROM jsonb_array_elements(v_previous_items) AS candidate(value)
      WHERE candidate.value->>'id' = v_item->>'id'
      LIMIT 1;
    END IF;
$new_item_lookup$;
  old_unchanged_check constant text := 'IF TG_OP = ''UPDATE'' AND v_old_item IS NOT NULL AND v_new_snapshot IS NOT DISTINCT FROM v_old_snapshot THEN';
  new_unchanged_check constant text := 'IF v_old_item IS NOT NULL AND v_new_snapshot IS NOT DISTINCT FROM v_old_snapshot THEN';
  old_status_check constant text := 'IF TG_OP = ''UPDATE'' AND OLD.status IS DISTINCT FROM ''draft'' AND v_old_item IS NOT NULL THEN';
  new_status_check constant text := 'IF v_previous_status IS DISTINCT FROM ''draft'' AND v_old_item IS NOT NULL THEN';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(validation_proc.oid), validation_proc.prosecdef
  INTO function_sql, function_is_security_definer
  FROM pg_catalog.pg_proc AS validation_proc
  WHERE validation_proc.oid = 'private.validate_order_unit_items()'::regprocedure;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Order item UoM validation function was not found';
  END IF;
  IF function_is_security_definer THEN
    RAISE EXCEPTION 'Order item UoM validator must remain SECURITY INVOKER';
  END IF;

  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');

  IF pg_catalog.strpos(function_sql, '  v_previous_items jsonb;') > 0
    AND pg_catalog.strpos(function_sql, 'ELSIF TG_TABLE_SCHEMA = ''crm'' AND TG_TABLE_NAME = ''sales_orders'' THEN') > 0
    AND pg_catalog.strpos(function_sql, 'jsonb_array_elements(v_previous_items)') > 0
    AND pg_catalog.strpos(function_sql, new_unchanged_check) > 0
    AND pg_catalog.strpos(function_sql, new_status_check) > 0
  THEN
    RETURN;
  END IF;

  IF pg_catalog.strpos(function_sql, old_declaration) = 0
    OR pg_catalog.strpos(function_sql, old_context_marker) = 0
    OR pg_catalog.strpos(function_sql, old_item_lookup) = 0
    OR pg_catalog.strpos(function_sql, old_unchanged_check) = 0
    OR pg_catalog.strpos(function_sql, old_status_check) = 0
  THEN
    RAISE EXCEPTION 'Order item validator did not match the expected invoker function';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_declaration, new_declaration);
  function_sql := pg_catalog.replace(function_sql, old_context_marker, new_context);
  function_sql := pg_catalog.replace(function_sql, old_item_lookup, new_item_lookup);
  function_sql := pg_catalog.replace(function_sql, old_unchanged_check, new_unchanged_check);
  function_sql := pg_catalog.replace(function_sql, old_status_check, new_status_check);

  IF function_is_security_definer
    OR pg_catalog.strpos(function_sql, 'get_visible_products_for_current_user') = 0
    OR pg_catalog.strpos(function_sql, 'can_access_service') = 0
    OR pg_catalog.strpos(function_sql, 'v_previous_items') = 0
    OR pg_catalog.strpos(function_sql, old_item_lookup) > 0
  THEN
    RAISE EXCEPTION 'Sales Order upsert validator patch failed its security/source checks';
  END IF;

  EXECUTE function_sql;
END;
$patch_sales_order_upsert_history$;

NOTIFY pgrst, 'reload schema';
