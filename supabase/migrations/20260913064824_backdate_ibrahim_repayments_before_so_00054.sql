-- Correct the posting order for the two repayments requested for
-- مندوب ابراهيم. The repayment amounts stay unchanged; only their
-- accounting timestamps move immediately before SO-2026-00054. This makes
-- the invoice's reconstructed pre-order balance equal the unchanged live
-- balance of 1,840,500 IQD.
--
-- Manual rollback:
-- supabase/manual-rollbacks/20260913064824_rollback_backdate_ibrahim_repayments_before_so_00054.sql

BEGIN;

DO $preflight$
DECLARE
  v_order_created_at timestamptz;
  v_matching_payments integer;
BEGIN
  SELECT sales_order.created_at
  INTO v_order_created_at
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.id = '8cccd1c3-0d85-4c14-85dd-5739cdd521f1'::uuid
    AND sales_order.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
    AND sales_order.order_number = 'SO-2026-00054'
    AND sales_order.business_partner_id = 'a0c6fbeb-2c45-464d-8f3f-f7bb869e5c3d'::uuid
    AND sales_order.status = 'completed'
    AND sales_order.total = 50000
    AND COALESCE(sales_order.is_deleted, false) = false;

  IF v_order_created_at IS DISTINCT FROM '2026-09-12 04:49:52.516+00'::timestamptz THEN
    RAISE EXCEPTION
      'SO-2026-00054 is not in the expected pre-correction state (created_at: %)',
      v_order_created_at
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO v_matching_payments
  FROM public.loan_payments AS payment
  WHERE payment.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
    AND COALESCE(payment.is_deleted, false) = false
    AND (
      (payment.id = 'ea9a7a7a-77f5-47d7-869f-ac66130a8c4a'::uuid
       AND payment.loan_id = 'cb578949-b05d-49d3-95f1-f21b5195e8e0'::uuid
       AND payment.amount = 31500
       AND payment.paid_at = '2026-09-12 04:53:00+00'::timestamptz)
      OR
      (payment.id = 'a0134bbd-134b-4749-93dc-0db5a48caf34'::uuid
       AND payment.loan_id = '1fd3c427-5f82-48f8-b229-71b6acee78aa'::uuid
       AND payment.amount = 11000
       AND payment.paid_at = '2026-09-12 04:53:00+00'::timestamptz)
    );

  IF v_matching_payments <> 2 THEN
    RAISE EXCEPTION
      'Expected the two original active Ibrahim loan repayments, found %',
      v_matching_payments
      USING ERRCODE = '23514';
  END IF;
END;
$preflight$;

UPDATE public.loan_payments AS payment
SET paid_at = CASE payment.id
  WHEN 'ea9a7a7a-77f5-47d7-869f-ac66130a8c4a'::uuid THEN '2026-09-12 04:49:50.516+00'::timestamptz
  WHEN 'a0134bbd-134b-4749-93dc-0db5a48caf34'::uuid THEN '2026-09-12 04:49:51.516+00'::timestamptz
  ELSE payment.paid_at
END,
    updated_at = timezone('utc', now()),
    version = COALESCE(payment.version, 0) + 1
WHERE payment.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
  AND payment.id IN (
    'ea9a7a7a-77f5-47d7-869f-ac66130a8c4a'::uuid,
    'a0134bbd-134b-4749-93dc-0db5a48caf34'::uuid
  )
  AND COALESCE(payment.is_deleted, false) = false;

DO $verify$
DECLARE
  v_order_created_at timestamptz;
  v_corrected_payments integer;
BEGIN
  SELECT created_at
  INTO v_order_created_at
  FROM crm.sales_orders
  WHERE id = '8cccd1c3-0d85-4c14-85dd-5739cdd521f1'::uuid;

  SELECT count(*)
  INTO v_corrected_payments
  FROM public.loan_payments AS payment
  WHERE payment.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
    AND COALESCE(payment.is_deleted, false) = false
    AND (
      (payment.id = 'ea9a7a7a-77f5-47d7-869f-ac66130a8c4a'::uuid
       AND payment.amount = 31500
       AND payment.paid_at = '2026-09-12 04:49:50.516+00'::timestamptz)
      OR
      (payment.id = 'a0134bbd-134b-4749-93dc-0db5a48caf34'::uuid
       AND payment.amount = 11000
       AND payment.paid_at = '2026-09-12 04:49:51.516+00'::timestamptz)
    )
    AND payment.paid_at < v_order_created_at;

  IF v_corrected_payments <> 2 THEN
    RAISE EXCEPTION 'Ibrahim repayment chronology correction failed verification'
      USING ERRCODE = '23514';
  END IF;
END;
$verify$;

COMMIT;
