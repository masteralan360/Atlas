-- Preserve regular reservations without blocking sales that consume only batch stock.
CREATE OR REPLACE FUNCTION private.complete_sales_order_with_inventory(
  p_order_id uuid,
  p_workspace_id uuid,
  p_expected_order_version bigint,
  p_operation_id uuid,
  p_items jsonb,
  p_actual_delivery_date timestamptz,
  p_changes jsonb,
  p_batch_versions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  completion jsonb;
  completed_order jsonb;
  replay boolean;
  source_storage uuid;
  demand record;
  batch public.stock_batches%ROWTYPE;
  batches jsonb := '[]'::jsonb;
  processed integer := 0;
BEGIN
  IF pg_catalog.jsonb_typeof(p_batch_versions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Sales order batch versions are invalid' USING ERRCODE = '22023';
  END IF;

  -- This also checks workspace and role, locks the order and inventory, and
  -- validates the items against the saved pending order.
  completion := private.complete_sales_order_with_inventory(
    p_order_id, p_workspace_id, p_expected_order_version, p_operation_id,
    p_items, p_actual_delivery_date, p_changes
  );
  IF COALESCE((completion->>'conflict')::boolean, false) THEN
    RETURN completion;
  END IF;
  completed_order := completion->'order';
  replay := COALESCE((completion->>'already_applied')::boolean, false);
  source_storage := NULLIF(completed_order->>'source_storage_id', '')::uuid;

  IF auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(completion->'inventory') AS pos(storage_id uuid)
    WHERE NOT COALESCE(public.current_user_can_access_storage(p_workspace_id, pos.storage_id), false)
  ) THEN
    RAISE EXCEPTION 'Sales order inventory storage is unavailable' USING ERRCODE = '42501';
  END IF;

  IF NOT replay AND EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(completed_order->'items') AS line(item)
    JOIN public.products product ON product.id = (line.item->>'productId')::uuid
      AND product.workspace_id = p_workspace_id AND NOT COALESCE(product.is_service, false)
    CROSS JOIN LATERAL private.order_stock_requirements(pg_catalog.jsonb_build_array(line.item), source_storage) required
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM((entry->>'quantity')::numeric), 0) AS quantity,
        COALESCE(bool_or(
          NULLIF(entry->>'batchId', '') IS NULL OR (entry->>'quantity') IS NULL
          OR (entry->>'quantity')::numeric <= 0
          OR (entry->>'quantity')::numeric::text IN ('NaN', 'Infinity', '-Infinity')
          OR line.item->>'stockSourceType' = 'regular'
          OR (line.item->>'stockSourceType' = 'batch' AND entry->>'batchId' IS DISTINCT FROM line.item->>'stockSourceBatchId')
        ), false) AS invalid
      FROM pg_catalog.jsonb_array_elements(COALESCE(NULLIF(line.item->'batchAllocations', 'null'::jsonb), '[]'::jsonb)) entry
    ) allocated
    WHERE allocated.invalid OR allocated.quantity > required.quantity
      OR (line.item->>'stockSourceType' = 'batch' AND allocated.quantity = 0)
  ) THEN
    RAISE EXCEPTION 'Sales order batch allocations are invalid' USING ERRCODE = '22023';
  END IF;

  FOR demand IN
    SELECT source.batch_id, source.product_id, source.storage_id, source.quantity,
      (SELECT expected.version FROM pg_catalog.jsonb_to_recordset(p_batch_versions) AS expected(id uuid, version integer)
       WHERE expected.id = source.batch_id) AS expected_version
    FROM private.order_stock_source_demands(completed_order->'items', source_storage) source
    JOIN public.products product ON product.id = source.product_id
      AND product.workspace_id = p_workspace_id AND NOT COALESCE(product.is_service, false)
    WHERE source.source_type = 'batch'
    ORDER BY source.batch_id
  LOOP
    IF replay THEN
      SELECT * INTO batch FROM public.stock_batches
      WHERE id = demand.batch_id AND workspace_id = p_workspace_id
        AND product_id = demand.product_id AND storage_id = demand.storage_id;
      IF NOT FOUND THEN CONTINUE; END IF;
    ELSE
      UPDATE public.stock_batches
      SET quantity = pg_catalog.round(quantity - demand.quantity, 6),
          is_deleted = pg_catalog.round(quantity - demand.quantity, 6) = 0,
          version = version + 1,
          updated_at = pg_catalog.now()
      WHERE id = demand.batch_id AND workspace_id = p_workspace_id
        AND product_id = demand.product_id AND storage_id = demand.storage_id
        AND NOT is_deleted AND version = demand.expected_version AND quantity >= demand.quantity
      RETURNING * INTO batch;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Sales order batch changed before completion' USING ERRCODE = '40001';
      END IF;
    END IF;
    processed := processed + 1;
    batches := batches || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(batch));
  END LOOP;

  IF NOT replay AND processed <> pg_catalog.jsonb_array_length(p_batch_versions) THEN
    RAISE EXCEPTION 'Sales order batch versions do not match the allocations' USING ERRCODE = '22023';
  END IF;

  -- A batch-only deduction reduces on-hand stock and batch stock equally.
  -- Enforce the remaining regular reservations on positions where this sale
  -- takes regular stock, including the regular portion of a mixed line.
  IF NOT replay AND EXISTS (
    WITH batch_usage AS (
      SELECT source.product_id, source.storage_id, SUM(source.quantity) AS quantity
      FROM private.order_stock_source_demands(completed_order->'items', source_storage) source
      WHERE source.source_type = 'batch'
      GROUP BY source.product_id, source.storage_id
    )
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(completion->'inventory') AS pos(product_id uuid, storage_id uuid, quantity numeric)
    JOIN private.order_stock_requirements(completed_order->'items', source_storage) fulfilled USING (product_id, storage_id)
    LEFT JOIN batch_usage used USING (product_id, storage_id)
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(b.quantity), 0) AS quantity FROM public.stock_batches b
      WHERE b.workspace_id = p_workspace_id AND b.product_id = pos.product_id AND b.storage_id = pos.storage_id AND NOT b.is_deleted
    ) batched
    WHERE fulfilled.quantity - COALESCE(used.quantity, 0) > 0.0000005
      AND pos.quantity - batched.quantity + 0.0000005 < private.reserved_stock_source(
        p_workspace_id, pos.product_id, pos.storage_id, 'regular', NULL, NULL
      )
  ) THEN
    RAISE EXCEPTION 'Regular stock changed before completion' USING ERRCODE = '40001';
  END IF;

  IF replay THEN
    -- The original receipt may predate later stock movements on the same position.
    completion := completion || pg_catalog.jsonb_build_object('inventory', (
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(current_stock)), '[]'::jsonb)
      FROM pg_catalog.jsonb_to_recordset(completion->'inventory') AS receipt(product_id uuid, storage_id uuid)
      JOIN public.inventory current_stock ON current_stock.workspace_id = p_workspace_id
        AND current_stock.product_id = receipt.product_id AND current_stock.storage_id = receipt.storage_id
    ));
  END IF;
  RETURN completion || pg_catalog.jsonb_build_object('stock_batches', batches);
EXCEPTION WHEN serialization_failure OR deadlock_detected THEN
  -- The exception block rolls back the order, movement, receipt, and batches together.
  RETURN pg_catalog.jsonb_build_object('conflict', true, 'conflict_reason', 'inventory_version');
END;
$function$;
