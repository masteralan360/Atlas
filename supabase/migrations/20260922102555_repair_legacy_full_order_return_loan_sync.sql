-- Older clients represented a fully returned, unpaid financed order as a
-- zero-principal completed loan. V1 deliberately rejects that state because a
-- posted loan must retain its original principal. Normalize only that exact
-- legacy UPDATE shape so a queued return can complete as a cancellation; do
-- not relax the V1 amount constraint for new or arbitrary loan writes.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION private.normalize_legacy_full_order_return_loan()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.integrity_version > 0
    AND OLD.source = 'order'
    AND OLD.order_id IS NOT NULL
    AND OLD.principal_amount > 0
    AND OLD.total_paid_amount = 0
    AND OLD.balance_amount > 0
    AND NEW.integrity_version > 0
    AND NEW.source = 'order'
    AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
    AND NEW.principal_amount = 0
    AND NEW.total_paid_amount = 0
    AND NEW.balance_amount = 0
    AND NEW.status = 'completed'
    AND NEW.is_deleted = false THEN
    NEW.principal_amount := OLD.principal_amount;
    NEW.total_paid_amount := 0;
    NEW.balance_amount := 0;
    NEW.next_due_date := NULL;
    NEW.status := 'cancelled';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS normalize_legacy_full_order_return_loan ON public.loans;
CREATE TRIGGER normalize_legacy_full_order_return_loan
BEFORE UPDATE OF principal_amount, total_paid_amount, balance_amount, status
ON public.loans
FOR EACH ROW
EXECUTE FUNCTION private.normalize_legacy_full_order_return_loan();

REVOKE ALL ON FUNCTION private.normalize_legacy_full_order_return_loan()
  FROM PUBLIC, anon, authenticated, service_role;
