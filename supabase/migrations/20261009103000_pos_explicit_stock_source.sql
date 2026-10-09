-- POS may now explicitly choose regular stock or one stock batch. Preserve
-- automatic FEFO allocation for older clients and barcode-driven cart lines.
DO $patch_pos_stock_sources$
DECLARE
  function_sql text;
  marker text := E'            IF v_has_active_batches THEN\n                FOR v_batch_record IN';
  replacement text := $replacement$
            IF COALESCE(item->>'stock_source_type', '') = 'regular' THEN
                -- Lock batch rows before the inventory row, matching the
                -- existing batch-sale lock order. Regular stock is the part
                -- of the total inventory snapshot not represented by batches.
                v_allocated_quantity := 0;
                FOR v_batch_record IN
                    SELECT *
                    FROM public.stock_batches
                    WHERE workspace_id = p_workspace_id
                      AND product_id = v_product_id
                      AND storage_id = v_storage_id
                      AND COALESCE(is_deleted, false) = false
                    FOR UPDATE
                LOOP
                    v_allocated_quantity := v_allocated_quantity + COALESCE(v_batch_record.quantity, 0);
                END LOOP;

                SELECT quantity
                INTO v_inventory_snapshot
                FROM public.inventory
                WHERE workspace_id = p_workspace_id
                  AND product_id = v_product_id
                  AND storage_id = v_storage_id
                  AND COALESCE(is_deleted, false) = false
                FOR UPDATE;

                IF NOT FOUND
                  OR v_batch_remaining > GREATEST(v_inventory_snapshot - v_allocated_quantity, 0) + 0.0000005
                THEN
                    RAISE EXCEPTION 'Insufficient regular stock for product % in storage %', v_product_id, v_storage_id
                      USING ERRCODE = '23514';
                END IF;
            ELSIF COALESCE(item->>'stock_source_type', '') = 'batch' THEN
                SELECT *
                INTO v_batch_record
                FROM public.stock_batches
                WHERE id = NULLIF(item->>'stock_source_batch_id', '')::uuid
                  AND workspace_id = p_workspace_id
                  AND product_id = v_product_id
                  AND storage_id = v_storage_id
                  AND COALESCE(is_deleted, false) = false
                FOR UPDATE;

                IF NOT FOUND THEN
                    RAISE EXCEPTION 'The selected stock batch is no longer available'
                      USING ERRCODE = '23514';
                END IF;
                v_has_active_batches := true;
                IF v_batch_remaining > COALESCE(v_batch_record.quantity, 0) + 0.0000005 THEN
                    RAISE EXCEPTION 'The selected stock batch no longer has enough quantity'
                      USING ERRCODE = '23514';
                END IF;

                UPDATE public.stock_batches
                SET
                    quantity = v_batch_record.quantity - v_batch_remaining,
                    updated_at = NOW(),
                    version = COALESCE(version, 0) + 1,
                    is_deleted = (v_batch_record.quantity - v_batch_remaining) <= 0
                WHERE id = v_batch_record.id;

                v_batch_allocations := jsonb_build_array(
                    jsonb_build_object(
                        'batch_id', v_batch_record.id,
                        'batch_number', v_batch_record.batch_number,
                        'quantity', v_batch_remaining,
                        'price', v_batch_record.price,
                        'cost_price', v_batch_record.cost_price,
                        'currency', lower(v_batch_record.currency),
                        'expiry_date', v_batch_record.expiry_date,
                        'manufacturing_date', v_batch_record.manufacturing_date
                    )
                );
                v_batch_remaining := 0;
            ELSIF v_has_active_batches THEN
                FOR v_batch_record IN$replacement$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('private.complete_sale_once(jsonb)'::regprocedure)
  INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');

  IF pg_catalog.strpos(function_sql, 'v_batch_remaining := COALESCE((item->>''inventory_quantity'')::numeric, v_quantity);') = 0
    OR pg_catalog.strpos(function_sql, 'quantity = quantity - COALESCE((item->>''inventory_quantity'')::numeric, v_quantity)') = 0
    OR pg_catalog.strpos(function_sql, marker) = 0
  THEN
    RAISE EXCEPTION 'complete_sale_once did not match the expected batch-aware inventory implementation';
  END IF;

  function_sql := pg_catalog.replace(function_sql, marker, replacement);

  IF pg_catalog.strpos(function_sql, 'stock_source_type') = 0
    OR pg_catalog.strpos(function_sql, 'Insufficient regular stock for product') = 0
    OR pg_catalog.strpos(function_sql, 'The selected stock batch is no longer available') = 0
  THEN
    RAISE EXCEPTION 'complete_sale_once stock source patch failed';
  END IF;

  EXECUTE function_sql;
END;
$patch_pos_stock_sources$;

-- Quick Orders retain a selected source in batchAllocations. Apply the same
-- explicit-batch and regular-stock rules when an immediately-paid Quick Order
-- reaches its atomic completion RPC.
DO $patch_quick_order_stock_sources$
DECLARE
  function_sql text;
  marker text := E'      -- Quick Order does not expose manual batch selection. Allocate FEFO/FIFO\n      -- directly from the authoritative rows, then use ordinary unbatched stock\n      -- for any remaining quantity exactly like the local planner.\n      FOR v_batch IN';
  replacement text := $replacement$
      IF jsonb_typeof(v_item->'batchAllocations') = 'array' THEN
        IF jsonb_array_length(v_item->'batchAllocations') > 0 THEN
          IF EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_item->'batchAllocations') AS allocation
            WHERE jsonb_typeof(allocation) IS DISTINCT FROM 'object'
              OR NULLIF(allocation->>'batchId', '') IS NULL
              OR NULLIF(allocation->>'quantity', '') IS NULL
              OR (allocation->>'quantity')::numeric <= 0
          ) THEN
            RAISE EXCEPTION 'Selected batch quantity does not match the Quick Order line'
              USING ERRCODE = '23514';
          END IF;

          SELECT COALESCE(sum(NULLIF(allocation->>'quantity', '')::numeric), 0)
          INTO v_total_allocated
          FROM jsonb_array_elements(v_item->'batchAllocations') AS allocation;
          IF abs(v_total_allocated - v_required_quantity) > 0.0000005 THEN
            RAISE EXCEPTION 'Selected batch quantity does not match the Quick Order line'
              USING ERRCODE = '23514';
          END IF;
        ELSE
          -- An empty selection explicitly uses regular stock. Batch quantities
          -- remain part of total inventory, so subtract them before validating
          -- the requested regular-stock amount.
          SELECT COALESCE(sum(batch_row.quantity), 0)
          INTO v_total_allocated
          FROM public.stock_batches AS batch_row
          WHERE batch_row.workspace_id = v_workspace_id
            AND batch_row.product_id = v_product_id
            AND batch_row.storage_id = v_storage_id
            AND NOT batch_row.is_deleted
            AND batch_row.quantity > 0;
          IF v_inventory.quantity - v_pending_reserved - v_total_allocated + 0.0000005 < v_required_quantity THEN
            RAISE EXCEPTION 'Insufficient regular stock for Quick Order product %', v_product_id
              USING ERRCODE = '23514';
          END IF;
        END IF;
      END IF;

      FOR v_batch IN$replacement$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('private.complete_quick_sales_order_once(jsonb)'::regprocedure)
  INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');

  IF pg_catalog.strpos(function_sql, marker) = 0
    OR pg_catalog.strpos(function_sql, 'v_required_quantity := round((') = 0
    OR pg_catalog.strpos(function_sql, 'v_allocated_quantity := LEAST(v_remaining_quantity, v_batch.quantity);') = 0
  THEN
    RAISE EXCEPTION 'complete_quick_sales_order_once did not match the expected stock allocation implementation';
  END IF;

  function_sql := pg_catalog.replace(function_sql, marker, replacement);
  function_sql := pg_catalog.replace(
    function_sql,
    E'          AND batch_row.quantity > 0\n        ORDER BY',
    E'          AND batch_row.quantity > 0\n          AND (\n            jsonb_typeof(v_item->''batchAllocations'') IS DISTINCT FROM ''array''\n            OR batch_row.id IN (\n              SELECT NULLIF(allocation->>''batchId'', '''')::uuid\n              FROM jsonb_array_elements(v_item->''batchAllocations'') AS allocation\n            )\n          )\n        ORDER BY'
  );
  function_sql := pg_catalog.replace(
    function_sql,
    'v_allocated_quantity := LEAST(v_remaining_quantity, v_batch.quantity);',
    $allocation$
        v_allocated_quantity := CASE
          WHEN jsonb_typeof(v_item->'batchAllocations') = 'array'
            THEN COALESCE((
              SELECT sum(NULLIF(allocation->>'quantity', '')::numeric)
              FROM jsonb_array_elements(v_item->'batchAllocations') AS allocation
              WHERE NULLIF(allocation->>'batchId', '')::uuid = v_batch.id
            ), 0)
          ELSE LEAST(v_remaining_quantity, v_batch.quantity)
        END;
        IF v_allocated_quantity > v_batch.quantity + 0.0000005 THEN
          RAISE EXCEPTION 'The selected Quick Order batch no longer has enough quantity'
            USING ERRCODE = '23514';
        END IF;$allocation$
  );
  function_sql := pg_catalog.replace(
    function_sql,
    E'      END LOOP;\n\n      v_original_cost_total :=',
    E'      END LOOP;\n\n'
      || E'      IF jsonb_typeof(v_item->''batchAllocations'') = ''array''\n'
      || E'        AND jsonb_array_length(v_item->''batchAllocations'') > 0\n'
      || E'        AND v_remaining_quantity > 0.0000005 THEN\n'
      || E'        RAISE EXCEPTION ''The selected Quick Order batch is no longer available''\n'
      || E'          USING ERRCODE = ''23514'';\n'
      || E'      END IF;\n\n'
      || E'      v_original_cost_total :='
  );

  IF pg_catalog.strpos(function_sql, 'Selected batch quantity does not match the Quick Order line') = 0
    OR pg_catalog.strpos(function_sql, 'The selected Quick Order batch is no longer available') = 0
    OR pg_catalog.strpos(function_sql, 'batch_row.id IN (') = 0
  THEN
    RAISE EXCEPTION 'complete_quick_sales_order_once stock source patch failed';
  END IF;

  EXECUTE function_sql;
END;
$patch_quick_order_stock_sources$;
