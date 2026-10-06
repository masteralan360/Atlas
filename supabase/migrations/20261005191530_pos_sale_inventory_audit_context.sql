-- Keep the inventory audit context attached to POS sales. The 2026-09-30
-- service-name wrapper calls private.complete_sale_once directly and replaced
-- the earlier context-setting wrapper, so sale-triggered stock changes were
-- recorded as anonymous inventory_change rows.
DO $migration$
DECLARE
  function_sql text;
  marker text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('public.complete_sale(jsonb)'::regprocedure)
  INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');

  IF pg_catalog.strpos(function_sql,
       'set_config(''atlas.inventory_transaction_type'', ''sale'', true)') > 0
    AND pg_catalog.strpos(function_sql,
       'set_config(''atlas.inventory_reference_id''') > 0
    AND pg_catalog.strpos(function_sql,
       'set_config(''atlas.inventory_reference_type'', ''pos_sale'', true)') > 0 THEN
    RETURN;
  END IF;

  marker := E'  BEGIN\n    v_result := private.complete_sale_once(payload);';
  IF pg_catalog.strpos(function_sql, marker) = 0 THEN
    RAISE EXCEPTION 'complete_sale did not match the expected service-name wrapper';
  END IF;

  function_sql := pg_catalog.replace(
    function_sql,
    marker,
    E'  BEGIN\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''sale'', true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', COALESCE(v_sale_id::text, payload->>''id''), true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', ''pos_sale'', true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(auth.uid()::text, ''''), true);\n'
      || E'    v_result := private.complete_sale_once(payload);'
  );

  EXECUTE function_sql;
END;
$migration$;
