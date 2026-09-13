-- Cover loan-related foreign keys that are used by deletes, joins, and audit queries.
-- These indexes are additive and do not modify historical rows.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS loan_payments_created_by_idx
    ON public.loan_payments (created_by);

CREATE INDEX IF NOT EXISTS loan_payments_reversed_by_idx
    ON public.loan_payments (reversed_by);

CREATE INDEX IF NOT EXISTS loans_created_by_idx
    ON public.loans (created_by);

CREATE INDEX IF NOT EXISTS loans_sale_id_idx
    ON public.loans (sale_id);

CREATE INDEX IF NOT EXISTS sale_product_exchanges_loan_id_idx
    ON public.sale_product_exchanges (loan_id);
