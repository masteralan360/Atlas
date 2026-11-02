-- Product/storage membership uses a TEXT primary key (product UUID:storage UUID).
-- Inventory is not the only replayed table whose client identity is composite.
-- Decode lookup parameters through the whitelisted relation's row type so both
-- the pre-write lock and the final receipt use the table's actual ID type.
DO $migration$
DECLARE
  definition text;
  old_lock text := $old$EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=$1 AND workspace_id=$2%s',v_schema,v_table,
        CASE WHEN v_table IN ('inventory_transactions','inventory_transfer_batches') THEN '' ELSE ' FOR UPDATE' END)
        INTO v_current USING (v_effect->>'id')::uuid,v_workspace;$old$;
  new_lock text := $new$EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=(jsonb_populate_record(NULL::%I.%I,$1)).id AND workspace_id=$2%s',v_schema,v_table,v_schema,v_table,
        CASE WHEN v_table IN ('inventory_transactions','inventory_transfer_batches') THEN '' ELSE ' FOR UPDATE' END)
        INTO v_current USING jsonb_build_object('id',v_effect->>'id'),v_workspace;$new$;
  old_receipt text := $old$EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=$1 AND workspace_id=$2',v_schema,v_table) INTO v_row USING (v_effect->>'id')::uuid,v_workspace;$old$;
  new_receipt text := $new$EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=(jsonb_populate_record(NULL::%I.%I,$1)).id AND workspace_id=$2',v_schema,v_table,v_schema,v_table) INTO v_row USING jsonb_build_object('id',v_effect->>'id'),v_workspace;$new$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('public.apply_offline_stock_operation(jsonb)'::regprocedure)
    INTO definition;
  IF pg_catalog.strpos(definition,'atlas_offline_typed_effect_ids') > 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.strpos(definition,old_lock)=0 OR pg_catalog.strpos(definition,old_receipt)=0 THEN
    RAISE EXCEPTION 'Offline stock lookup boundaries changed; cannot install typed effect ID fix';
  END IF;
  definition := pg_catalog.replace(pg_catalog.replace(definition,old_lock,new_lock),old_receipt,new_receipt);
  definition := pg_catalog.replace(definition,
    '-- Lock and validate every requested row before any write.',
    '-- atlas_offline_typed_effect_ids: use each whitelisted relation''s declared ID type.' || E'\n  -- Lock and validate every requested row before any write.');
  IF pg_catalog.strpos(definition,old_lock)>0 OR pg_catalog.strpos(definition,old_receipt)>0
    OR pg_catalog.strpos(definition,'atlas_offline_typed_effect_ids')=0 THEN
    RAISE EXCEPTION 'Offline stock typed effect ID fix was not applied cleanly';
  END IF;
  EXECUTE definition;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
