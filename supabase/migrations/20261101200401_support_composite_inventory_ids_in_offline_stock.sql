-- Inventory rows created by older local migrations may use
-- "product-uuid:storage-uuid" as their client-side key. The server identifies
-- inventory by workspace/product/storage and assigns the authoritative UUID.
DO $migration$
DECLARE
  definition text;
  marker text := '-- atlas_offline_read_only_audit: canonical RPCs own audit writes and locking.';
  marker_position integer;
  statement_offset integer;
  statement_start integer;
  statement_length integer;
  statement_end integer;
  original_statement text;
  replacement_statement text := $replacement$
    IF v_table='inventory' AND (
      v_effect->>'id' IS NULL
      OR (v_effect->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND v_effect->>'id' IS DISTINCT FROM (
          (COALESCE(v_after,v_before)->>'product_id')||':'||(COALESCE(v_after,v_before)->>'storage_id')
        ))
    ) THEN
      RAISE EXCEPTION 'offline_stock_inventory_identity_invalid' USING ERRCODE='23514';
    END IF;
    IF v_table='inventory' THEN
      SELECT to_jsonb(row) INTO v_current
      FROM public.inventory row
      WHERE row.workspace_id=v_workspace
        AND row.product_id=(COALESCE(v_after,v_before)->>'product_id')::uuid
        AND row.storage_id=(COALESCE(v_after,v_before)->>'storage_id')::uuid
      FOR UPDATE;
    ELSE
      EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=$1 AND workspace_id=$2%s',v_schema,v_table,
        CASE WHEN v_table IN ('inventory_transactions','inventory_transfer_batches') THEN '' ELSE ' FOR UPDATE' END)
        INTO v_current USING (v_effect->>'id')::uuid,v_workspace;
    END IF;
  $replacement$;
  old_inventory_id text := $old$COALESCE(v_inventory.id,(v_after->>'id')::uuid)$old$;
  new_inventory_id text := $new$COALESCE(
        v_inventory.id,
        CASE
          WHEN (v_after->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (v_after->>'id')::uuid
          ELSE pg_catalog.gen_random_uuid()
        END
      )$new$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('public.apply_offline_stock_operation(jsonb)'::regprocedure)
  INTO definition;

  IF pg_catalog.strpos(definition, 'atlas_offline_inventory_position_ids') > 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.strpos(definition, marker) = 0
    OR pg_catalog.strpos(definition, old_inventory_id) = 0 THEN
    RAISE EXCEPTION 'Offline stock function changed; cannot install composite inventory ID fix';
  END IF;

  marker_position := pg_catalog.strpos(definition, marker);
  statement_offset := pg_catalog.strpos(pg_catalog.substr(definition, marker_position), 'EXECUTE format(');
  IF statement_offset = 0 THEN
    RAISE EXCEPTION 'Offline stock inventory lookup changed; cannot install composite inventory ID fix';
  END IF;
  statement_start := marker_position + statement_offset - 1;
  statement_offset := pg_catalog.strpos(pg_catalog.substr(definition, statement_start), ';');
  IF statement_offset = 0 THEN
    RAISE EXCEPTION 'Offline stock inventory lookup is incomplete';
  END IF;
  statement_end := statement_start + statement_offset - 1;
  statement_length := statement_end - statement_start + 1;
  original_statement := pg_catalog.substr(definition, statement_start, statement_length);
  IF pg_catalog.strpos(original_statement, '(v_effect->>''id'')::uuid') = 0 THEN
    RAISE EXCEPTION 'Offline stock inventory lookup no longer casts effect IDs as expected';
  END IF;

  definition := pg_catalog.substr(definition, 1, statement_start - 1)
    || replacement_statement
    || pg_catalog.substr(definition, statement_end + 1);
  definition := pg_catalog.replace(definition, old_inventory_id, new_inventory_id);
  IF pg_catalog.strpos(definition, old_inventory_id) > 0 THEN
    RAISE EXCEPTION 'Offline stock composite inventory ID fix was not applied cleanly';
  END IF;

  definition := pg_catalog.replace(
    definition,
    marker,
    marker || E'\n    -- atlas_offline_inventory_position_ids: inventory uses product/storage identity.'
  );
  EXECUTE definition;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
