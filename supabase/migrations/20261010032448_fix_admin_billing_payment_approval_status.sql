-- The legacy payment reviewer returns the resulting transaction status but
-- does not include a `success` flag. Billing Operations used to treat that
-- missing key as a failed approval and roll back the entire transaction.
DO $migration$
DECLARE
  v_definition text;
  v_old text := $old$
    IF COALESCE((v_paid->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'billing_payment_not_approved' USING ERRCODE = '23514';
    END IF;
$old$;
  v_new text := $new$
    IF v_paid->>'status' IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'billing_payment_not_approved' USING ERRCODE = '23514';
    END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'billing.apply_admin_billing_snapshot(uuid,text,jsonb,text,boolean,uuid)'::regprocedure
  )
  INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'admin_billing_snapshot_function_missing';
  END IF;

  v_definition := replace(v_definition, E'\r\n', E'\n');
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'admin_billing_payment_approval_check_anchor_not_found';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
