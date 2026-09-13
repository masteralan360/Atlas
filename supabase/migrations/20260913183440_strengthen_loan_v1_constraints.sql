-- Tighten only the versioned contract used by upgraded clients. Legacy rows
-- keep integrity_version = 0 and remain untouched.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE public.loans
  DROP CONSTRAINT IF EXISTS loans_v1_amounts_check;

ALTER TABLE public.loans
  ADD CONSTRAINT loans_v1_amounts_check CHECK (
    integrity_version = 0 OR (
      principal_amount > 0
      AND total_paid_amount >= 0
      AND balance_amount >= 0
      AND (
        status = 'cancelled'
        OR abs(principal_amount - total_paid_amount - balance_amount) <= 0.0005
      )
      AND (
        status = 'cancelled'
        OR (balance_amount = 0 AND status = 'completed')
        OR (balance_amount > 0 AND status IN ('active', 'overdue'))
      )
    )
  ) NOT VALID;

ALTER TABLE public.loan_payments
  DROP CONSTRAINT IF EXISTS loan_payments_v1_integrity_check;

ALTER TABLE public.loan_payments
  ADD CONSTRAINT loan_payments_v1_integrity_check CHECK (
    integrity_version = 0 OR (
      sequence_no > 0
      AND amount > 0
      AND payment_transaction_id IS NOT NULL
      AND reversed_amount >= 0
      AND reversed_amount <= amount
      AND (
        (
          reversed_amount = 0
          AND reversal_transaction_id IS NULL
          AND reversed_at IS NULL
          AND is_deleted = false
        )
        OR
        (
          reversed_amount = amount
          AND reversal_transaction_id IS NOT NULL
          AND reversed_at IS NOT NULL
          AND is_deleted = true
        )
      )
    )
  ) NOT VALID;

ALTER TABLE public.loans
  VALIDATE CONSTRAINT loans_v1_amounts_check;

ALTER TABLE public.loan_payments
  VALIDATE CONSTRAINT loan_payments_v1_integrity_check;
