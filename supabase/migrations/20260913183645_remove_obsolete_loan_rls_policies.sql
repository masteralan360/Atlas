-- The original policies target PUBLIC and overlap the newer capability-aware
-- authenticated policies. Because RLS policies are permissive by default, the
-- old copies bypass view-own and linked-partner visibility restrictions.

DROP POLICY IF EXISTS "Loans are viewable by workspace members"
  ON public.loans;
DROP POLICY IF EXISTS "Loans insertable by workspace admin or staff"
  ON public.loans;
DROP POLICY IF EXISTS "Loans updateable by workspace admin or staff"
  ON public.loans;
DROP POLICY IF EXISTS "Loans deletable by workspace admin or staff"
  ON public.loans;

DROP POLICY IF EXISTS "Loan installments are viewable by workspace members"
  ON public.loan_installments;
DROP POLICY IF EXISTS "Loan installments insertable by workspace admin or staff"
  ON public.loan_installments;
DROP POLICY IF EXISTS "Loan installments updateable by workspace admin or staff"
  ON public.loan_installments;
DROP POLICY IF EXISTS "Loan installments deletable by workspace admin or staff"
  ON public.loan_installments;

DROP POLICY IF EXISTS "Loan payments are viewable by workspace members"
  ON public.loan_payments;
DROP POLICY IF EXISTS "Loan payments insertable by workspace admin or staff"
  ON public.loan_payments;
DROP POLICY IF EXISTS "Loan payments updateable by workspace admin or staff"
  ON public.loan_payments;
DROP POLICY IF EXISTS "Loan payments deletable by workspace admin or staff"
  ON public.loan_payments;
