-- A stale offline count is an application conflict, not a serialization
-- failure that can succeed by retrying the unchanged operation. Use the
-- PL/pgSQL raise_exception code so generic SQLSTATE 40001 retry handlers do
-- not hot-loop a permanently stale count payload.
DO $migration$
DECLARE
  definition text;
  old_raise constant text := $old$RAISE EXCEPTION 'offline_stock_count_changed' USING ERRCODE='40001';$old$;
  new_raise constant text := $new$RAISE EXCEPTION 'offline_stock_count_changed' USING ERRCODE='P0001';$new$;
  old_count integer;
  new_count integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('public.apply_offline_stock_operation(jsonb)'::regprocedure)
    INTO definition;

  old_count := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_raise, '')))
    / pg_catalog.length(old_raise);
  new_count := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, new_raise, '')))
    / pg_catalog.length(new_raise);

  IF old_count = 0 AND new_count = 2 THEN
    RETURN;
  END IF;
  IF old_count <> 2 OR new_count <> 0 THEN
    RAISE EXCEPTION 'Unexpected offline stock count conflict guards; expected two retryable guards';
  END IF;

  definition := pg_catalog.replace(definition, old_raise, new_raise);
  IF pg_catalog.strpos(definition, old_raise) > 0
    OR (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, new_raise, '')))
      / pg_catalog.length(new_raise) <> 2 THEN
    RAISE EXCEPTION 'Offline stock count conflict guards were not changed cleanly';
  END IF;

  EXECUTE definition;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
