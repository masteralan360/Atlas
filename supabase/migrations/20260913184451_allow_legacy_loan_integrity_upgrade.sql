-- A legacy loan may receive its first payment after the hardened client ships.
-- Its historical origination link cannot be invented, so allow the arithmetic
-- contract to upgrade independently while freezing identity from that point on.

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

ALTER TABLE public.loans
  VALIDATE CONSTRAINT loans_v1_amounts_check;

CREATE OR REPLACE FUNCTION private.protect_locked_loan_terms()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF (OLD.terms_locked_at IS NOT NULL OR OLD.integrity_version > 0) AND (
    NEW.source IS DISTINCT FROM OLD.source
    OR NEW.loan_category IS DISTINCT FROM OLD.loan_category
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.settlement_currency IS DISTINCT FROM OLD.settlement_currency
    OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.order_type IS DISTINCT FROM OLD.order_type
  ) THEN
    RAISE EXCEPTION 'Posted loan identity and currency are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.protect_locked_loan_terms()
  FROM PUBLIC, anon, authenticated, service_role;
