-- Audit rows and transfer receipts are written only by their canonical RPCs.
-- SELECT FOR UPDATE requires UPDATE privilege even when no row exists; the
-- replay executor deliberately has SELECT-only access to these two tables.
-- Keep mutable business-row locks and existing RLS/receipt permissions intact.
DO $migration$
DECLARE
  definition text;
  original text := $old$EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=$1 AND workspace_id=$2 FOR UPDATE',v_schema,v_table)$old$;
  replacement text := $new$-- atlas_offline_read_only_audit: canonical RPCs own audit writes and locking.
    EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=$1 AND workspace_id=$2%s',v_schema,v_table,
      CASE WHEN v_table IN ('inventory_transactions','inventory_transfer_batches') THEN '' ELSE ' FOR UPDATE' END)$new$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('public.apply_offline_stock_operation(jsonb)'::regprocedure) INTO definition;
  IF pg_catalog.strpos(definition,'atlas_offline_read_only_audit') > 0 THEN RETURN; END IF;
  IF pg_catalog.strpos(definition,original) = 0 THEN
    RAISE EXCEPTION 'Offline stock validation boundary changed; cannot install read-only audit fix';
  END IF;
  EXECUTE pg_catalog.replace(definition,original,replacement);
END;
$migration$;

NOTIFY pgrst,'reload schema';
