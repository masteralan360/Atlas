ALTER TABLE public.marketplace_orders
  ADD COLUMN IF NOT EXISTS shipped_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shipped_by_name text NULL;

COMMENT ON COLUMN public.marketplace_orders.shipped_by
  IS 'Authenticated Atlas user who marked the marketplace order as shipped';
COMMENT ON COLUMN public.marketplace_orders.shipped_by_name
  IS 'Shipping actor name snapshot captured when the marketplace order was marked shipped';

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_shipped_by
  ON public.marketplace_orders (workspace_id, shipped_by)
  WHERE shipped_by IS NOT NULL AND COALESCE(is_deleted, false) = false;

ALTER TABLE crm.sales_order_agent_assignments
  DROP CONSTRAINT IF EXISTS sales_order_agent_assignments_source_check,
  ADD CONSTRAINT sales_order_agent_assignments_source_check
    CHECK (
      assignment_source IN (
        'manual',
        'sales_account',
        'order_creator_product',
        'marketplace_delivery_product',
        'marketplace_shipping_product'
      )
    );

COMMENT ON COLUMN crm.sales_order_agent_assignments.assignment_source IS
  'manual is user-selected, sales_account follows the selected agent account, order_creator_product is product-only attribution derived from the sale creator, marketplace_delivery_product is legacy delivery attribution, and marketplace_shipping_product is product-only attribution derived from the marketplace shipping actor.';

DO $shipping_commissions$
DECLARE
  v_definition text;
  v_replaced text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'private.ensure_marketplace_delivery_product_commission_assignment(uuid)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL
    OR position('v_marketplace_order.delivered_by' IN v_definition) = 0
    OR position('v_marketplace_order.delivered_at' IN v_definition) = 0
    OR position('marketplace_delivery_product' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Expected marketplace delivery commission helper is not installed';
  END IF;

  v_replaced := replace(
    v_definition,
    'private.ensure_marketplace_delivery_product_commission_assignment',
    'private.ensure_marketplace_shipping_product_commission_assignment'
  );
  v_replaced := replace(v_replaced, 'marketplace_delivery_product', 'marketplace_shipping_product');
  v_replaced := replace(v_replaced, 'v_marketplace_order.delivered_by', 'v_marketplace_order.shipped_by');
  v_replaced := replace(v_replaced, 'v_marketplace_order.delivered_at', 'v_marketplace_order.shipped_at');
  v_replaced := replace(
    v_replaced,
    'v_marketplace_order.status <> ''delivered''',
    'v_marketplace_order.status NOT IN (''shipped'', ''delivered'')'
  );
  v_replaced := replace(
    v_replaced,
    'field agent who delivered the marketplace order',
    'field agent who shipped the marketplace order'
  );

  IF position('marketplace_shipping_product' IN v_replaced) = 0
    OR position('v_marketplace_order.shipped_by' IN v_replaced) = 0
    OR position('v_marketplace_order.shipped_at' IN v_replaced) = 0
  THEN
    RAISE EXCEPTION 'Marketplace shipping commission helper could not be derived';
  END IF;

  EXECUTE v_replaced;
  EXECUTE 'REVOKE ALL ON FUNCTION private.ensure_marketplace_shipping_product_commission_assignment(uuid) FROM PUBLIC';

  -- Legacy delivered orders continue to use their existing delivery
  -- attribution. New shipped orders are handled by the shipping helper.
  SELECT pg_get_functiondef(
    'private.ensure_marketplace_delivery_product_commission_assignment(uuid)'::regprocedure
  ) INTO v_definition;
  v_old := $old$OR v_marketplace_order.status <> 'delivered'
    OR v_marketplace_order.delivered_by IS NULL$old$;
  v_new := $new$OR v_marketplace_order.status <> 'delivered'
    OR v_marketplace_order.shipped_by IS NOT NULL
    OR v_marketplace_order.delivered_by IS NULL$new$;
  IF position(v_new IN v_definition) = 0 THEN
    v_replaced := replace(v_definition, v_old, v_new);
    IF v_replaced IS NOT DISTINCT FROM v_definition THEN
      RAISE EXCEPTION 'Legacy marketplace delivery commission helper could not be isolated from shipped orders';
    END IF;
    EXECUTE v_replaced;
  END IF;

  -- Both server-derived assignment sources remain protected by the database
  -- guard. The shipping helper uses the same transaction-local guard as the
  -- original delivery helper.
  SELECT pg_get_functiondef(
    'private.enforce_sales_order_agent_assignment_row()'::regprocedure
  ) INTO v_definition;
  -- pg_get_functiondef may return different line endings or indentation across
  -- environments, so match the protected condition by its SQL tokens.
  v_definition := replace(v_definition, chr(13), '');
  IF position('marketplace_shipping_product' IN v_definition) = 0 THEN
    v_replaced := regexp_replace(
      v_definition,
      $pattern$NEW\.assignment_source[[:space:]]*=[[:space:]]*'marketplace_delivery_product'[[:space:]]+AND[[:space:]]+current_setting\('atlas\.ensuring_marketplace_delivery_product_commission',[[:space:]]*true\)[[:space:]]+IS[[:space:]]+DISTINCT[[:space:]]+FROM[[:space:]]+'on'$pattern$,
      $replacement$NEW.assignment_source = 'marketplace_delivery_product'
    AND current_setting('atlas.ensuring_marketplace_delivery_product_commission', true) IS DISTINCT FROM 'on'
    OR NEW.assignment_source = 'marketplace_shipping_product'
    AND current_setting('atlas.ensuring_marketplace_shipping_product_commission', true) IS DISTINCT FROM 'on'$replacement$
    );
    IF v_replaced IS NOT DISTINCT FROM v_definition THEN
      RAISE EXCEPTION 'Marketplace shipping commission assignment guard could not be updated';
    END IF;
    EXECUTE v_replaced;
  END IF;

  SELECT pg_get_functiondef(
    'public.reconcile_sales_agent_commission_core(uuid, uuid)'::regprocedure
  ) INTO v_definition;
  IF position('marketplace_shipping_product' IN v_definition) = 0 THEN
    v_old := $old$'marketplace_delivery_product')$old$;
    v_new := $new$'marketplace_delivery_product', 'marketplace_shipping_product')$new$;
    v_replaced := replace(v_definition, v_old, v_new);
    IF v_replaced IS NOT DISTINCT FROM v_definition THEN
      RAISE EXCEPTION 'Shipping product assignments could not be excluded from normal-plan commission reconciliation';
    END IF;
    EXECUTE v_replaced;
  END IF;

  -- Product commission rules for a shipment-derived assignment are evaluated
  -- at the shipment event, even when the order is collected or delivered later.
  SELECT pg_get_functiondef(
    'private.reconcile_product_sales_agent_commission(uuid, uuid)'::regprocedure
  ) INTO v_definition;
  IF position('assignment_source = ''marketplace_shipping_product''' IN v_definition) = 0 THEN
    v_old := $old$v_event_at := GREATEST(v_assignment.assigned_at, COALESCE(v_order.actual_delivery_date, v_order.paid_at, v_order.updated_at));$old$;
    v_new := $new$v_event_at := CASE
      WHEN v_assignment.assignment_source = 'marketplace_shipping_product'
        THEN v_assignment.assigned_at
      ELSE GREATEST(v_assignment.assigned_at, COALESCE(v_order.actual_delivery_date, v_order.paid_at, v_order.updated_at))
    END;$new$;
    v_replaced := replace(v_definition, v_old, v_new);
    IF v_replaced IS NOT DISTINCT FROM v_definition THEN
      RAISE EXCEPTION 'Marketplace shipping commission event time could not be anchored to shipment';
    END IF;
    EXECUTE v_replaced;
  END IF;

  SELECT pg_get_functiondef(
    'public.reconcile_sales_agent_commission(uuid, uuid)'::regprocedure
  ) INTO v_definition;
  IF position('private.ensure_marketplace_shipping_product_commission_assignment' IN v_definition) = 0 THEN
    v_old := $old$  v_changed := v_changed + private.ensure_order_creator_product_commission_assignment(p_order_id);$old$;
    v_new := $new$  v_changed := v_changed + private.ensure_marketplace_shipping_product_commission_assignment(p_order_id);
  v_changed := v_changed + private.ensure_order_creator_product_commission_assignment(p_order_id);$new$;
    v_replaced := replace(v_definition, v_old, v_new);
    IF v_replaced IS NOT DISTINCT FROM v_definition THEN
      RAISE EXCEPTION 'Shipping product commission reconciliation could not be registered';
    END IF;
    EXECUTE v_replaced;
  END IF;
END;
$shipping_commissions$;

DO $transition$
DECLARE
  v_definition text;
  v_updated text;
  v_work_block text;
  v_delivery_actor_block text;
  v_commission_block text;
  v_shipping_branch text;
  v_delivery_branch text;
  v_shipping_marker text := $marker$  IF v_next_status = 'shipped' THEN$marker$;
  v_cancel_marker text := $marker$  IF v_next_status = 'cancelled' THEN$marker$;
  v_inventory_marker text := $marker$  IF NOT COALESCE(v_order.inventory_deducted, false) THEN$marker$;
  v_delivery_actor_marker text := $marker$  SELECT COALESCE(
    NULLIF(trim(p.name), ''),
    NULLIF(trim(u.email), ''),
    'Unknown'
  )
  INTO v_delivery_actor_name$marker$;
  v_delivery_update_marker text := $marker$  UPDATE public.marketplace_orders
  SET
    status = 'delivered',$marker$;
  v_delivery_return_marker text := $marker$  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'status', 'delivered',$marker$;
  v_shipping_start integer;
  v_cancel_start integer;
  v_inventory_start integer;
  v_delivery_actor_start integer;
  v_delivery_actor_end integer;
  v_delivery_update_start integer;
  v_delivery_return_start integer;
  v_commission_start integer;
  v_function_end integer;
  -- pg_get_functiondef ends at $function$ without the SQL statement semicolon.
  v_function_end_marker text := E'END;\n$function$';
  v_terminal_idempotency text := $idempotent$
  IF v_order.status = 'shipped' AND v_next_status = 'shipped' THEN
    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'shipped',
      'inventory_deducted', COALESCE(v_order.inventory_deducted, false),
      'sales_order_id', v_order.sales_order_id,
      'customer_id', v_order.customer_id,
      'business_partner_id', v_order.business_partner_id,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

$idempotent$;
  v_idempotency_anchor text := $marker$  IF v_order.status IN ('delivered', 'cancelled') THEN$marker$;
BEGIN
  SELECT pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  ) INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');
  -- Normalize the multiline source markers too; otherwise CRLF in this
  -- migration file will not match the LF-normalized pg_get_functiondef text.
  v_delivery_actor_marker := replace(v_delivery_actor_marker, chr(13), '');
  v_delivery_update_marker := replace(v_delivery_update_marker, chr(13), '');
  v_delivery_return_marker := replace(v_delivery_return_marker, chr(13), '');
  v_terminal_idempotency := replace(v_terminal_idempotency, chr(13), '');

  IF v_definition IS NULL
    OR position('INSERT INTO crm.sales_orders (' IN v_definition) = 0
    OR position('v_delivery_actor_id uuid := auth.uid();' IN v_definition) = 0
    OR position('reconcile_sales_agent_commission(v_sales_order_id, NULL)' IN v_definition) = 0
    OR position(v_inventory_marker IN v_definition) = 0
    OR position(v_delivery_update_marker IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Expected marketplace delivery procedure revision is not installed';
  END IF;

  IF position('v_shipped_actor_id uuid := auth.uid();' IN v_definition) > 0
    AND position(E'status = ''shipped'',\n      shipped_at' IN v_definition) > 0
    AND position(E'status = ''delivered'',\n    delivered_at' IN v_definition) > 0
  THEN
    RETURN;
  END IF;

  v_updated := replace(
    v_definition,
    '  v_delivery_actor_id uuid := auth.uid();',
    E'  v_delivery_actor_id uuid := auth.uid();\n  v_shipped_actor_id uuid := auth.uid();\n  v_shipped_actor_name text;\n  v_shipment_timestamp timestamp with time zone := timezone(''utc'', now());\n  v_create_sales_order boolean := false;'
  );
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Marketplace shipping actor fields could not be added to the transition procedure';
  END IF;
  v_definition := v_updated;

  v_updated := replace(v_definition, v_idempotency_anchor, v_terminal_idempotency || v_idempotency_anchor);
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Marketplace shipment retry handling could not be added';
  END IF;
  v_definition := v_updated;

  v_shipping_start := strpos(v_definition, v_shipping_marker);
  v_cancel_start := strpos(substring(v_definition FROM v_shipping_start), v_cancel_marker) + v_shipping_start - 1;
  v_inventory_start := strpos(v_definition, v_inventory_marker);
  v_delivery_actor_start := strpos(v_definition, v_delivery_actor_marker);
  v_delivery_update_start := strpos(v_definition, v_delivery_update_marker);
  v_delivery_return_start := strpos(v_definition, v_delivery_return_marker);
  v_commission_start := strpos(v_definition, '  IF v_sales_order_id IS NOT NULL');
  v_function_end := length(v_definition)
    - strpos(reverse(v_definition), reverse(v_function_end_marker))
    - length(v_function_end_marker) + 2;

  IF v_shipping_start = 0 OR v_cancel_start <= v_shipping_start
    OR v_inventory_start = 0 OR v_delivery_actor_start = 0
    OR v_delivery_update_start <= v_inventory_start
    OR v_delivery_return_start <= v_delivery_update_start
    OR v_commission_start <= v_delivery_update_start
    OR v_function_end <= v_delivery_return_start
  THEN
    RAISE EXCEPTION 'Marketplace delivery procedure has an unsupported transition layout';
  END IF;

  v_work_block := substring(v_definition FROM v_inventory_start FOR v_delivery_update_start - v_inventory_start);
  v_work_block := replace(v_work_block, 'v_delivery_actor_id', 'v_shipped_actor_id');
  v_work_block := replace(v_work_block, 'v_delivery_timestamp', 'v_shipment_timestamp');
  v_work_block := replace(v_work_block, 'after delivery', 'after shipment');

  -- Allocate the CRM Sales Order id before touching stock so the inventory
  -- audit trigger can attach every shipment movement to that exact order.
  v_updated := replace(
    v_work_block,
    v_inventory_marker,
    E'  v_sales_order_id := v_order.sales_order_id;\n'
      || E'  v_create_sales_order := v_sales_order_id IS NULL;\n'
      || E'  IF v_create_sales_order THEN\n'
      || E'    v_sales_order_id := gen_random_uuid();\n'
      || E'  END IF;\n\n'
      || v_inventory_marker
  );
  IF v_updated IS NOT DISTINCT FROM v_work_block THEN
    RAISE EXCEPTION 'Marketplace shipment Sales Order id could not be prepared before inventory deduction';
  END IF;
  v_work_block := v_updated;

  v_updated := replace(
    v_work_block,
    'UPDATE public.inventory',
    E'      PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''sale'', true);\n'
      || E'      PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', v_sales_order_id::text, true);\n'
      || E'      PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', ''sales_order'', true);\n'
      || E'      PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(v_shipped_actor_id::text, ''''), true);\n'
      || 'UPDATE public.inventory'
  );
  IF v_updated IS NOT DISTINCT FROM v_work_block THEN
    RAISE EXCEPTION 'Marketplace shipment inventory audit context could not be added';
  END IF;
  v_work_block := v_updated;

  v_updated := replace(
    v_work_block,
    E'  v_sales_order_id := v_order.sales_order_id;\n\n  IF v_sales_order_id IS NULL THEN',
    E'  v_sales_order_id := COALESCE(v_order.sales_order_id, v_sales_order_id);\n\n  IF v_create_sales_order THEN'
  );
  IF v_updated IS NOT DISTINCT FROM v_work_block THEN
    RAISE EXCEPTION 'Marketplace shipment Sales Order creation guard could not be updated';
  END IF;
  v_work_block := v_updated;

  v_updated := replace(
    v_work_block,
    E'    INSERT INTO crm.sales_orders (\n      order_number,',
    E'    INSERT INTO crm.sales_orders (\n      id,\n      order_number,'
  );
  IF v_updated IS NOT DISTINCT FROM v_work_block THEN
    RAISE EXCEPTION 'Marketplace Sales Order id could not be included in the insert';
  END IF;
  v_work_block := v_updated;

  v_updated := replace(
    v_work_block,
    E'    VALUES (\n      '''',\n      v_order.workspace_id,',
    E'    VALUES (\n      v_sales_order_id,\n      '''',\n      v_order.workspace_id,'
  );
  IF v_updated IS NOT DISTINCT FROM v_work_block THEN
    RAISE EXCEPTION 'Marketplace Sales Order id could not be used in the insert';
  END IF;
  v_work_block := v_updated;

  v_work_block := replace(
    v_work_block,
    E'      v_order.shipped_at,\n      v_shipment_timestamp,\n      false,',
    E'      v_order.shipped_at,\n      NULL,\n      false,'
  );
  -- The CRM Sales Order is materialized at shipment, so its created_at must
  -- reflect the shipment timestamp rather than the marketplace order date.
  IF position(
    E'      v_order.id,\n      v_shipped_actor_id,\n      v_shipment_timestamp,\n      v_shipment_timestamp,\n      ''synced'','
    IN v_work_block
  ) = 0 THEN
    v_updated := replace(
      v_work_block,
      E'      v_order.id,\n      v_shipped_actor_id,\n      v_order.created_at,\n      v_shipment_timestamp,\n      ''synced'',',
      E'      v_order.id,\n      v_shipped_actor_id,\n      v_shipment_timestamp,\n      v_shipment_timestamp,\n      ''synced'','
    );
    IF v_updated IS NOT DISTINCT FROM v_work_block THEN
      RAISE EXCEPTION 'Marketplace Sales Order creation date could not be anchored to shipment';
    END IF;
    v_work_block := v_updated;
  END IF;

  v_delivery_actor_end := strpos(
    substring(v_definition FROM v_delivery_actor_start),
    $marker$v_delivery_actor_name := COALESCE(v_delivery_actor_name, 'Unknown');$marker$
  ) + v_delivery_actor_start - 1
    + length($marker$v_delivery_actor_name := COALESCE(v_delivery_actor_name, 'Unknown');$marker$);
  v_delivery_actor_block := substring(
    v_definition FROM v_delivery_actor_start FOR v_delivery_actor_end - v_delivery_actor_start
  );
  v_commission_block := substring(
    v_definition FROM v_commission_start FOR v_delivery_return_start - v_commission_start
  );

  IF position('INSERT INTO crm.sales_orders (' IN v_work_block) = 0
    OR position('v_shipped_actor_id' IN v_work_block) = 0
    OR position('v_shipment_timestamp' IN v_work_block) = 0
    OR position('v_create_sales_order' IN v_work_block) = 0
    OR position('atlas.inventory_reference_type' IN v_work_block) = 0
    OR position('v_sales_order_id::text' IN v_work_block) = 0
    OR position(E'      id,\n      order_number,' IN v_work_block) = 0
    OR position(E'      v_sales_order_id,\n      '''',\n      v_order.workspace_id,' IN v_work_block) = 0
    OR position(E'      v_order.shipped_at,\n      NULL,\n      false,' IN v_work_block) = 0
    OR position(
      E'      v_order.id,\n      v_shipped_actor_id,\n      v_shipment_timestamp,\n      v_shipment_timestamp,\n      ''synced'','
      IN v_work_block
    ) = 0
    OR position('v_delivery_timestamp' IN v_work_block) > 0
    OR position('reconcile_sales_agent_commission(v_sales_order_id, NULL)' IN v_commission_block) = 0
  THEN
    RAISE EXCEPTION 'Marketplace shipment effects could not be isolated from delivery';
  END IF;

  v_shipping_branch := $ship$
  IF v_next_status = 'shipped' THEN
    v_shipment_timestamp := COALESCE(v_order.shipped_at, v_shipment_timestamp);
    v_order.shipped_at := v_shipment_timestamp;

    SELECT COALESCE(
      NULLIF(trim(p.name), ''),
      NULLIF(trim(u.email), ''),
      'Unknown'
    )
    INTO v_shipped_actor_name
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    WHERE u.id = v_shipped_actor_id;

    v_shipped_actor_name := COALESCE(v_shipped_actor_name, 'Unknown');

$ship$ || v_work_block || $ship$
    UPDATE public.marketplace_orders
    SET
      status = 'shipped',
      shipped_at = COALESCE(shipped_at, v_shipment_timestamp),
      shipped_by = COALESCE(shipped_by, v_shipped_actor_id),
      shipped_by_name = COALESCE(NULLIF(trim(shipped_by_name), ''), v_shipped_actor_name),
      inventory_deducted = COALESCE(v_order.inventory_deducted, false) OR v_inventory_completed,
      business_partner_id = COALESCE(v_business_partner_id, business_partner_id),
      customer_id = COALESCE(v_customer_id, customer_id),
      sales_order_id = COALESCE(v_sales_order_id, sales_order_id),
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

$ship$ || v_commission_block || $ship$
    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'shipped',
      'inventory_deducted', COALESCE(v_order.inventory_deducted, false) OR v_inventory_completed,
      'sales_order_id', v_sales_order_id,
      'customer_id', v_customer_id,
      'business_partner_id', v_business_partner_id,
      'warning',
        CASE
          WHEN COALESCE(array_length(v_warning_messages, 1), 0) > 0
            THEN array_to_string(v_warning_messages, '; ')
          ELSE NULL
        END,
      'warnings', to_jsonb(COALESCE(v_warning_messages, ARRAY[]::text[]))
    );
  END IF;

$ship$;

  v_updated := substring(v_definition FROM 1 FOR v_shipping_start - 1)
    || v_shipping_branch
    || substring(v_definition FROM v_cancel_start);

  v_delivery_branch := $delivered$  IF v_next_status = 'delivered' THEN
    v_sales_order_id := v_order.sales_order_id;
    v_customer_id := v_order.customer_id;
    v_business_partner_id := v_order.business_partner_id;

    IF v_sales_order_id IS NULL THEN
      RAISE EXCEPTION 'Shipped marketplace order has no linked sales order';
    END IF;

$delivered$ || v_delivery_actor_block || $delivered$

    UPDATE public.marketplace_orders
    SET
      status = 'delivered',
      delivered_at = COALESCE(delivered_at, v_delivery_timestamp),
      delivered_by = COALESCE(delivered_by, v_delivery_actor_id),
      delivered_by_name = COALESCE(NULLIF(delivered_by_name, ''), v_delivery_actor_name),
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    UPDATE crm.sales_orders
    SET
      actual_delivery_date = COALESCE(actual_delivery_date, v_delivery_timestamp),
      updated_at = v_delivery_timestamp,
      sync_status = 'synced',
      version = COALESCE(version, 0) + 1
    WHERE id = v_sales_order_id
      AND workspace_id = v_order.workspace_id
      AND marketplace_order_id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'delivered',
      'inventory_deducted', COALESCE(v_order.inventory_deducted, false),
      'sales_order_id', v_sales_order_id,
      'customer_id', v_customer_id,
      'business_partner_id', v_business_partner_id,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

$delivered$;

  v_delivery_actor_start := strpos(v_updated, v_delivery_actor_marker);
  v_function_end := length(v_updated)
    - strpos(reverse(v_updated), reverse(v_function_end_marker))
    - length(v_function_end_marker) + 2;
  IF v_delivery_actor_start = 0 OR v_function_end <= v_delivery_actor_start THEN
    RAISE EXCEPTION 'Original marketplace delivery effects could not be removed';
  END IF;

  v_updated := substring(v_updated FROM 1 FOR v_delivery_actor_start - 1)
    || v_delivery_branch
    || substring(v_updated FROM v_function_end);
  v_updated := replace(v_updated, chr(13), '');

  IF position('INSERT INTO crm.sales_orders (' IN substring(v_updated FROM strpos(v_updated, v_shipping_marker))) = 0
    OR position(E'status = ''delivered'',\n      delivered_at' IN v_updated) = 0
    OR position('reconcile_sales_agent_commission(v_sales_order_id, NULL)' IN substring(v_updated FROM strpos(v_updated, v_shipping_marker))) = 0
    OR position('reconcile_sales_agent_commission(v_sales_order_id, NULL)' IN substring(v_updated FROM strpos(v_updated, v_delivery_actor_marker))) > 0
  THEN
    RAISE EXCEPTION 'Marketplace delivery effects were not moved cleanly to shipment';
  END IF;

  EXECUTE v_updated;
END;
$transition$;

DO $item_edit_guard$
DECLARE
  v_definition text;
  v_replaced text;
  v_old text := $old$IF v_order.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Delivered and cancelled marketplace orders cannot be edited';$old$;
  v_new text := $new$IF v_order.status IN ('shipped', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Shipped, delivered, and cancelled marketplace orders cannot be edited';$new$;
BEGIN
  SELECT pg_get_functiondef('public.edit_marketplace_order_items(uuid,jsonb)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');
  v_old := replace(v_old, chr(13), '');
  v_new := replace(v_new, chr(13), '');
  IF position($marker$'shipped', 'delivered', 'cancelled'$marker$ IN v_definition) > 0 THEN
    RETURN;
  END IF;
  v_replaced := replace(v_definition, v_old, v_new);
  IF v_replaced IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Marketplace item edit guard could not be updated for shipped orders';
  END IF;
  EXECUTE v_replaced;
END;
$item_edit_guard$;

NOTIFY pgrst, 'reload schema';
