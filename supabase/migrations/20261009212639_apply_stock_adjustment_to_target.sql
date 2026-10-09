-- Apply a manual stock adjustment to an absolute target while preserving the
-- existing atomic inventory/ledger write and idempotent transaction behavior.
CREATE OR REPLACE FUNCTION public.apply_stock_adjustment_to_target(
  p_transaction jsonb,
  p_target_quantity numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_transaction_id uuid;
  v_workspace_id uuid;
  v_product_id uuid;
  v_storage_id uuid;
  v_target_quantity numeric;
  v_previous_quantity numeric;
  v_delta numeric;
  v_adjustment_reason text;
  v_current_role text;
  v_existing_transaction public.inventory_transactions%ROWTYPE;
  v_inventory public.inventory%ROWTYPE;
  v_effective_transaction jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required'
      USING ERRCODE = '42501';
  END IF;

  IF p_transaction IS NULL OR pg_catalog.jsonb_typeof(p_transaction) <> 'object' THEN
    RAISE EXCEPTION 'Stock adjustment payload must be an object'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_transaction_id := NULLIF(pg_catalog.btrim(p_transaction->>'id'), '')::uuid;
    v_workspace_id := NULLIF(pg_catalog.btrim(p_transaction->>'workspace_id'), '')::uuid;
    v_product_id := NULLIF(pg_catalog.btrim(p_transaction->>'product_id'), '')::uuid;
    v_storage_id := NULLIF(pg_catalog.btrim(p_transaction->>'storage_id'), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Stock adjustment payload contains an invalid identifier'
        USING ERRCODE = '22023';
  END;

  IF v_transaction_id IS NULL
    OR v_workspace_id IS NULL
    OR v_product_id IS NULL
    OR v_storage_id IS NULL
  THEN
    RAISE EXCEPTION 'Stock adjustment identifiers are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_target_quantity IS NULL
    OR p_target_quantity::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_target_quantity < 0
  THEN
    RAISE EXCEPTION 'Target stock quantity must be a finite non-negative value'
      USING ERRCODE = '22023';
  END IF;

  v_target_quantity := pg_catalog.round(p_target_quantity, 6);
  IF pg_catalog.abs(v_target_quantity) <= 0.0000005 THEN
    v_target_quantity := 0;
  END IF;

  v_current_role := public.current_user_role();
  IF v_workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR v_current_role IS NULL
    OR v_current_role NOT IN ('admin', 'staff')
  THEN
    RAISE EXCEPTION 'You are not allowed to adjust stock in this workspace'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.products
  WHERE id = v_product_id
    AND workspace_id = v_workspace_id
    AND COALESCE(is_deleted, false) = false
    AND COALESCE(is_service, false) = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock adjustment product is not an active inventory item in this workspace'
      USING ERRCODE = '23503';
  END IF;

  PERFORM 1
  FROM public.storages
  WHERE id = v_storage_id
    AND workspace_id = v_workspace_id
    AND COALESCE(is_deleted, false) = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock adjustment storage is not active in this workspace'
      USING ERRCODE = '23503';
  END IF;

  IF p_transaction->>'transaction_type' IS DISTINCT FROM 'stock_adjustment' THEN
    RAISE EXCEPTION 'Only stock adjustments are accepted'
      USING ERRCODE = '22023';
  END IF;

  v_adjustment_reason := NULLIF(pg_catalog.btrim(p_transaction->>'adjustment_reason'), '');
  IF v_adjustment_reason IS NULL OR v_adjustment_reason NOT IN (
    'purchase',
    'return',
    'correction',
    'damage',
    'theft',
    'expired',
    'production',
    'other'
  ) THEN
    RAISE EXCEPTION 'Stock adjustment reason is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Acquire locks in the same order as apply_stock_adjustment.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stock-adjustment:' || v_transaction_id::text, 0)
  );

  SELECT *
  INTO v_existing_transaction
  FROM public.inventory_transactions
  WHERE id = v_transaction_id;

  IF FOUND THEN
    IF v_existing_transaction.workspace_id IS DISTINCT FROM v_workspace_id
      OR v_existing_transaction.product_id IS DISTINCT FROM v_product_id
      OR v_existing_transaction.storage_id IS DISTINCT FROM v_storage_id
      OR v_existing_transaction.transaction_type IS DISTINCT FROM 'stock_adjustment'
      OR pg_catalog.round(v_existing_transaction.new_quantity, 6) IS DISTINCT FROM v_target_quantity
      OR v_existing_transaction.adjustment_reason IS DISTINCT FROM v_adjustment_reason
    THEN
      RAISE EXCEPTION 'Stock adjustment id is already used by another operation'
        USING ERRCODE = '23505';
    END IF;

    SELECT *
    INTO v_inventory
    FROM public.inventory
    WHERE workspace_id = v_workspace_id
      AND product_id = v_product_id
      AND storage_id = v_storage_id;

    RETURN pg_catalog.jsonb_build_object(
      'transaction', pg_catalog.to_jsonb(v_existing_transaction),
      'inventory', pg_catalog.to_jsonb(v_inventory),
      'already_applied', true
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'inventory:' || v_workspace_id::text || ':' || v_product_id::text || ':' || v_storage_id::text,
      0
    )
  );

  SELECT *
  INTO v_inventory
  FROM public.inventory
  WHERE workspace_id = v_workspace_id
    AND product_id = v_product_id
    AND storage_id = v_storage_id
  FOR UPDATE;

  v_previous_quantity := CASE
    WHEN FOUND AND COALESCE(v_inventory.is_deleted, false) = false
      THEN pg_catalog.round(COALESCE(v_inventory.quantity, 0), 6)
    ELSE 0::numeric
  END;
  v_delta := pg_catalog.round(v_target_quantity - v_previous_quantity, 6);

  IF pg_catalog.abs(v_delta) <= 0.0000005 THEN
    RAISE EXCEPTION 'Stock is already at the requested quantity'
      USING ERRCODE = '23514';
  END IF;

  v_effective_transaction := p_transaction || pg_catalog.jsonb_build_object(
    'quantity_delta', v_delta,
    'previous_quantity', v_previous_quantity,
    'new_quantity', v_target_quantity
  );

  RETURN public.apply_stock_adjustment(v_effective_transaction);
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_stock_adjustment_to_target(jsonb, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_stock_adjustment_to_target(jsonb, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_stock_adjustment_to_target(jsonb, numeric) TO authenticated, service_role;
