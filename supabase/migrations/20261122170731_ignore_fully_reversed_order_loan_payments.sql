-- Financing edits are blocked only by loan/order payments with a remaining
-- unreversed balance. Keep immutable payment and reversal rows for audit.
DO $patch_financed_order_payment_history$
DECLARE
  function_sql text;
  old_guard constant text := $old$
  IF EXISTS (
    SELECT 1 FROM public.loan_payments payment
    WHERE payment.workspace_id = v_workspace_id AND payment.loan_id = p_loan_id
      AND NOT COALESCE(payment.is_deleted, false)
  ) OR EXISTS (
    SELECT 1 FROM public.payment_transactions transaction
    WHERE transaction.workspace_id = v_workspace_id
      AND NOT COALESCE(transaction.is_deleted, false)
      AND (
        (transaction.source_module = 'loans' AND transaction.source_record_id = p_loan_id)
        OR (transaction.source_type = 'sales_order' AND transaction.source_record_id = p_order_id)
      )
  ) THEN
    RAISE EXCEPTION 'financed_order_has_payment_history' USING ERRCODE = '23514';
  END IF;
$old$;
  new_guard constant text := $new$
  IF EXISTS (
    SELECT 1 FROM public.loan_payments payment
    WHERE payment.workspace_id = v_workspace_id AND payment.loan_id = p_loan_id
      AND NOT COALESCE(payment.is_deleted, false)
      AND GREATEST(
        ABS(COALESCE(payment.amount, 0)) - ABS(COALESCE(payment.reversed_amount, 0)),
        0
      ) > 0.0005
  ) OR EXISTS (
    SELECT 1
    FROM public.payment_transactions transaction
    WHERE transaction.workspace_id = v_workspace_id
      AND NOT COALESCE(transaction.is_deleted, false)
      AND transaction.void_id IS NULL
      AND transaction.reversal_of_transaction_id IS NULL
      AND (
        (transaction.source_module = 'loans' AND transaction.source_record_id = p_loan_id)
        OR (transaction.source_type = 'sales_order' AND transaction.source_record_id = p_order_id)
      )
      AND GREATEST(
        ABS(COALESCE(transaction.amount, 0)) - COALESCE((
          SELECT sum(ABS(reversal.amount))
          FROM public.payment_transactions reversal
          WHERE reversal.reversal_of_transaction_id = transaction.id
            AND reversal.workspace_id = v_workspace_id
            AND NOT COALESCE(reversal.is_deleted, false)
            AND reversal.void_id IS NULL
        ), 0),
        0
      ) > 0.0005
  ) THEN
    RAISE EXCEPTION 'financed_order_has_payment_history' USING ERRCODE = '23514';
  END IF;
$new$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(routine.oid)
  INTO function_sql
  FROM pg_catalog.pg_proc AS routine
  WHERE routine.oid = 'public.update_pending_financed_sales_order(uuid,uuid,bigint,bigint,uuid,jsonb,uuid[])'::regprocedure;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Pending financed Sales Order update RPC was not found';
  END IF;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');

  IF pg_catalog.strpos(function_sql, 'reversal.reversal_of_transaction_id = transaction.id') > 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.strpos(function_sql, old_guard) = 0 THEN
    RAISE EXCEPTION 'Financed Sales Order payment history guard did not match expected source';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_guard, new_guard);
  IF pg_catalog.strpos(function_sql, 'reversal.reversal_of_transaction_id = transaction.id') = 0
    OR pg_catalog.strpos(function_sql, 'financed_order_has_payment_history') = 0
  THEN
    RAISE EXCEPTION 'Financed Sales Order reversal-aware payment guard patch failed';
  END IF;
  EXECUTE function_sql;
END;
$patch_financed_order_payment_history$;

NOTIFY pgrst, 'reload schema';
