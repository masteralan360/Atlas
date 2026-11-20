-- Allow item/UoM edits on pending unpaid Sales Orders through the existing
-- order save paths. The stock-reservation trigger still validates every new
-- requirement atomically. Financed orders receive the exception only inside
-- update_pending_financed_sales_order after that RPC validates the linked
-- Loan/Installment aggregate and payment history.
DO $patch_order_item_validator$
DECLARE
  function_sql text;
  function_is_security_definer boolean;
  old_declaration constant text := '  v_previous_status text;';
  new_declaration constant text := E'  v_previous_status text;\n  v_previous_order jsonb;';
  old_context constant text := $old_context$
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
$old_context$;
  new_context constant text := $new_context$
  IF TG_OP = 'UPDATE' THEN
    v_previous_items := OLD.items;
    v_previous_status := OLD.status;
    v_previous_order := to_jsonb(OLD);
  ELSIF TG_TABLE_SCHEMA = 'crm' AND TG_TABLE_NAME = 'sales_orders' THEN
    SELECT existing_order.items, existing_order.status, to_jsonb(existing_order)
    INTO v_previous_items, v_previous_status, v_previous_order
    FROM crm.sales_orders AS existing_order
    WHERE existing_order.id = NEW.id
      AND existing_order.workspace_id = NEW.workspace_id;
  END IF;
$new_context$;
  old_guard constant text := 'IF v_previous_status IS DISTINCT FROM ''draft'' AND v_old_item IS NOT NULL THEN';
  new_guard constant text := $guard$
    IF v_previous_status IS DISTINCT FROM 'draft'
      AND v_old_item IS NOT NULL
      AND NOT (
        TG_TABLE_SCHEMA = 'crm'
        AND TG_TABLE_NAME = 'sales_orders'
        AND v_previous_status = 'pending'
        AND NOT COALESCE((v_previous_order->>'is_deleted')::boolean, false)
        AND NOT COALESCE((v_previous_order->>'is_paid')::boolean, false)
        AND COALESCE(v_previous_order->>'payment_status', 'unpaid') = 'unpaid'
        AND COALESCE(NULLIF(v_previous_order->>'paid_amount', '')::numeric, 0) <= 0.0005
        AND COALESCE(NULLIF(v_previous_order->>'initial_payment_amount', '')::numeric, 0) <= 0.0005
        AND COALESCE(
          NULLIF(v_previous_order->>'balance_amount', '')::numeric,
          NULLIF(v_previous_order->>'total', '')::numeric,
          0
        ) >= COALESCE(NULLIF(v_previous_order->>'total', '')::numeric, 0) - 0.0005
        AND (
          (
            COALESCE(v_previous_order->>'payment_method', '') NOT IN ('loan', 'installments')
            AND NULLIF(v_previous_order->>'linked_loan_id', '') IS NULL
          )
          OR (
            COALESCE(v_previous_order->>'payment_method', '') IN ('loan', 'installments')
            AND NULLIF(v_previous_order->>'linked_loan_id', '') IS NOT NULL
            AND COALESCE(
              current_setting('atlas.pending_financed_order_edit_order_id', true)
                = v_previous_order->>'id',
              false
            )
          )
        )
      )
    THEN
$guard$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(validation_proc.oid), validation_proc.prosecdef
  INTO function_sql, function_is_security_definer
  FROM pg_catalog.pg_proc AS validation_proc
  WHERE validation_proc.oid = 'private.validate_order_unit_items()'::regprocedure;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Order item UoM validator was not found';
  END IF;
  IF function_is_security_definer THEN
    RAISE EXCEPTION 'Order item UoM validator must remain SECURITY INVOKER';
  END IF;

  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');

  IF pg_catalog.strpos(function_sql, '  v_previous_order jsonb;') > 0
    AND pg_catalog.strpos(function_sql, 'v_previous_order := to_jsonb(OLD);') > 0
    AND pg_catalog.strpos(function_sql, 'atlas.pending_financed_order_edit_order_id') > 0
  THEN
    RETURN;
  END IF;
  IF pg_catalog.strpos(function_sql, old_declaration) = 0
    OR pg_catalog.strpos(function_sql, old_context) = 0
    OR pg_catalog.strpos(function_sql, old_guard) = 0
  THEN
    RAISE EXCEPTION 'Order item UoM validator did not match the expected source';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_declaration, new_declaration);
  function_sql := pg_catalog.replace(function_sql, old_context, new_context);
  function_sql := pg_catalog.replace(function_sql, old_guard, new_guard);

  IF function_is_security_definer
    OR pg_catalog.strpos(function_sql, 'v_previous_order := to_jsonb(OLD);') = 0
    OR pg_catalog.strpos(function_sql, 'atlas.pending_financed_order_edit_order_id') = 0
  THEN
    RAISE EXCEPTION 'Pending Sales Order UoM edit guard patch failed';
  END IF;
  EXECUTE function_sql;
END;
$patch_order_item_validator$;

-- The custom transaction-local flag is set only after this SECURITY DEFINER
-- RPC has validated the order, loan, unpaid state, versions, and installments.
DO $patch_financed_order_update$
DECLARE
  function_sql text;
  old_marker constant text := E'  UPDATE crm.sales_orders\n  SET items = p_order->''items'',';
  new_marker constant text := E'  PERFORM pg_catalog.set_config(\n    ''atlas.pending_financed_order_edit_order_id'', p_order_id::text, true\n  );\n\n  UPDATE crm.sales_orders\n  SET items = p_order->''items'',';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(routine.oid)
  INTO function_sql
  FROM pg_catalog.pg_proc AS routine
  WHERE routine.oid = 'public.update_pending_financed_sales_order(uuid,uuid,bigint,bigint,uuid,jsonb,uuid[])'::regprocedure;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Pending financed Sales Order update RPC was not found';
  END IF;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');
  IF pg_catalog.strpos(function_sql, 'atlas.pending_financed_order_edit_order_id') > 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.strpos(function_sql, old_marker) = 0 THEN
    RAISE EXCEPTION 'Pending financed Sales Order update marker was not found';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_marker, new_marker);
  IF pg_catalog.strpos(function_sql, 'atlas.pending_financed_order_edit_order_id') = 0 THEN
    RAISE EXCEPTION 'Pending financed Sales Order edit authorization patch failed';
  END IF;
  EXECUTE function_sql;
END;
$patch_financed_order_update$;

NOTIFY pgrst, 'reload schema';
