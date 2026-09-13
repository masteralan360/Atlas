-- Promote every future loan into the hardened contract, including loans made
-- by still-installed clients and the legacy atomic order-financing helper.
-- Existing rows are not updated.

CREATE OR REPLACE FUNCTION private.initialize_new_loan_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.integrity_version = 0 THEN
    NEW.integrity_version := 1;
  END IF;
  NEW.terms_locked_at := COALESCE(NEW.terms_locked_at, now());
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.initialize_new_loan_installment_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.loans AS loan
    WHERE loan.id = NEW.loan_id
      AND loan.workspace_id = NEW.workspace_id
      AND loan.integrity_version > 0
  ) THEN
    NEW.integrity_version := 1;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS initialize_new_loan_integrity ON public.loans;
CREATE TRIGGER initialize_new_loan_integrity
BEFORE INSERT ON public.loans
FOR EACH ROW
EXECUTE FUNCTION private.initialize_new_loan_integrity();

DROP TRIGGER IF EXISTS initialize_new_loan_installment_integrity
  ON public.loan_installments;
CREATE TRIGGER initialize_new_loan_installment_integrity
BEFORE INSERT ON public.loan_installments
FOR EACH ROW
EXECUTE FUNCTION private.initialize_new_loan_installment_integrity();

REVOKE ALL ON FUNCTION private.initialize_new_loan_integrity()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.initialize_new_loan_installment_integrity()
  FROM PUBLIC, anon, authenticated, service_role;
