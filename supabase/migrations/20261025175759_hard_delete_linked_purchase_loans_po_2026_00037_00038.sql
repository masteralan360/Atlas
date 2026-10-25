-- Permanently remove the two unpaid simple loans linked to the deleted
-- purchase orders. Abort if any posted payment or other financial reference
-- exists; remove their installment schedules with the loan rows.
DO $hard_delete_linked_purchase_loans$
DECLARE
  v_loan_ids uuid[];
  v_loan_numbers text[];
  v_deleted_installment_count integer;
  v_deleted_loan_count integer;
BEGIN
  WITH target_loans AS MATERIALIZED (
    SELECT
      loan.id,
      loan.loan_no,
      loan.source,
      loan.order_type,
      loan.direction,
      loan.loan_category,
      loan.status,
      loan.principal_amount,
      loan.total_paid_amount,
      loan.balance_amount
    FROM public.loans AS loan
    WHERE loan.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND loan.loan_no = ANY (
        ARRAY['SL-20261017-A90560', 'SL-20261018-35B9C0']::text[]
      )
    FOR UPDATE
  )
  SELECT
    COALESCE(array_agg(target_loans.id ORDER BY target_loans.loan_no), ARRAY[]::uuid[]),
    COALESCE(array_agg(target_loans.loan_no ORDER BY target_loans.loan_no), ARRAY[]::text[])
  INTO v_loan_ids, v_loan_numbers
  FROM target_loans;

  IF v_loan_numbers IS DISTINCT FROM ARRAY[
    'SL-20261017-A90560', 'SL-20261018-35B9C0'
  ]::text[] THEN
    RAISE EXCEPTION
      'Expected exactly the two specified purchase loans in workspace 0b342f6c-bcdc-45a9-bcda-9d21360ff3c9; found %',
      array_to_string(v_loan_numbers, ', ');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.loans AS loan
    WHERE loan.id = ANY (v_loan_ids)
      AND loan.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND (
        loan.source IS DISTINCT FROM 'order'
        OR loan.order_type IS DISTINCT FROM 'purchase'
        OR loan.direction IS DISTINCT FROM 'borrowed'
        OR loan.loan_category IS DISTINCT FROM 'simple'
        OR loan.status IS DISTINCT FROM 'active'
        OR COALESCE(loan.total_paid_amount, 0) <> 0
        OR COALESCE(loan.balance_amount, 0) <> COALESCE(loan.principal_amount, 0)
      )
  ) THEN
    RAISE EXCEPTION 'A target purchase loan no longer has the expected unpaid active state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.loan_installments AS installment
    WHERE installment.loan_id = ANY (v_loan_ids)
    GROUP BY installment.loan_id
    HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM public.loans AS loan
    WHERE loan.id = ANY (v_loan_ids)
      AND (SELECT count(*) FROM public.loan_installments AS installment WHERE installment.loan_id = loan.id) <> 1
  ) THEN
    RAISE EXCEPTION 'Expected exactly one installment schedule row for each target loan';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loan_payments AS payment
    WHERE payment.loan_id = ANY (v_loan_ids)
  ) THEN
    RAISE EXCEPTION 'Target loans have payment records; refusing to delete financial history';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.payment_transactions AS transaction
    WHERE transaction.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND (
        transaction.source_record_id = ANY (v_loan_ids)
        OR transaction.source_subrecord_id = ANY (v_loan_ids)
      )
  ) THEN
    RAISE EXCEPTION 'Target loans have payment transactions; refusing to delete financial history';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sale_product_exchanges AS exchange
    WHERE exchange.loan_id = ANY (v_loan_ids)
  ) OR EXISTS (
    SELECT 1 FROM crm.sales_orders AS sales_order
    WHERE sales_order.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND sales_order.linked_loan_id = ANY (v_loan_ids)
  ) OR EXISTS (
    SELECT 1 FROM crm.purchase_orders AS purchase_order
    WHERE purchase_order.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND purchase_order.linked_loan_id = ANY (v_loan_ids)
  ) THEN
    RAISE EXCEPTION 'Target loans still have order or exchange references';
  END IF;

  DELETE FROM public.loan_installments AS installment
  WHERE installment.loan_id = ANY (v_loan_ids);
  GET DIAGNOSTICS v_deleted_installment_count = ROW_COUNT;
  IF v_deleted_installment_count <> 2 THEN
    RAISE EXCEPTION 'Expected to remove 2 installment rows; removed %', v_deleted_installment_count;
  END IF;

  DELETE FROM public.loans AS loan
  WHERE loan.id = ANY (v_loan_ids)
    AND loan.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
    AND loan.loan_no = ANY (
      ARRAY['SL-20261017-A90560', 'SL-20261018-35B9C0']::text[]
    );
  GET DIAGNOSTICS v_deleted_loan_count = ROW_COUNT;
  IF v_deleted_loan_count <> 2 THEN
    RAISE EXCEPTION 'Expected to hard-delete 2 loans; deleted %', v_deleted_loan_count;
  END IF;
END
$hard_delete_linked_purchase_loans$;
