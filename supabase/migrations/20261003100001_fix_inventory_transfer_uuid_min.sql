CREATE OR REPLACE FUNCTION public.apply_inventory_transfer_batch(
  p_operation_id uuid,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_jwt_role text := COALESCE(pg_catalog.current_setting('request.jwt.claim.role', true), '');
  v_actor_id uuid := auth.uid();
  v_payload_hash text;
  v_receipt private.inventory_transfer_batch_receipts%ROWTYPE;
  v_batch_payload jsonb;
  v_batch_id uuid;
  v_workspace_id uuid;
  v_source_workspace_id uuid;
  v_destination_workspace_id uuid;
  v_source_storage_id uuid;
  v_destination_storage_id uuid;
  v_created_by uuid;
  v_transferred_at timestamptz;
  v_sequence bigint;
  v_transfer_number text;
  v_workspace uuid;
  v_workspace_changes jsonb;
  v_suboperation_id uuid;
  v_subresult jsonb;
  v_change jsonb;
  v_transaction_json jsonb;
  v_transaction public.inventory_transactions%ROWTYPE;
  v_stock_change jsonb;
  v_stock_row jsonb;
  v_stock_id uuid;
  v_stock_workspace_id uuid;
  v_stock_product_id uuid;
  v_stock_storage_id uuid;
  v_stock_expected_version integer;
  v_stock_current public.stock_batches%ROWTYPE;
  v_stock_quantity numeric;
  v_stock_price numeric;
  v_stock_cost_price numeric;
  v_stock_currency text;
  v_stock_is_deleted boolean;
  v_inventory_rows jsonb := '[]'::jsonb;
  v_transaction_rows jsonb := '[]'::jsonb;
  v_stock_rows jsonb := '[]'::jsonb;
  v_product_rows jsonb := '[]'::jsonb;
  v_product record;
  v_product_quantity numeric;
  v_active_storage_count bigint;
  v_only_storage_id uuid;
  v_updated_count integer;
  v_expected_transactions integer;
  v_result jsonb;
BEGIN
  IF p_operation_id IS NULL
    OR p_payload IS NULL
    OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'Transfer operation and payload are required'
      USING ERRCODE = '22023';
  END IF;

  v_batch_payload := p_payload->'batch';
  IF pg_catalog.jsonb_typeof(v_batch_payload) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(p_payload->'inventory_changes') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(p_payload->'inventory_changes') = 0
    OR (
      p_payload ? 'stock_batch_changes'
      AND pg_catalog.jsonb_typeof(p_payload->'stock_batch_changes') IS DISTINCT FROM 'array'
    )
  THEN
    RAISE EXCEPTION 'Transfer batch, inventory changes, or stock batch changes are invalid'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_batch_id := NULLIF(pg_catalog.btrim(v_batch_payload->>'id'), '')::uuid;
    v_workspace_id := NULLIF(pg_catalog.btrim(v_batch_payload->>'workspace_id'), '')::uuid;
    v_source_workspace_id := NULLIF(pg_catalog.btrim(v_batch_payload->>'source_workspace_id'), '')::uuid;
    v_destination_workspace_id := NULLIF(pg_catalog.btrim(v_batch_payload->>'destination_workspace_id'), '')::uuid;
    v_source_storage_id := NULLIF(pg_catalog.btrim(v_batch_payload->>'source_storage_id'), '')::uuid;
    v_destination_storage_id := NULLIF(pg_catalog.btrim(v_batch_payload->>'destination_storage_id'), '')::uuid;
    v_created_by := NULLIF(pg_catalog.btrim(v_batch_payload->>'created_by'), '')::uuid;
    v_transferred_at := COALESCE(
      NULLIF(pg_catalog.btrim(v_batch_payload->>'transferred_at'), '')::timestamptz,
      pg_catalog.now()
    );
  EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Transfer batch contains an invalid identifier or timestamp'
        USING ERRCODE = '22023';
  END;

  IF v_batch_id IS NULL
    OR v_batch_id IS DISTINCT FROM p_operation_id
    OR v_workspace_id IS NULL
    OR v_source_workspace_id IS NULL
    OR v_destination_workspace_id IS NULL
    OR v_source_storage_id IS NULL
    OR v_destination_storage_id IS NULL
  THEN
    RAISE EXCEPTION 'Transfer batch identifiers are required and must match the operation id'
      USING ERRCODE = '22023';
  END IF;

  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF v_actor_id IS NULL THEN
      RAISE EXCEPTION 'Authentication is required'
        USING ERRCODE = '42501';
    END IF;
    IF v_workspace_id IS DISTINCT FROM public.current_workspace_id()
      OR public.current_user_role() NOT IN ('admin', 'staff')
      OR v_source_workspace_id IS DISTINCT FROM v_workspace_id
      OR v_destination_workspace_id IS DISTINCT FROM v_workspace_id
      OR NOT public.current_user_can_access_storage(v_workspace_id, v_source_storage_id)
      OR NOT public.current_user_can_access_storage(v_workspace_id, v_destination_storage_id)
    THEN
      RAISE EXCEPTION 'You are not allowed to transfer inventory in this workspace'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_actor_id := COALESCE(v_actor_id, v_created_by);
  END IF;

  IF v_source_storage_id = v_destination_storage_id
    AND v_source_workspace_id = v_destination_workspace_id
  THEN
    RAISE EXCEPTION 'Source and destination storages must be different'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.storages
  WHERE id = v_source_storage_id
    AND workspace_id = v_source_workspace_id
    AND COALESCE(is_deleted, false) = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source storage is not active in the selected workspace'
      USING ERRCODE = '23503';
  END IF;

  PERFORM 1
  FROM public.storages
  WHERE id = v_destination_storage_id
    AND workspace_id = v_destination_workspace_id
    AND COALESCE(is_deleted, false) = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Destination storage is not active in the selected workspace'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_payload->'inventory_changes') AS entries(change)
    WHERE NULLIF(pg_catalog.btrim(change->>'workspace_id'), '')::uuid
      NOT IN (v_source_workspace_id, v_destination_workspace_id)
  ) THEN
    RAISE EXCEPTION 'Inventory change workspace does not match the transfer endpoints'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_payload->'inventory_changes') AS entries(change)
    WHERE NOT COALESCE((
      (NULLIF(pg_catalog.btrim(change->>'workspace_id'), '')::uuid = v_source_workspace_id
        AND NULLIF(pg_catalog.btrim(change->>'storage_id'), '')::uuid = v_source_storage_id
        AND change->>'transfer_side' = 'source'
        AND change->>'audit_transaction_type' = 'transfer_out'
        AND (change->>'quantity_delta')::numeric < 0)
      OR
      (NULLIF(pg_catalog.btrim(change->>'workspace_id'), '')::uuid = v_destination_workspace_id
        AND NULLIF(pg_catalog.btrim(change->>'storage_id'), '')::uuid = v_destination_storage_id
        AND change->>'transfer_side' = 'destination'
        AND change->>'audit_transaction_type' = 'transfer_in'
        AND (change->>'quantity_delta')::numeric > 0)
    ), false)
  ) THEN
    RAISE EXCEPTION 'Inventory transfer movements must match source and destination storage'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        NULLIF(pg_catalog.btrim(change->>'transfer_item_id'), '') AS transfer_item_id,
        pg_catalog.count(*) AS movement_count,
        pg_catalog.count(*) FILTER (WHERE change->>'transfer_side' = 'source') AS source_count,
        pg_catalog.count(*) FILTER (WHERE change->>'transfer_side' = 'destination') AS destination_count,
        pg_catalog.count(*) FILTER (
          WHERE change->>'transfer_side' = 'source'
            AND NULLIF(pg_catalog.btrim(change->>'product_id'), '') IS DISTINCT FROM
              NULLIF(pg_catalog.btrim(change->>'transfer_item_id'), '')
        ) AS invalid_source_product_count,
        pg_catalog.sum((change->>'quantity_delta')::numeric) AS net_quantity_delta,
        pg_catalog.count(DISTINCT pg_catalog.abs((change->>'quantity_delta')::numeric)) AS distinct_quantity_count
      FROM pg_catalog.jsonb_array_elements(p_payload->'inventory_changes') AS entries(change)
      GROUP BY NULLIF(pg_catalog.btrim(change->>'transfer_item_id'), '')
    ) AS transfer_items
    WHERE transfer_item_id IS NULL
      OR movement_count <> 2
      OR source_count <> 1
      OR destination_count <> 1
      OR invalid_source_product_count <> 0
      OR net_quantity_delta <> 0
      OR distinct_quantity_count <> 1
  ) THEN
    RAISE EXCEPTION 'Each transferred product must have one matching source and destination movement'
      USING ERRCODE = '22023';
  END IF;

  v_payload_hash := pg_catalog.md5(p_payload::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-transfer-batch:' || p_operation_id::text, 0)
  );

  SELECT *
  INTO v_receipt
  FROM private.inventory_transfer_batch_receipts
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_receipt.workspace_id IS DISTINCT FROM v_workspace_id
      OR v_receipt.payload_hash IS DISTINCT FROM v_payload_hash
    THEN
      RAISE EXCEPTION 'Transfer operation id is already used by another payload'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_receipt.result || pg_catalog.jsonb_build_object('already_applied', true);
  END IF;

  INSERT INTO private.inventory_transfer_batch_counters (workspace_id, last_sequence)
  VALUES (v_workspace_id, 0)
  ON CONFLICT (workspace_id) DO NOTHING;

  UPDATE private.inventory_transfer_batch_counters
  SET last_sequence = last_sequence + 1,
      updated_at = pg_catalog.now()
  WHERE workspace_id = v_workspace_id
  RETURNING last_sequence INTO v_sequence;

  v_transfer_number := 'TRF-' || pg_catalog.lpad(
    v_sequence::text,
    GREATEST(5, pg_catalog.length(v_sequence::text)),
    '0'
  );

  INSERT INTO public.inventory_transfer_batches AS inserted_batch (
    id,
    workspace_id,
    transfer_number,
    source_workspace_id,
    source_workspace_name,
    source_storage_id,
    source_storage_name,
    destination_workspace_id,
    destination_workspace_name,
    destination_storage_id,
    destination_storage_name,
    performed_by,
    transferred_at,
    status,
    notes,
    created_at,
    updated_at,
    version,
    is_deleted
  )
  VALUES (
    v_batch_id,
    v_workspace_id,
    v_transfer_number,
    v_source_workspace_id,
    NULLIF(pg_catalog.btrim(v_batch_payload->>'source_workspace_name'), ''),
    v_source_storage_id,
    NULLIF(pg_catalog.btrim(v_batch_payload->>'source_storage_name'), ''),
    v_destination_workspace_id,
    NULLIF(pg_catalog.btrim(v_batch_payload->>'destination_workspace_name'), ''),
    v_destination_storage_id,
    NULLIF(pg_catalog.btrim(v_batch_payload->>'destination_storage_name'), ''),
    COALESCE(v_actor_id, v_created_by),
    v_transferred_at,
    'completed',
    NULLIF(pg_catalog.btrim(v_batch_payload->>'notes'), ''),
    v_transferred_at,
    v_transferred_at,
    1,
    false
  )
  RETURNING pg_catalog.to_jsonb(inserted_batch) INTO v_result;

  v_expected_transactions := pg_catalog.jsonb_array_length(p_payload->'inventory_changes');
  FOR v_workspace IN
    SELECT DISTINCT NULLIF(pg_catalog.btrim(change->>'workspace_id'), '')::uuid
    FROM pg_catalog.jsonb_array_elements(p_payload->'inventory_changes') AS entries(change)
    ORDER BY 1
  LOOP
    SELECT COALESCE(pg_catalog.jsonb_agg(change - 'workspace_id'), '[]'::jsonb)
    INTO v_workspace_changes
    FROM pg_catalog.jsonb_array_elements(p_payload->'inventory_changes') AS entries(change)
    WHERE NULLIF(pg_catalog.btrim(change->>'workspace_id'), '')::uuid = v_workspace;

    v_suboperation_id := CASE
      WHEN v_source_workspace_id = v_destination_workspace_id THEN p_operation_id
      ELSE extensions.uuid_generate_v5(
        '0a0db7f7-d2d4-4f31-9aa7-91ae4861485f'::uuid,
        p_operation_id::text || ':' || v_workspace::text
      )
    END;

    v_subresult := private.apply_inventory_snapshot_changes(
      v_suboperation_id,
      v_workspace,
      'inventory_transfer_batch',
      v_workspace_changes
    );
    v_inventory_rows := v_inventory_rows || COALESCE(v_subresult->'inventory', '[]'::jsonb);

    FOR v_transaction_json IN
      SELECT value
      FROM pg_catalog.jsonb_array_elements(COALESCE(v_subresult->'inventory_transactions', '[]'::jsonb))
    LOOP
      UPDATE public.inventory_transactions AS transaction_row
      SET transfer_batch_id = v_batch_id
      WHERE transaction_row.id = NULLIF(pg_catalog.btrim(v_transaction_json->>'id'), '')::uuid
      RETURNING transaction_row.* INTO v_transaction;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Transfer inventory movement was not saved'
          USING ERRCODE = '23503';
      END IF;
      v_transaction_rows := v_transaction_rows || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_transaction));
    END LOOP;
  END LOOP;

  IF pg_catalog.jsonb_array_length(v_transaction_rows) <> v_expected_transactions THEN
    RAISE EXCEPTION 'Transfer batch did not create every inventory movement'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_transaction_rows) AS saved(value)
    LEFT JOIN pg_catalog.jsonb_array_elements(p_payload->'inventory_changes') AS requested(change)
      ON NULLIF(pg_catalog.btrim(saved.value->>'workspace_id'), '')::uuid
          = NULLIF(pg_catalog.btrim(requested.change->>'workspace_id'), '')::uuid
      AND NULLIF(pg_catalog.btrim(saved.value->>'product_id'), '')::uuid
          = NULLIF(pg_catalog.btrim(requested.change->>'product_id'), '')::uuid
      AND NULLIF(pg_catalog.btrim(saved.value->>'storage_id'), '')::uuid
          = NULLIF(pg_catalog.btrim(requested.change->>'storage_id'), '')::uuid
    WHERE requested.change IS NULL
      OR saved.value->>'transaction_type' IS DISTINCT FROM requested.change->>'audit_transaction_type'
      OR (saved.value->>'quantity_delta')::numeric IS DISTINCT FROM (requested.change->>'quantity_delta')::numeric
      OR NULLIF(pg_catalog.btrim(saved.value->>'transfer_batch_id'), '')::uuid IS DISTINCT FROM v_batch_id
  ) THEN
    RAISE EXCEPTION 'Saved inventory movements do not match the requested transfer batch'
      USING ERRCODE = '23514';
  END IF;

  FOR v_stock_change IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_payload->'stock_batch_changes', '[]'::jsonb)) AS changes(value)
    ORDER BY
      value->'row'->>'workspace_id',
      value->'row'->>'product_id',
      value->'row'->>'storage_id',
      pg_catalog.lower(value->'row'->>'batch_number')
  LOOP
    v_stock_row := v_stock_change->'row';
    IF pg_catalog.jsonb_typeof(v_stock_row) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Stock batch change row must be an object'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_stock_id := NULLIF(pg_catalog.btrim(v_stock_row->>'id'), '')::uuid;
      v_stock_workspace_id := NULLIF(pg_catalog.btrim(v_stock_row->>'workspace_id'), '')::uuid;
      v_stock_product_id := NULLIF(pg_catalog.btrim(v_stock_row->>'product_id'), '')::uuid;
      v_stock_storage_id := NULLIF(pg_catalog.btrim(v_stock_row->>'storage_id'), '')::uuid;
      v_stock_expected_version := COALESCE((v_stock_change->>'expected_version')::integer, 0);
      v_stock_quantity := pg_catalog.round((v_stock_row->>'quantity')::numeric, 6);
      v_stock_price := COALESCE((v_stock_row->>'price')::numeric, 0);
      v_stock_cost_price := COALESCE((v_stock_row->>'cost_price')::numeric, 0);
      v_stock_currency := pg_catalog.lower(COALESCE(NULLIF(pg_catalog.btrim(v_stock_row->>'currency'), ''), 'usd'));
      v_stock_is_deleted := COALESCE((v_stock_row->>'is_deleted')::boolean, false);
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Stock batch change contains invalid identifiers or values'
          USING ERRCODE = '22023';
    END;

    IF v_stock_id IS NULL
      OR v_stock_workspace_id IS NULL
      OR v_stock_workspace_id NOT IN (v_source_workspace_id, v_destination_workspace_id)
      OR v_stock_product_id IS NULL
      OR v_stock_storage_id IS NULL
      OR v_stock_expected_version < 0
      OR v_stock_quantity IS NULL
      OR v_stock_quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_stock_quantity < 0
      OR (NOT v_stock_is_deleted AND v_stock_quantity <= 0)
      OR v_stock_price < 0
      OR v_stock_cost_price < 0
      OR v_stock_currency NOT IN ('usd', 'eur', 'iqd', 'try')
      OR NULLIF(pg_catalog.btrim(v_stock_row->>'batch_number'), '') IS NULL
    THEN
      RAISE EXCEPTION 'Stock batch change identifiers, quantity, or snapshot are invalid'
        USING ERRCODE = '22023';
    END IF;

    IF NOT (
      (v_stock_workspace_id = v_source_workspace_id AND v_stock_storage_id = v_source_storage_id)
      OR (v_stock_workspace_id = v_destination_workspace_id AND v_stock_storage_id = v_destination_storage_id)
    ) THEN
      RAISE EXCEPTION 'Stock batch storage does not match a transfer endpoint'
        USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stock-batch:' || v_stock_workspace_id::text || ':' || v_stock_product_id::text || ':'
          || v_stock_storage_id::text || ':' || pg_catalog.lower(pg_catalog.btrim(v_stock_row->>'batch_number')),
        0
      )
    );

    SELECT * INTO v_stock_current
    FROM public.stock_batches
    WHERE id = v_stock_id
    FOR UPDATE;
    IF FOUND THEN
      IF v_stock_current.workspace_id IS DISTINCT FROM v_stock_workspace_id
        OR v_stock_current.product_id IS DISTINCT FROM v_stock_product_id
        OR v_stock_current.storage_id IS DISTINCT FROM v_stock_storage_id
        OR v_stock_current.version IS DISTINCT FROM v_stock_expected_version
      THEN
        RAISE EXCEPTION 'Stock batch changed on another device; refresh and retry'
          USING ERRCODE = '40001';
      END IF;
    ELSIF v_stock_expected_version <> 0 THEN
      RAISE EXCEPTION 'Stock batch changed on another device; refresh and retry'
        USING ERRCODE = '40001';
    END IF;

    PERFORM 1
    FROM public.products
    WHERE id = v_stock_product_id
      AND workspace_id = v_stock_workspace_id
      AND COALESCE(is_service, false) = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stock batch product is not an inventory product in this workspace'
        USING ERRCODE = '23503';
    END IF;

    PERFORM 1
    FROM public.storages
    WHERE id = v_stock_storage_id
      AND workspace_id = v_stock_workspace_id
      AND COALESCE(is_deleted, false) = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stock batch storage is not active in this workspace'
        USING ERRCODE = '23503';
    END IF;

    INSERT INTO public.stock_batches (
      id, workspace_id, product_id, storage_id, batch_number, quantity,
      price, cost_price, currency, expiry_date, manufacturing_date, notes,
      source_purchase_order_id, source_purchase_order_item_id,
      created_at, updated_at, version, is_deleted
    )
    VALUES (
      v_stock_id,
      v_stock_workspace_id,
      v_stock_product_id,
      v_stock_storage_id,
      pg_catalog.btrim(v_stock_row->>'batch_number'),
      v_stock_quantity,
      v_stock_price,
      v_stock_cost_price,
      v_stock_currency,
      NULLIF(pg_catalog.btrim(v_stock_row->>'expiry_date'), '')::date,
      NULLIF(pg_catalog.btrim(v_stock_row->>'manufacturing_date'), '')::date,
      NULLIF(pg_catalog.btrim(v_stock_row->>'notes'), ''),
      NULLIF(pg_catalog.btrim(v_stock_row->>'source_purchase_order_id'), '')::uuid,
      NULLIF(pg_catalog.btrim(v_stock_row->>'source_purchase_order_item_id'), '')::uuid,
      COALESCE(NULLIF(pg_catalog.btrim(v_stock_row->>'created_at'), '')::timestamptz, pg_catalog.now()),
      v_transferred_at,
      v_stock_expected_version + 1,
      v_stock_is_deleted
    )
    ON CONFLICT (id) DO UPDATE SET
      batch_number = EXCLUDED.batch_number,
      quantity = EXCLUDED.quantity,
      price = EXCLUDED.price,
      cost_price = EXCLUDED.cost_price,
      currency = EXCLUDED.currency,
      expiry_date = EXCLUDED.expiry_date,
      manufacturing_date = EXCLUDED.manufacturing_date,
      notes = EXCLUDED.notes,
      source_purchase_order_id = EXCLUDED.source_purchase_order_id,
      source_purchase_order_item_id = EXCLUDED.source_purchase_order_item_id,
      updated_at = EXCLUDED.updated_at,
      version = EXCLUDED.version,
      is_deleted = EXCLUDED.is_deleted
    RETURNING * INTO v_stock_current;

    v_stock_rows := v_stock_rows || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_stock_current));
  END LOOP;

  FOR v_product IN
    SELECT DISTINCT
      NULLIF(pg_catalog.btrim(change->>'workspace_id'), '')::uuid AS workspace_id,
      NULLIF(pg_catalog.btrim(change->>'product_id'), '')::uuid AS product_id
    FROM pg_catalog.jsonb_array_elements(p_payload->'inventory_changes') AS entries(change)
    ORDER BY 1, 2
  LOOP
    SELECT
      pg_catalog.round(COALESCE(pg_catalog.sum(quantity) FILTER (WHERE COALESCE(is_deleted, false) = false), 0), 6),
      pg_catalog.count(*) FILTER (WHERE COALESCE(is_deleted, false) = false AND quantity > 0),
      (pg_catalog.array_agg(storage_id) FILTER (WHERE COALESCE(is_deleted, false) = false AND quantity > 0))[1]
    INTO v_product_quantity, v_active_storage_count, v_only_storage_id
    FROM public.inventory
    WHERE workspace_id = v_product.workspace_id
      AND product_id = v_product.product_id;

    UPDATE public.products AS product
    SET quantity = v_product_quantity,
        storage_id = CASE WHEN v_active_storage_count = 1 THEN v_only_storage_id ELSE NULL END,
        updated_at = v_transferred_at,
        version = COALESCE(product.version, 0) + 1
    WHERE product.id = v_product.product_id
      AND product.workspace_id = v_product.workspace_id
    RETURNING pg_catalog.to_jsonb(product) INTO v_change;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transfer product snapshot could not be updated'
        USING ERRCODE = '23503';
    END IF;
    v_product_rows := v_product_rows || pg_catalog.jsonb_build_array(v_change);
  END LOOP;

  v_result := pg_catalog.jsonb_build_object(
    'batch', v_result,
    'inventory', v_inventory_rows,
    'inventory_transactions', v_transaction_rows,
    'stock_batches', v_stock_rows,
    'products', v_product_rows,
    'already_applied', false
  );

  INSERT INTO private.inventory_transfer_batch_receipts (
    operation_id, workspace_id, payload_hash, result, actor_id
  )
  VALUES (
    p_operation_id, v_workspace_id, v_payload_hash, v_result, v_actor_id
  );

  RETURN v_result;
EXCEPTION
  WHEN serialization_failure THEN
    RETURN pg_catalog.jsonb_build_object(
      'batch', NULL,
      'inventory', NULL,
      'inventory_transactions', NULL,
      'stock_batches', NULL,
      'products', NULL,
      'already_applied', false,
      'conflict', true,
      'retry_after_ms', 5000
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_inventory_transfer_batch(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_transfer_batch(uuid, jsonb) TO authenticated, service_role;