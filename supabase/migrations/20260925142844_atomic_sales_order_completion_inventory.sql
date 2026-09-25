-- Complete a pending sales order, deduct its inventory, and append the sale
-- ledger in one transaction. Cancellation locks the same sales_orders row, so
-- the order can never become cancelled after its stock deduction commits.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.complete_sales_order_with_inventory(
  p_order_id uuid,
  p_workspace_id uuid,
  p_expected_order_version bigint,
  p_operation_id uuid,
  p_items jsonb,
  p_actual_delivery_date timestamptz,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order crm.sales_orders%ROWTYPE;
  v_receipt private.inventory_snapshot_receipts%ROWTYPE;
  v_stock_result jsonb;
  v_inventory_rows jsonb;
  v_transaction_rows jsonb := '[]'::jsonb;
  v_completed_item jsonb;
  v_order_item jsonb;
  v_position record;
  v_inventory public.inventory%ROWTYPE;
  v_transaction public.inventory_transactions%ROWTYPE;
  v_change jsonb;
  v_change_count integer;
  v_change_quantity numeric;
  v_change_version integer;
  v_change_id uuid;
  v_item_index integer;
  v_quantity numeric;
  v_previous_quantity numeric;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_plan text;
  v_role text := COALESCE(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  );
  v_transaction_id uuid;
BEGIN
  IF p_order_id IS NULL OR p_workspace_id IS NULL OR p_operation_id IS NULL
    OR p_expected_order_version IS NULL OR p_expected_order_version < 0
  THEN
    RAISE EXCEPTION 'Sales order completion identifiers and version are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_operation_id IS DISTINCT FROM extensions.uuid_generate_v5(
    '29a34eb1-80c0-5cf9-8bc1-0bbb71fd718b'::uuid,
    p_order_id::text
  ) THEN
    RAISE EXCEPTION 'Sales order completion operation id is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF v_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;
    IF p_workspace_id IS DISTINCT FROM public.current_workspace_id()
      OR COALESCE(public.current_user_role(), '') NOT IN ('admin', 'staff')
    THEN
      RAISE EXCEPTION 'You are not allowed to complete sales orders in this workspace'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT workspace.plan::text
  INTO v_plan
  FROM public.workspaces AS workspace
  WHERE workspace.id = p_workspace_id;

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT COALESCE(
    public.workspace_module_allowed(
      p_workspace_id,
      v_plan,
      'orders'
    ),
    false
  ) THEN
    RAISE EXCEPTION 'Orders are not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_order
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.id = p_order_id
    AND sales_order.workspace_id = p_workspace_id
    AND COALESCE(sales_order.is_deleted, false) = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status = 'completed' THEN
    SELECT *
    INTO v_receipt
    FROM private.inventory_snapshot_receipts AS receipt
    WHERE receipt.operation_id = p_operation_id;

    IF NOT FOUND OR v_receipt.workspace_id IS DISTINCT FROM p_workspace_id
      OR v_receipt.operation_kind IS DISTINCT FROM 'sales_order_completion'
    THEN
      RAISE EXCEPTION 'Completed sales order is missing its inventory completion receipt'
        USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(transaction_row)
        ORDER BY transaction_row.product_id, transaction_row.storage_id),
      '[]'::jsonb
    )
    INTO v_transaction_rows
    FROM public.inventory_transactions AS transaction_row
    WHERE transaction_row.workspace_id = p_workspace_id
      AND transaction_row.transaction_type = 'sale'
      AND transaction_row.reference_type = 'sales_order'
      AND transaction_row.reference_id = p_order_id::text
      AND COALESCE(transaction_row.is_deleted, false) = false;

    RETURN pg_catalog.jsonb_build_object(
      'order', pg_catalog.to_jsonb(v_order),
      'inventory', COALESCE(v_receipt.result->'inventory', '[]'::jsonb),
      'inventory_transactions', v_transaction_rows,
      'already_applied', true
    );
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Sales order is not pending'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(v_order.version, 0)::bigint IS DISTINCT FROM p_expected_order_version THEN
    RAISE EXCEPTION 'Sales order changed on another device; refresh and retry'
      USING ERRCODE = '40001';
  END IF;

  IF COALESCE((pg_catalog.to_jsonb(v_order)->>'approval_status'), '') = 'requested' THEN
    RAISE EXCEPTION 'Sales order requires approval before completion'
      USING ERRCODE = '55000';
  END IF;

  IF v_order.items IS NULL
    OR pg_catalog.jsonb_typeof(v_order.items) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(v_order.items) = 0
    OR p_items IS NULL
    OR pg_catalog.jsonb_typeof(p_items) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(p_items) IS DISTINCT FROM pg_catalog.jsonb_array_length(v_order.items)
    OR p_changes IS NULL
    OR pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(p_changes) = 0
  THEN
    RAISE EXCEPTION 'Sales order completion payload is invalid'
      USING ERRCODE = '22023';
  END IF;

  FOR v_item_index IN 0..(pg_catalog.jsonb_array_length(v_order.items) - 1)
  LOOP
    v_order_item := v_order.items->v_item_index;
    v_completed_item := p_items->v_item_index;

    IF pg_catalog.jsonb_typeof(v_completed_item) IS DISTINCT FROM 'object'
      OR (v_completed_item - ARRAY[
        'reservedQuantity', 'fulfilledQuantity', 'costPrice',
        'convertedCostPrice', 'batchAllocations'
      ]) IS DISTINCT FROM (v_order_item - ARRAY[
        'reservedQuantity', 'fulfilledQuantity', 'costPrice',
        'convertedCostPrice', 'batchAllocations'
      ])
    THEN
      RAISE EXCEPTION 'Sales order items changed before completion'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Verify the client proposed exactly this order's physical stock delta and
  -- the current inventory versions. The nested strict CAS then locks and
  -- rechecks these versions before changing stock.
  FOR v_position IN
    WITH order_lines AS (
      SELECT
        NULLIF(line.item->>'productId', '')::uuid AS product_id,
        NULLIF(line.item->>'storageId', '')::uuid AS storage_id,
        pg_catalog.round(
          CASE
            WHEN line.item ? 'inventoryQuantity'
              AND NULLIF(line.item->>'inventoryQuantity', '') IS NOT NULL
            THEN (line.item->>'inventoryQuantity')::numeric
            ELSE COALESCE(NULLIF(line.item->>'quantity', '')::numeric, 0)
              * COALESCE(NULLIF(line.item->>'unitFactor', '')::numeric, 1)
          END
          + CASE
            WHEN line.item ? 'freeBonusInventoryQuantity'
              AND NULLIF(line.item->>'freeBonusInventoryQuantity', '') IS NOT NULL
            THEN (line.item->>'freeBonusInventoryQuantity')::numeric
            ELSE COALESCE(NULLIF(
              COALESCE(line.item->>'freeBonusQuantity', line.item->>'freeQuantity'), ''
            )::numeric, 0) * COALESCE(NULLIF(line.item->>'unitFactor', '')::numeric, 1)
          END,
          6
        ) AS quantity
      FROM pg_catalog.jsonb_array_elements(v_order.items) AS line(item)
    )
    SELECT
      order_line.product_id,
      order_line.storage_id,
      pg_catalog.round(SUM(order_line.quantity), 6) AS quantity
    FROM order_lines AS order_line
    JOIN public.products AS product
      ON product.id = order_line.product_id
     AND product.workspace_id = p_workspace_id
    WHERE COALESCE(product.is_deleted, false) = false
      AND COALESCE(product.is_service, false) = false
      AND order_line.quantity > 0
    GROUP BY order_line.product_id, order_line.storage_id
    ORDER BY order_line.product_id, order_line.storage_id
  LOOP
    IF v_position.product_id IS NULL OR v_position.storage_id IS NULL
      OR v_position.quantity IS NULL
      OR v_position.quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_position.quantity <= 0
    THEN
      RAISE EXCEPTION 'Every physical sales item needs a positive quantity and storage'
        USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*),
           MAX(change.value->>'id')::uuid,
           MAX((change.value->>'expected_version')::integer),
           MAX((change.value->>'quantity')::numeric)
    INTO v_change_count, v_change_id, v_change_version, v_change_quantity
    FROM pg_catalog.jsonb_array_elements(p_changes) AS change(value)
    WHERE NULLIF(change.value->>'product_id', '')::uuid = v_position.product_id
      AND NULLIF(change.value->>'storage_id', '')::uuid = v_position.storage_id;

    IF v_change_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Inventory changes do not match the sales order items'
        USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_inventory
    FROM public.inventory AS inventory_row
    WHERE inventory_row.workspace_id = p_workspace_id
      AND inventory_row.product_id = v_position.product_id
      AND inventory_row.storage_id = v_position.storage_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sales inventory position is missing'
        USING ERRCODE = '23503';
    END IF;

    IF v_inventory.id IS DISTINCT FROM v_change_id
      OR COALESCE(v_inventory.version, 0) IS DISTINCT FROM v_change_version
      OR pg_catalog.round(v_inventory.quantity - v_position.quantity, 6)
        IS DISTINCT FROM pg_catalog.round(v_change_quantity, 6)
    THEN
      RAISE EXCEPTION 'Inventory changes do not match the sales order quantity'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF pg_catalog.jsonb_array_length(p_changes) IS DISTINCT FROM (
    SELECT COUNT(*)::integer
    FROM (
      SELECT DISTINCT
        NULLIF(line.item->>'productId', '')::uuid AS product_id,
        NULLIF(line.item->>'storageId', '')::uuid AS storage_id
      FROM pg_catalog.jsonb_array_elements(v_order.items) AS line(item)
      JOIN public.products AS product
        ON product.id = NULLIF(line.item->>'productId', '')::uuid
       AND product.workspace_id = p_workspace_id
      WHERE COALESCE(product.is_deleted, false) = false
        AND COALESCE(product.is_service, false) = false
        AND pg_catalog.round(
          COALESCE(NULLIF(line.item->>'inventoryQuantity', '')::numeric,
            COALESCE(NULLIF(line.item->>'quantity', '')::numeric, 0)
              * COALESCE(NULLIF(line.item->>'unitFactor', '')::numeric, 1))
          + COALESCE(NULLIF(line.item->>'freeBonusInventoryQuantity', '')::numeric,
            COALESCE(NULLIF(COALESCE(line.item->>'freeBonusQuantity', line.item->>'freeQuantity'), '')::numeric, 0)
              * COALESCE(NULLIF(line.item->>'unitFactor', '')::numeric, 1)),
          6
        ) > 0
    ) AS expected_positions
  ) THEN
    RAISE EXCEPTION 'Inventory changes contain positions outside the sales order'
      USING ERRCODE = '22023';
  END IF;

  v_stock_result := private.apply_inventory_snapshot_changes(
    p_operation_id,
    p_workspace_id,
    'sales_order_completion',
    p_changes
  );
  v_inventory_rows := v_stock_result->'inventory';

  -- A sale now has the same append-only inventory history as a purchase or
  -- stock adjustment. These deterministic ids also make audit checks stable.
  FOR v_position IN
    WITH order_lines AS (
      SELECT
        NULLIF(line.item->>'productId', '')::uuid AS product_id,
        NULLIF(line.item->>'storageId', '')::uuid AS storage_id,
        pg_catalog.round(
          COALESCE(NULLIF(line.item->>'inventoryQuantity', '')::numeric,
            COALESCE(NULLIF(line.item->>'quantity', '')::numeric, 0)
              * COALESCE(NULLIF(line.item->>'unitFactor', '')::numeric, 1))
          + COALESCE(NULLIF(line.item->>'freeBonusInventoryQuantity', '')::numeric,
            COALESCE(NULLIF(COALESCE(line.item->>'freeBonusQuantity', line.item->>'freeQuantity'), '')::numeric, 0)
              * COALESCE(NULLIF(line.item->>'unitFactor', '')::numeric, 1)),
          6
        ) AS quantity
      FROM pg_catalog.jsonb_array_elements(v_order.items) AS line(item)
    )
    SELECT order_line.product_id,
           order_line.storage_id,
           pg_catalog.round(SUM(order_line.quantity), 6) AS quantity
    FROM order_lines AS order_line
    JOIN public.products AS product
      ON product.id = order_line.product_id
     AND product.workspace_id = p_workspace_id
    WHERE COALESCE(product.is_deleted, false) = false
      AND COALESCE(product.is_service, false) = false
      AND order_line.quantity > 0
    GROUP BY order_line.product_id, order_line.storage_id
    ORDER BY order_line.product_id, order_line.storage_id
  LOOP
    SELECT *
    INTO v_inventory
    FROM public.inventory AS inventory_row
    WHERE inventory_row.workspace_id = p_workspace_id
      AND inventory_row.product_id = v_position.product_id
      AND inventory_row.storage_id = v_position.storage_id;

    v_previous_quantity := pg_catalog.round(v_inventory.quantity + v_position.quantity, 6);
    v_transaction_id := extensions.uuid_generate_v5(
      'd45e710c-a5f6-4aac-9f11-4522932aeb9e'::uuid,
      'sales-order:' || p_order_id::text || ':'
        || v_position.product_id::text || ':' || v_position.storage_id::text
    );

    INSERT INTO public.inventory_transactions (
      id, workspace_id, product_id, storage_id, transaction_type,
      quantity_delta, previous_quantity, new_quantity,
      reference_id, reference_type, notes, created_by,
      created_at, updated_at, version, is_deleted, adjustment_reason
    )
    VALUES (
      v_transaction_id, p_workspace_id,
      v_position.product_id, v_position.storage_id, 'sale',
      -v_position.quantity, v_previous_quantity, v_inventory.quantity,
      p_order_id::text, 'sales_order',
      'Sold from sales order ' || v_order.order_number || '.',
      v_order.created_by::text,
      v_now, v_now, 1, false, NULL
    )
    RETURNING * INTO v_transaction;

    v_transaction_rows := v_transaction_rows
      || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_transaction));
  END LOOP;

  UPDATE crm.sales_orders AS sales_order
  SET status = 'completed',
      items = p_items,
      actual_delivery_date = COALESCE(p_actual_delivery_date, v_now),
      updated_at = v_now,
      sync_status = 'synced',
      version = COALESCE(sales_order.version, 0) + 1
  WHERE sales_order.id = p_order_id
  RETURNING * INTO v_order;

  RETURN pg_catalog.jsonb_build_object(
    'order', pg_catalog.to_jsonb(v_order),
    'inventory', COALESCE(v_inventory_rows, '[]'::jsonb),
    'inventory_transactions', v_transaction_rows,
    'already_applied', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) IS 'Atomically completes a pending sales order, deducts stock, and records sale inventory transactions.';
