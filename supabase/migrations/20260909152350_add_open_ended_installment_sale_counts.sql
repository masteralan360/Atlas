-- A frequency-based sale can be open-ended: it has a first due date but no
-- user-defined number of installments. The single internal allocation row
-- keeps payment and reversal processing in the established auditable flow.
ALTER TABLE public.installment_sales
  ADD COLUMN IF NOT EXISTS has_installment_count boolean;

UPDATE public.installment_sales
SET has_installment_count = installment_frequency <> 'no_frequency'
WHERE has_installment_count IS NULL;

ALTER TABLE public.installment_sales
  ALTER COLUMN has_installment_count SET DEFAULT true,
  ALTER COLUMN has_installment_count SET NOT NULL;

ALTER TABLE public.installment_sales
  DROP CONSTRAINT IF EXISTS installment_sales_installment_check,
  ADD CONSTRAINT installment_sales_installment_check CHECK (
    (
      installment_frequency = 'no_frequency'
      AND installment_count = 1
      AND has_installment_count = false
      AND first_due_date IS NULL
      AND next_due_date IS NULL
    )
    OR (
      installment_frequency IN ('daily', 'weekly', 'biweekly', 'monthly')
      AND first_due_date IS NOT NULL
      AND (
        (has_installment_count = true AND installment_count > 0)
        OR (has_installment_count = false AND installment_count = 1)
      )
    )
  );
