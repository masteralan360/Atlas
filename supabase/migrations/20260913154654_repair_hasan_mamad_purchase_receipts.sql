-- Repair the two purchase receipts whose earlier client-side order write
-- committed while their separate inventory snapshot RPC rolled back. This is
-- intentionally limited to the audited workspace and order numbers.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $migration$
DECLARE
  v_workspace_id constant uuid := '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid;
  v_order crm.purchase_orders%ROWTYPE;
  v_position record;
  v_inventory public.inventory%ROWTYPE;
  v_expected_quantity numeric;
  v_expected_position_count integer;
  v_existing_count integer;
  v_existing_quantity numeric;
  v_previous_quantity numeric;
  v_next_quantity numeric;
  v_transaction_id uuid;
  v_target_count integer;
  v_verified_total numeric := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT pg_catalog.count(*)
  INTO v_target_count
  FROM crm.purchase_orders
  WHERE workspace_id = v_workspace_id
    AND order_number IN ('PO-2026-00018', 'PO-2026-00019')
    AND COALESCE(is_deleted, false) = false;

  IF v_target_count IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Historical purchase receipt repair expected exactly two orders, found %', v_target_count;
  END IF;

  FOR v_order IN
    SELECT *
    FROM crm.purchase_orders
    WHERE workspace_id = v_workspace_id
      AND order_number IN ('PO-2026-00018', 'PO-2026-00019')
      AND COALESCE(is_deleted, false) = false
    ORDER BY order_number
    FOR UPDATE
  LOOP
    IF v_order.status NOT IN ('received', 'completed') THEN
      RAISE EXCEPTION 'Historical purchase receipt repair found invalid status % for %',
        v_order.status, v_order.order_number;
    END IF;

    IF v_order.items IS NULL
      OR pg_catalog.jsonb_typeof(v_order.items) IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(v_order.items) = 0
    THEN
      RAISE EXCEPTION 'Historical purchase receipt repair found no items for %', v_order.order_number;
    END IF;

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
    ), positions AS (
      SELECT product_id, storage_id, pg_catalog.round(SUM(received_quantity), 6) AS received_quantity
      FROM receipt_lines
      GROUP BY product_id, storage_id
    )
    SELECT pg_catalog.round(SUM(received_quantity), 6), pg_catalog.count(*)
    INTO v_expected_quantity, v_expected_position_count
    FROM positions;

    IF v_expected_quantity IS DISTINCT FROM (CASE v_order.order_number
        WHEN 'PO-2026-00018' THEN 1848::numeric
        WHEN 'PO-2026-00019' THEN 232::numeric
      END)
    THEN
      RAISE EXCEPTION 'Historical purchase receipt quantity changed for %: expected audited total, found %',
        v_order.order_number, v_expected_quantity;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_order.items) AS line(item)
      LEFT JOIN public.products AS product
        ON product.id = NULLIF(line.item->>'productId', '')::uuid
       AND product.workspace_id = v_workspace_id
      WHERE NULLIF(line.item->>'productId', '') IS NULL
        OR COALESCE(NULLIF(line.item->>'storageId', '')::uuid, v_order.destination_storage_id) IS NULL
        OR product.id IS NULL
        OR COALESCE(product.is_deleted, false)
        OR COALESCE(product.is_service, false)
    ) THEN
      RAISE EXCEPTION 'Historical purchase receipt repair found an invalid product or storage reference for %',
        v_order.order_number;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.stock_batches AS batch
      WHERE batch.source_purchase_order_id = v_order.id
        AND COALESCE(batch.is_deleted, false) = false
    ) THEN
      RAISE EXCEPTION 'Historical purchase receipt repair found an unexpected existing receipt batch for %',
        v_order.order_number;
    END IF;

    SELECT pg_catalog.count(*), COALESCE(SUM(transaction.quantity_delta), 0)
    INTO v_existing_count, v_existing_quantity
    FROM public.inventory_transactions AS transaction
    WHERE transaction.workspace_id = v_workspace_id
      AND transaction.transaction_type = 'purchase'
      AND transaction.reference_id = v_order.id::text
      AND COALESCE(transaction.is_deleted, false) = false;

    IF v_existing_count > 0 THEN
      IF v_existing_count = v_expected_position_count
        AND v_existing_quantity = v_expected_quantity
        AND NOT EXISTS (
          SELECT 1
          FROM public.inventory_transactions AS transaction
          WHERE transaction.workspace_id = v_workspace_id
            AND transaction.transaction_type = 'purchase'
            AND transaction.reference_id = v_order.id::text
            AND transaction.reference_type IS DISTINCT FROM 'purchase_order_repair'
            AND COALESCE(transaction.is_deleted, false) = false
        )
      THEN
        v_verified_total := v_verified_total + v_expected_quantity;
        CONTINUE;
      END IF;

      RAISE EXCEPTION 'Historical purchase receipt repair found a partial or conflicting ledger for %',
        v_order.order_number;
    END IF;

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
      IF v_position.received_quantity IS NULL
        OR v_position.received_quantity::text IN ('NaN', 'Infinity', '-Infinity')
        OR v_position.received_quantity <= 0
      THEN
        RAISE EXCEPTION 'Historical purchase receipt repair found an invalid quantity for %',
          v_order.order_number;
      END IF;

      PERFORM 1
      FROM public.storages AS storage
      WHERE storage.id = v_position.storage_id
        AND storage.workspace_id = v_workspace_id
        AND COALESCE(storage.is_deleted, false) = false;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Historical purchase receipt repair found an unavailable storage for %',
          v_order.order_number;
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'inventory:' || v_workspace_id::text || ':'
            || v_position.product_id::text || ':' || v_position.storage_id::text,
          0
        )
      );

      SELECT *
      INTO v_inventory
      FROM public.inventory AS inventory_row
      WHERE inventory_row.workspace_id = v_workspace_id
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
        pg_catalog.gen_random_uuid(), v_workspace_id,
        v_position.product_id, v_position.storage_id, v_next_quantity,
        v_now, v_now, 1, false
      )
      ON CONFLICT (workspace_id, product_id, storage_id)
      DO UPDATE SET
        quantity = v_next_quantity,
        updated_at = v_now,
        version = COALESCE(public.inventory.version, 0) + 1,
        is_deleted = false;

      v_transaction_id := (
        pg_catalog.substr(pg_catalog.md5(
          'purchase-order-repair:' || v_order.id::text || ':'
            || v_position.product_id::text || ':' || v_position.storage_id::text
        ), 1, 8) || '-' ||
        pg_catalog.substr(pg_catalog.md5(
          'purchase-order-repair:' || v_order.id::text || ':'
            || v_position.product_id::text || ':' || v_position.storage_id::text
        ), 9, 4) || '-5' ||
        pg_catalog.substr(pg_catalog.md5(
          'purchase-order-repair:' || v_order.id::text || ':'
            || v_position.product_id::text || ':' || v_position.storage_id::text
        ), 14, 3) || '-a' ||
        pg_catalog.substr(pg_catalog.md5(
          'purchase-order-repair:' || v_order.id::text || ':'
            || v_position.product_id::text || ':' || v_position.storage_id::text
        ), 18, 3) || '-' ||
        pg_catalog.substr(pg_catalog.md5(
          'purchase-order-repair:' || v_order.id::text || ':'
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
        v_transaction_id, v_workspace_id,
        v_position.product_id, v_position.storage_id, 'purchase',
        v_position.received_quantity, v_previous_quantity, v_next_quantity,
        v_order.id::text, 'purchase_order_repair',
        'Audited repair of missing inventory receipt for ' || v_order.order_number || '.',
        'system:migration:20260913154654',
        v_now, v_now, 1, false, NULL
      );
    END LOOP;

    v_verified_total := v_verified_total + v_expected_quantity;
  END LOOP;

  IF v_verified_total IS DISTINCT FROM 2080::numeric THEN
    RAISE EXCEPTION 'Historical purchase receipt repair expected 2080 total units, verified %',
      v_verified_total;
  END IF;
END;
$migration$;
