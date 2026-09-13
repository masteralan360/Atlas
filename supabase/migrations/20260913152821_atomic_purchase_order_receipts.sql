-- Receive a purchase order as one authoritative database transaction. The
-- order cannot claim to be received unless inventory, optional receipt
-- batches, and the immutable inventory ledger all commit together.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE public.inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_type_check,
  DROP CONSTRAINT IF EXISTS inventory_transactions_previous_quantity_check,
  DROP CONSTRAINT IF EXISTS inventory_transactions_new_quantity_check;

ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_type_check CHECK (
    transaction_type IN (
      'stock_adjustment', 'transfer_in', 'transfer_out',
      'sale', 'return', 'purchase', 'initial_stock'
    )
  ),
  ADD CONSTRAINT inventory_transactions_previous_quantity_check CHECK (
    transaction_type = 'purchase' OR previous_quantity >= 0
  ),
  ADD CONSTRAINT inventory_transactions_new_quantity_check CHECK (
    transaction_type = 'purchase' OR new_quantity >= 0
  );

CREATE INDEX IF NOT EXISTS inventory_transactions_purchase_order_reference_idx
  ON public.inventory_transactions (workspace_id, reference_id, created_at)
  WHERE transaction_type = 'purchase'
    AND reference_type IN ('purchase_order', 'purchase_order_repair')
    AND is_deleted = false;

CREATE OR REPLACE FUNCTION private.receive_purchase_order(
  p_order_id uuid,
  p_target_status text DEFAULT 'received',
  p_batches jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order crm.purchase_orders%ROWTYPE;
  v_inventory public.inventory%ROWTYPE;
  v_transaction public.inventory_transactions%ROWTYPE;
  v_batch public.stock_batches%ROWTYPE;
  v_position record;
  v_batch_payload jsonb;
  v_item jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_previous_quantity numeric;
  v_next_quantity numeric;
  v_inventory_rows jsonb := '[]'::jsonb;
  v_transaction_rows jsonb := '[]'::jsonb;
  v_batch_rows jsonb := '[]'::jsonb;
  v_item_index integer;
  v_item_count integer;
  v_product_id uuid;
  v_storage_id uuid;
  v_received_quantity numeric;
  v_source_item_id text;
  v_transaction_id uuid;
  v_jwt_role text := COALESCE(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  );
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Purchase order id is required' USING ERRCODE = '22023';
  END IF;

  IF p_target_status NOT IN ('received', 'completed') THEN
    RAISE EXCEPTION 'Purchase receipt target status is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_batches IS NULL OR pg_catalog.jsonb_typeof(p_batches) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Purchase receipt batches must be an array'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_order
  FROM crm.purchase_orders
  WHERE id = p_order_id
    AND COALESCE(is_deleted, false) = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
    END IF;

    IF v_order.workspace_id IS DISTINCT FROM public.current_workspace_id()
      OR public.current_user_role() NOT IN ('admin', 'staff')
    THEN
      RAISE EXCEPTION 'You are not allowed to receive inventory in this workspace'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT COALESCE(
    public.workspace_module_allowed(
      v_order.workspace_id,
      (SELECT workspace.plan::text
       FROM public.workspaces AS workspace
       WHERE workspace.id = v_order.workspace_id),
      'orders'
    ),
    false
  ) THEN
    RAISE EXCEPTION 'Orders are not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;

  IF v_order.status IN ('received', 'completed') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.inventory_transactions AS transaction
      WHERE transaction.workspace_id = v_order.workspace_id
        AND transaction.transaction_type = 'purchase'
        AND transaction.reference_type IN ('purchase_order', 'purchase_order_repair')
        AND transaction.reference_id = v_order.id::text
        AND COALESCE(transaction.is_deleted, false) = false
    ) THEN
      RAISE EXCEPTION 'Received purchase order is missing its inventory ledger; repair it explicitly'
        USING ERRCODE = '55000';
    END IF;

    IF p_target_status = 'completed' AND v_order.status = 'received' THEN
      UPDATE crm.purchase_orders AS purchase_order
      SET status = 'completed',
          updated_at = v_now,
          sync_status = 'synced',
          version = COALESCE(purchase_order.version, 0) + 1
      WHERE purchase_order.id = v_order.id
      RETURNING * INTO v_order;
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(inventory_row)), '[]'::jsonb)
    INTO v_inventory_rows
    FROM public.inventory AS inventory_row
    WHERE inventory_row.workspace_id = v_order.workspace_id
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item(value)
        WHERE NULLIF(item.value->>'productId', '')::uuid = inventory_row.product_id
          AND COALESCE(
            NULLIF(item.value->>'storageId', '')::uuid,
            v_order.destination_storage_id
          ) = inventory_row.storage_id
      );

    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(transaction_row)), '[]'::jsonb)
    INTO v_transaction_rows
    FROM public.inventory_transactions AS transaction_row
    WHERE transaction_row.workspace_id = v_order.workspace_id
      AND transaction_row.transaction_type = 'purchase'
      AND transaction_row.reference_type IN ('purchase_order', 'purchase_order_repair')
      AND transaction_row.reference_id = v_order.id::text
      AND COALESCE(transaction_row.is_deleted, false) = false;

    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(batch_row)), '[]'::jsonb)
    INTO v_batch_rows
    FROM public.stock_batches AS batch_row
    WHERE batch_row.workspace_id = v_order.workspace_id
      AND batch_row.source_purchase_order_id = v_order.id
      AND COALESCE(batch_row.is_deleted, false) = false;

    RETURN pg_catalog.jsonb_build_object(
      'order', pg_catalog.to_jsonb(v_order),
      'inventory', v_inventory_rows,
      'inventory_transactions', v_transaction_rows,
      'stock_batches', v_batch_rows,
      'already_applied', true
    );
  END IF;

  IF v_order.status IS DISTINCT FROM 'ordered' THEN
    RAISE EXCEPTION 'Purchase order must be ordered before it can be received'
      USING ERRCODE = '55000';
  END IF;

  IF v_order.approval_status = 'requested' THEN
    RAISE EXCEPTION 'Purchase order requires approval before it can be received'
      USING ERRCODE = '55000';
  END IF;

  IF v_order.items IS NULL
    OR pg_catalog.jsonb_typeof(v_order.items) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(v_order.items) = 0
  THEN
    RAISE EXCEPTION 'Purchase order has no receivable items'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_array_length(p_batches) > pg_catalog.jsonb_array_length(v_order.items) THEN
    RAISE EXCEPTION 'Purchase receipt contains too many batches'
      USING ERRCODE = '22023';
  END IF;

  -- Aggregate by position and acquire locks in a stable order. A single order
  -- may contain multiple lines for the same product/storage pair.
  FOR v_position IN
    WITH receipt_lines AS (
      SELECT
        NULLIF(line.item->>'productId', '')::uuid AS product_id,
        COALESCE(
          NULLIF(line.item->>'storageId', '')::uuid,
          v_order.destination_storage_id
        ) AS storage_id,
        CASE
          WHEN line.item ? 'receivedQuantity'
            AND NULLIF(line.item->>'receivedQuantity', '') IS NOT NULL
          THEN pg_catalog.round((line.item->>'receivedQuantity')::numeric, 6)
          ELSE pg_catalog.round(
            GREATEST(COALESCE(NULLIF(line.item->>'quantity', '')::numeric, 0), 0)
            + GREATEST(
              COALESCE(
                NULLIF(
                  COALESCE(line.item->>'freeBonusQuantity', line.item->>'freeQuantity'),
                  ''
                )::numeric,
                0
              ),
              0
            ),
            6
          )
        END AS received_quantity
      FROM pg_catalog.jsonb_array_elements(v_order.items) AS line(item)
    )
    SELECT product_id, storage_id, pg_catalog.round(SUM(received_quantity), 6) AS received_quantity
    FROM receipt_lines
    GROUP BY product_id, storage_id
    ORDER BY product_id, storage_id
  LOOP
    IF v_position.product_id IS NULL OR v_position.storage_id IS NULL THEN
      RAISE EXCEPTION 'Every purchase item requires a product and target storage'
        USING ERRCODE = '22023';
    END IF;

    IF v_position.received_quantity IS NULL
      OR v_position.received_quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_position.received_quantity <= 0
    THEN
      RAISE EXCEPTION 'Every purchase item requires a positive finite received quantity'
        USING ERRCODE = '22023';
    END IF;

    PERFORM 1
    FROM public.products AS product
    WHERE product.id = v_position.product_id
      AND product.workspace_id = v_order.workspace_id
      AND COALESCE(product.is_deleted, false) = false
      AND COALESCE(product.is_service, false) = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase inventory product is unavailable'
        USING ERRCODE = '23503';
    END IF;

    PERFORM 1
    FROM public.storages AS storage
    WHERE storage.id = v_position.storage_id
      AND storage.workspace_id = v_order.workspace_id
      AND COALESCE(storage.is_deleted, false) = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase target storage is unavailable'
        USING ERRCODE = '23503';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'inventory:' || v_order.workspace_id::text || ':'
          || v_position.product_id::text || ':' || v_position.storage_id::text,
        0
      )
    );

    SELECT *
    INTO v_inventory
    FROM public.inventory AS inventory_row
    WHERE inventory_row.workspace_id = v_order.workspace_id
      AND inventory_row.product_id = v_position.product_id
      AND inventory_row.storage_id = v_position.storage_id
    FOR UPDATE;

    v_previous_quantity := CASE WHEN FOUND THEN v_inventory.quantity ELSE 0 END;
    v_next_quantity := pg_catalog.round(v_previous_quantity + v_position.received_quantity, 6);

    INSERT INTO public.inventory (
      id, workspace_id, product_id, storage_id, quantity,
      created_at, updated_at, version, is_deleted
    )
    VALUES (
      pg_catalog.gen_random_uuid(), v_order.workspace_id,
      v_position.product_id, v_position.storage_id, v_next_quantity,
      v_now, v_now, 1, false
    )
    ON CONFLICT (workspace_id, product_id, storage_id)
    DO UPDATE SET
      quantity = v_next_quantity,
      updated_at = v_now,
      version = COALESCE(public.inventory.version, 0) + 1,
      is_deleted = false
    RETURNING * INTO v_inventory;

    v_transaction_id := (
      pg_catalog.substr(pg_catalog.md5(
        'purchase-order:' || v_order.id::text || ':'
          || v_position.product_id::text || ':' || v_position.storage_id::text
      ), 1, 8) || '-' ||
      pg_catalog.substr(pg_catalog.md5(
        'purchase-order:' || v_order.id::text || ':'
          || v_position.product_id::text || ':' || v_position.storage_id::text
      ), 9, 4) || '-5' ||
      pg_catalog.substr(pg_catalog.md5(
        'purchase-order:' || v_order.id::text || ':'
          || v_position.product_id::text || ':' || v_position.storage_id::text
      ), 14, 3) || '-a' ||
      pg_catalog.substr(pg_catalog.md5(
        'purchase-order:' || v_order.id::text || ':'
          || v_position.product_id::text || ':' || v_position.storage_id::text
      ), 18, 3) || '-' ||
      pg_catalog.substr(pg_catalog.md5(
        'purchase-order:' || v_order.id::text || ':'
          || v_position.product_id::text || ':' || v_position.storage_id::text
      ), 21, 12)
    )::uuid;

    INSERT INTO public.inventory_transactions (
      id, workspace_id, product_id, storage_id, transaction_type,
      quantity_delta, previous_quantity, new_quantity,
      reference_id, reference_type, notes, created_by,
      created_at, updated_at, version, is_deleted, adjustment_reason
    )
    VALUES (
      v_transaction_id, v_order.workspace_id,
      v_position.product_id, v_position.storage_id, 'purchase',
      v_position.received_quantity, v_previous_quantity, v_next_quantity,
      v_order.id::text, 'purchase_order',
      'Received from purchase order ' || v_order.order_number || '.',
      auth.uid()::text,
      v_now, v_now, 1, false, NULL
    )
    RETURNING * INTO v_transaction;

    v_inventory_rows := v_inventory_rows
      || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_inventory));
    v_transaction_rows := v_transaction_rows
      || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_transaction));
  END LOOP;

  FOR v_batch_payload IN
    SELECT batch.value
    FROM pg_catalog.jsonb_array_elements(p_batches) AS batch(value)
    ORDER BY (batch.value->>'item_index')::integer
  LOOP
    IF pg_catalog.jsonb_typeof(v_batch_payload) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Each purchase receipt batch must be an object'
        USING ERRCODE = '22023';
    END IF;

    v_item_index := (v_batch_payload->>'item_index')::integer;
    IF v_item_index < 0 OR v_item_index >= pg_catalog.jsonb_array_length(v_order.items) THEN
      RAISE EXCEPTION 'Purchase receipt batch item index is invalid'
        USING ERRCODE = '22023';
    END IF;

    v_item := v_order.items->v_item_index;
    v_product_id := NULLIF(v_item->>'productId', '')::uuid;
    v_storage_id := COALESCE(
      NULLIF(v_item->>'storageId', '')::uuid,
      v_order.destination_storage_id
    );
    v_received_quantity := CASE
      WHEN v_item ? 'receivedQuantity' AND NULLIF(v_item->>'receivedQuantity', '') IS NOT NULL
      THEN pg_catalog.round((v_item->>'receivedQuantity')::numeric, 6)
      ELSE pg_catalog.round(
        GREATEST(COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0), 0)
        + GREATEST(
          COALESCE(
            NULLIF(COALESCE(v_item->>'freeBonusQuantity', v_item->>'freeQuantity'), '')::numeric,
            0
          ),
          0
        ),
        6
      )
    END;

    IF NULLIF(v_batch_payload->>'product_id', '')::uuid IS DISTINCT FROM v_product_id
      OR NULLIF(v_batch_payload->>'storage_id', '')::uuid IS DISTINCT FROM v_storage_id
      OR pg_catalog.round((v_batch_payload->>'quantity')::numeric, 6)
        IS DISTINCT FROM v_received_quantity
    THEN
      RAISE EXCEPTION 'Purchase receipt batch does not match its order item'
        USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*)
    INTO v_item_count
    FROM pg_catalog.jsonb_array_elements(v_order.items) AS candidate(item)
    WHERE candidate.item->>'id' = v_item->>'id';
    v_source_item_id := CASE
      WHEN v_item_count > 1 THEN (v_item->>'id') || ':' || v_item_index::text
      ELSE v_item->>'id'
    END;

    IF NULLIF(v_batch_payload->>'source_item_id', '') IS DISTINCT FROM v_source_item_id
      OR NULLIF(pg_catalog.btrim(v_batch_payload->>'batch_number'), '') IS NULL
      OR (v_batch_payload->>'price')::numeric < 0
      OR (v_batch_payload->>'cost_price')::numeric < 0
      OR NULLIF(pg_catalog.btrim(v_batch_payload->>'currency'), '') IS NULL
    THEN
      RAISE EXCEPTION 'Purchase receipt batch values are invalid'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.stock_batches (
      id, workspace_id, product_id, storage_id, batch_number, quantity,
      expiry_date, manufacturing_date, notes,
      created_at, updated_at, version, is_deleted,
      price, cost_price, currency,
      source_purchase_order_id, source_purchase_order_item_id
    )
    VALUES (
      COALESCE(NULLIF(v_batch_payload->>'id', '')::uuid, pg_catalog.gen_random_uuid()),
      v_order.workspace_id, v_product_id, v_storage_id,
      pg_catalog.btrim(v_batch_payload->>'batch_number'), v_received_quantity,
      NULLIF(v_batch_payload->>'expiry_date', '')::date,
      NULLIF(v_batch_payload->>'manufacturing_date', '')::date,
      NULLIF(v_batch_payload->>'notes', ''),
      v_now, v_now, 1, false,
      (v_batch_payload->>'price')::numeric,
      (v_batch_payload->>'cost_price')::numeric,
      pg_catalog.lower(v_batch_payload->>'currency'),
      v_order.id, v_source_item_id
    )
    RETURNING * INTO v_batch;

    v_batch_rows := v_batch_rows
      || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_batch));
  END LOOP;

  UPDATE crm.purchase_orders AS purchase_order
  SET status = p_target_status,
      actual_delivery_date = COALESCE(purchase_order.actual_delivery_date, v_now),
      updated_at = v_now,
      sync_status = 'synced',
      version = COALESCE(purchase_order.version, 0) + 1
  WHERE purchase_order.id = v_order.id
  RETURNING * INTO v_order;

  RETURN pg_catalog.jsonb_build_object(
    'order', pg_catalog.to_jsonb(v_order),
    'inventory', v_inventory_rows,
    'inventory_transactions', v_transaction_rows,
    'stock_batches', v_batch_rows,
    'already_applied', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.receive_purchase_order(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.receive_purchase_order(uuid, text, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.receive_purchase_order(
  p_order_id uuid,
  p_target_status text DEFAULT 'received',
  p_batches jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN private.receive_purchase_order(p_order_id, p_target_status, p_batches);
END;
$function$;

REVOKE ALL ON FUNCTION public.receive_purchase_order(uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order(uuid, text, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.receive_purchase_order(uuid, text, jsonb) IS
  'Atomically receives an ordered purchase order, inventory deltas, optional receipt batches, and immutable purchase ledger rows.';
