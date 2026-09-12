-- One-time repair for the Jumla Al-Khaleej workspace. Inventory positions are
-- the source of truth; product quantities are refreshed from those positions.
-- Historical sales, returns, transfers, batches, and transaction rows remain
-- unchanged.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $migration$
DECLARE
  v_workspace_id CONSTANT uuid := 'ec5305ba-e804-4e3e-a600-6d9692108b86'::uuid;
  v_expected_workspace_name CONSTANT text := 'جملة الخليج';
  v_actual_workspace_name text;
  v_inventory_rows_updated bigint := 0;
  v_inventory_rows_remaining bigint := 0;
  v_product_rows_remaining bigint := 0;
BEGIN
  SELECT w.name
  INTO v_actual_workspace_name
  FROM public.workspaces AS w
  WHERE w.id = v_workspace_id
  FOR KEY SHARE;

  -- Targeted production data migrations must remain replayable in empty local
  -- and preview databases, where this customer workspace does not exist.
  IF NOT FOUND THEN
    RAISE NOTICE 'Skipping Jumla Al-Khaleej inventory repair: workspace % is absent',
      v_workspace_id;
    RETURN;
  END IF;

  IF v_actual_workspace_name IS DISTINCT FROM v_expected_workspace_name THEN
    RAISE EXCEPTION 'Workspace identity mismatch for inventory repair: expected %, found %',
      v_expected_workspace_name,
      v_actual_workspace_name
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.inventory AS i
  SET
    quantity = 0,
    is_deleted = true,
    updated_at = pg_catalog.now(),
    version = COALESCE(i.version, 0) + 1
  WHERE i.workspace_id = v_workspace_id
    AND i.quantity < 0;

  GET DIAGNOSTICS v_inventory_rows_updated = ROW_COUNT;

  -- The inventory trigger refreshes affected products row by row. Refresh any
  -- remaining negative legacy product snapshots as a defensive consistency
  -- pass; the function derives their values from active inventory positions.
  PERFORM public.refresh_product_inventory_snapshot(p.id)
  FROM public.products AS p
  WHERE p.workspace_id = v_workspace_id
    AND p.quantity < 0;

  SELECT COUNT(*)
  INTO v_inventory_rows_remaining
  FROM public.inventory AS i
  WHERE i.workspace_id = v_workspace_id
    AND i.quantity < 0;

  SELECT COUNT(*)
  INTO v_product_rows_remaining
  FROM public.products AS p
  WHERE p.workspace_id = v_workspace_id
    AND p.quantity < 0;

  IF v_inventory_rows_remaining <> 0 OR v_product_rows_remaining <> 0 THEN
    RAISE EXCEPTION
      'Inventory repair failed verification: % negative inventory rows and % negative product rows remain',
      v_inventory_rows_remaining,
      v_product_rows_remaining
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE 'Jumla Al-Khaleej inventory repair completed: % inventory rows reset to zero',
    v_inventory_rows_updated;
END;
$migration$;
