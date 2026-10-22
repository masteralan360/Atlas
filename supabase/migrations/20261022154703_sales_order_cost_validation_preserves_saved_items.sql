-- Sales Order upserts can revisit a line whose product was archived after the
-- order was saved. Preserve cost/availability validation for new or changed
-- lines, while allowing an exact previously saved line to sync unchanged.
DO $patch_sales_order_cost_history$
DECLARE
  function_sql text;
  old_item_declaration constant text := '  v_item jsonb;';
  new_item_declaration constant text := E'  v_item jsonb;\n  v_old_item jsonb;\n  v_previous_items jsonb;\n  v_previous_partner_id uuid;';
  old_start_marker constant text := E'BEGIN\n  SELECT partner.price_book_id';
  new_start constant text := $new_start$
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

  SELECT partner.price_book_id
$new_start$;
  old_invalid_product_check constant text := $old_invalid$
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'Sales order contains an invalid product';
    END IF;
$old_invalid$;
  new_invalid_product_check constant text := $new_invalid_product_check$
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
      CONTINUE;
    END IF;
$new_invalid_product_check$;
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

  IF pg_catalog.strpos(function_sql, '  v_previous_partner_id uuid;') > 0
    AND pg_catalog.strpos(function_sql, 'jsonb_array_elements(v_previous_items)') > 0
    AND pg_catalog.strpos(function_sql, 'v_item IS NOT DISTINCT FROM v_old_item') > 0
  THEN
    RETURN;
  END IF;

  IF pg_catalog.strpos(function_sql, old_item_declaration) = 0
    OR pg_catalog.strpos(function_sql, old_start_marker) = 0
    OR pg_catalog.strpos(function_sql, old_invalid_product_check) = 0
  THEN
    RAISE EXCEPTION 'Sales Order product cost validator did not match the expected function';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_item_declaration, new_item_declaration);
  function_sql := pg_catalog.replace(function_sql, old_start_marker, new_start);
  function_sql := pg_catalog.replace(function_sql, old_invalid_product_check, new_invalid_product_check);

  IF pg_catalog.strpos(function_sql, 'SECURITY DEFINER') = 0
    OR pg_catalog.strpos(function_sql, 'v_previous_items') = 0
    OR pg_catalog.strpos(function_sql, 'v_item IS NOT DISTINCT FROM v_old_item') = 0
    OR pg_catalog.strpos(function_sql, 'is not available in this workspace.') = 0
  THEN
    RAISE EXCEPTION 'Sales Order product cost validator patch failed its preservation checks';
  END IF;

  EXECUTE function_sql;
END;
$patch_sales_order_cost_history$;

NOTIFY pgrst, 'reload schema';
