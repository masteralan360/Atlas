-- MANUAL ROLLBACK for:
--   supabase/migrations/20260913064824_backdate_ibrahim_repayments_before_so_00054.sql
--
-- This script is deliberately outside supabase/migrations so normal deploys
-- cannot automatically undo the correction. Apply it manually only when the
-- exact correction below must be reversed.

BEGIN;

DO $preflight$
DECLARE
  v_corrected_payments integer;
BEGIN
  SELECT count(*)
  INTO v_corrected_payments
  FROM public.loan_payments AS payment
  WHERE payment.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
    AND COALESCE(payment.is_deleted, false) = false
    AND (
      (payment.id = 'ea9a7a7a-77f5-47d7-869f-ac66130a8c4a'::uuid
       AND payment.loan_id = 'cb578949-b05d-49d3-95f1-f21b5195e8e0'::uuid
       AND payment.amount = 31500
       AND payment.paid_at = '2026-09-12 04:49:50.516+00'::timestamptz)
      OR
      (payment.id = 'a0134bbd-134b-4749-93dc-0db5a48caf34'::uuid
       AND payment.loan_id = '1fd3c427-5f82-48f8-b229-71b6acee78aa'::uuid
       AND payment.amount = 11000
       AND payment.paid_at = '2026-09-12 04:49:51.516+00'::timestamptz)
    );

  IF v_corrected_payments <> 2 THEN
    RAISE EXCEPTION
      'The Ibrahim repayment correction is not in its expected state; refusing rollback'
      USING ERRCODE = '23514';
  END IF;
END;
$preflight$;

UPDATE public.loan_payments AS payment
SET paid_at = '2026-09-12 04:53:00+00'::timestamptz,
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
  v_restored_payments integer;
BEGIN
  SELECT count(*)
  INTO v_restored_payments
  FROM public.loan_payments AS payment
  WHERE payment.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
    AND COALESCE(payment.is_deleted, false) = false
    AND payment.paid_at = '2026-09-12 04:53:00+00'::timestamptz
    AND (
      (payment.id = 'ea9a7a7a-77f5-47d7-869f-ac66130a8c4a'::uuid
       AND payment.loan_id = 'cb578949-b05d-49d3-95f1-f21b5195e8e0'::uuid
       AND payment.amount = 31500)
      OR
      (payment.id = 'a0134bbd-134b-4749-93dc-0db5a48caf34'::uuid
       AND payment.loan_id = '1fd3c427-5f82-48f8-b229-71b6acee78aa'::uuid
       AND payment.amount = 11000)
    );

  IF v_restored_payments <> 2 THEN
    RAISE EXCEPTION 'Ibrahim repayment rollback failed verification'
      USING ERRCODE = '23514';
  END IF;
END;
$verify$;

COMMIT;
