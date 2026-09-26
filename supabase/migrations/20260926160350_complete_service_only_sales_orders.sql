-- Sales orders containing only service products still need the atomic server
-- completion write. Allow an empty inventory delta and persist an idempotency
-- receipt so a retry after a lost response returns the completed order.

DO $service_only_order_completion$
DECLARE
  function_definition text;
  empty_changes_guard constant text := $empty_changes_guard$
    OR pg_catalog.jsonb_array_length(p_changes) = 0
$empty_changes_guard$;
  stock_apply_block constant text := $stock_apply_block$
  v_stock_result := private.apply_inventory_snapshot_changes(
    p_operation_id,
    p_workspace_id,
    'sales_order_completion',
    p_changes
  );
  v_inventory_rows := v_stock_result->'inventory';
$stock_apply_block$;
  stock_apply_replacement constant text := $stock_apply_replacement$
  IF pg_catalog.jsonb_array_length(p_changes) = 0 THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_order.items) AS line(item)
      LEFT JOIN public.products AS product
        ON product.id = NULLIF(line.item->>'productId', '')::uuid
       AND product.workspace_id = p_workspace_id
      WHERE product.id IS NULL
        OR COALESCE(product.is_deleted, false)
        OR NOT COALESCE(product.is_service, false)
    ) THEN
      RAISE EXCEPTION 'Sales order without inventory changes must contain only active service products'
        USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('inventory-operation:' || p_operation_id::text, 0)
    );

    SELECT *
    INTO v_receipt
    FROM private.inventory_snapshot_receipts AS receipt
    WHERE receipt.operation_id = p_operation_id;

    IF FOUND THEN
      IF v_receipt.workspace_id IS DISTINCT FROM p_workspace_id
        OR v_receipt.operation_kind IS DISTINCT FROM 'sales_order_completion'
        OR v_receipt.payload_hash IS DISTINCT FROM pg_catalog.md5(
          p_workspace_id::text || ':sales_order_completion:' || p_changes::text
        )
      THEN
        RAISE EXCEPTION 'Inventory operation id is already used by another payload'
          USING ERRCODE = '23505';
      END IF;

      v_stock_result := v_receipt.result
        || pg_catalog.jsonb_build_object('already_applied', true);
    ELSE
      v_stock_result := pg_catalog.jsonb_build_object(
        'operation_id', p_operation_id,
        'inventory', '[]'::jsonb,
        'already_applied', false
      );

      INSERT INTO private.inventory_snapshot_receipts (
        operation_id,
        workspace_id,
        operation_kind,
        payload_hash,
        result,
        actor_id
      )
      VALUES (
        p_operation_id,
        p_workspace_id,
        'sales_order_completion',
        pg_catalog.md5(
          p_workspace_id::text || ':sales_order_completion:' || p_changes::text
        ),
        v_stock_result,
        auth.uid()
      );
    END IF;
  ELSE
    v_stock_result := private.apply_inventory_snapshot_changes(
      p_operation_id,
      p_workspace_id,
      'sales_order_completion',
      p_changes
    );
  END IF;
  v_inventory_rows := v_stock_result->'inventory';
$stock_apply_replacement$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'private.complete_sales_order_with_inventory(uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb)'::regprocedure
  )
  INTO function_definition;

  IF pg_catalog.strpos(function_definition, empty_changes_guard) = 0 THEN
    RAISE EXCEPTION 'Sales order completion empty-change validation did not match';
  END IF;

  IF pg_catalog.strpos(function_definition, stock_apply_block) = 0 THEN
    RAISE EXCEPTION 'Sales order completion inventory apply block did not match';
  END IF;

  function_definition := pg_catalog.replace(
    function_definition,
    empty_changes_guard,
    ''
  );
  function_definition := pg_catalog.replace(
    function_definition,
    stock_apply_block,
    stock_apply_replacement
  );

  EXECUTE function_definition;
END;
$service_only_order_completion$;

NOTIFY pgrst, 'reload schema';
