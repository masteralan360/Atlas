-- The marketplace delivery function previously used an INSERT ... ON CONFLICT
-- to deduct an existing inventory position. The inventory deficit trigger runs
-- before conflict resolution, so it rejected the proposed negative INSERT even
-- when the existing row had sufficient stock. Replace that branch with a
-- direct UPDATE of the row already locked by the function.
DO $migration$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  )
  INTO definition;

  IF definition IS NULL
    OR position('v_inventory_quantity' IN definition) = 0
  THEN
    RAISE EXCEPTION
      'Expected marketplace delivery inventory procedure revision is not installed; existing-stock deduction was not applied.';
  END IF;

  -- The linked database may have received this repair directly before its
  -- migration history is reconciled. Leave the already-correct procedure
  -- untouched so a later normal migration run can record this file safely.
  IF position('IF NOT FOUND OR COALESCE(v_inventory_quantity, 0) < v_requested_qty THEN' IN definition) > 0
    AND position('quantity = COALESCE(quantity, 0) - v_requested_qty' IN definition) > 0
    AND position('ON CONFLICT (workspace_id, product_id, storage_id)' IN definition) = 0
  THEN
    RETURN;
  END IF;

  IF position('ON CONFLICT (workspace_id, product_id, storage_id)' IN definition) = 0 THEN
    RAISE EXCEPTION
      'Marketplace delivery inventory procedure has an unsupported deduction revision.';
  END IF;

  -- A missing position must fail before the delivery transaction changes the
  -- marketplace order or creates its sales order. This check also makes the
  -- insufficient-stock outcome explicit instead of relying on the inventory
  -- trigger to reject the later write.
  updated_definition := regexp_replace(
    definition,
    $regex$IF COALESCE\(v_inventory_quantity, 0\) < v_requested_qty THEN\s+
        v_warning_messages := array_append\(\s+
          v_warning_messages,\s+
          format\('Inventory for %s will go negative after delivery', COALESCE\(NULLIF\(v_item->>'name', ''\), v_product_id::text\)\)\s+
        \);\s+
      END IF;$regex$,
    $replacement$IF NOT FOUND OR COALESCE(v_inventory_quantity, 0) < v_requested_qty THEN
        RAISE EXCEPTION 'Insufficient inventory for % in storage %',
          COALESCE(NULLIF(v_item->>'name', ''), v_product_id::text),
          v_resolved_storage_id
          USING ERRCODE = '23514';
      END IF;$replacement$,
    'n'
  );

  IF updated_definition IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION
      'Marketplace delivery insufficient-inventory guard could not be updated.';
  END IF;

  definition := updated_definition;
  updated_definition := regexp_replace(
    definition,
    $regex$INSERT INTO public\.inventory[\s\S]*?ON CONFLICT\s*\(\s*workspace_id\s*,\s*product_id\s*,\s*storage_id\s*\)[\s\S]*?is_deleted\s*=\s*false;$regex$,
    $replacement$UPDATE public.inventory
      SET
        quantity = COALESCE(quantity, 0) - v_requested_qty,
        updated_at = timezone('utc', now()),
        version = COALESCE(version, 0) + 1,
        is_deleted = false
      WHERE workspace_id = v_order.workspace_id
        AND product_id = v_product_id
        AND storage_id = v_resolved_storage_id;$replacement$,
    'n'
  );

  IF updated_definition IS NOT DISTINCT FROM definition
    OR position('ON CONFLICT (workspace_id, product_id, storage_id)' IN updated_definition) > 0
    OR position('UPDATE public.inventory' IN updated_definition) = 0
  THEN
    RAISE EXCEPTION
      'Marketplace delivery inventory deduction could not be updated.';
  END IF;

  EXECUTE updated_definition;
END;
$migration$;
