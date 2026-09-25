-- POS can sell fractional quantities at negotiated prices. The checkout RPC
-- stores the exact payload total, while the old numeric(10,2) sale columns
-- silently rounded it and left the unrestricted payment amount unchanged.
ALTER TABLE public.sales
  ALTER COLUMN total_amount TYPE numeric;

ALTER TABLE public.sale_items
  ALTER COLUMN unit_price TYPE numeric,
  ALTER COLUMN total_price TYPE numeric;

-- A stock batch has nullable metadata. PostgreSQL's composite IS NOT NULL
-- only succeeds when every field is non-null, so the return RPC could insert
-- a second active batch even after selecting the existing row by ID.
DO $patch_return_batch$
DECLARE
  function_sql text;
BEGIN
  SELECT pg_get_functiondef('public.process_sale_return(uuid, uuid, jsonb, text, text)'::regprocedure)
  INTO function_sql;

  IF position('IF v_target_batch_record.id IS NULL THEN' IN function_sql) > 0
     AND position('IF v_target_batch_record.id IS NOT NULL THEN' IN function_sql) > 0 THEN
    RETURN;
  END IF;

  IF position('IF v_target_batch_record IS NULL THEN' IN function_sql) = 0
     OR position('IF v_target_batch_record IS NOT NULL THEN' IN function_sql) = 0 THEN
    RAISE EXCEPTION 'process_sale_return has an unexpected stock batch implementation';
  END IF;

  function_sql := replace(function_sql,
    'IF v_target_batch_record IS NULL THEN',
    'IF v_target_batch_record.id IS NULL THEN');
  function_sql := replace(function_sql,
    'IF v_target_batch_record IS NOT NULL THEN',
    'IF v_target_batch_record.id IS NOT NULL THEN');
  EXECUTE function_sql;
END;
$patch_return_batch$;

NOTIFY pgrst, 'reload schema';
