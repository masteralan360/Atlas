CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_module text NOT NULL,
  source_type text NOT NULL,
  source_record_id uuid NOT NULL,
  source_subrecord_id uuid NULL,
  direction text NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'usd'::text,
  payment_method text NOT NULL,
  paid_at timestamp with time zone NOT NULL,
  counterparty_name text NULL,
  reference_label text NULL,
  note text NULL,
  created_by uuid NULL,
  reversal_of_transaction_id uuid NULL,
  metadata jsonb NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);

ALTER TABLE public.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_direction_check;

ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_direction_check CHECK (
    direction IN ('incoming', 'outgoing')
  );

CREATE INDEX IF NOT EXISTS idx_payment_transactions_workspace
  ON public.payment_transactions (workspace_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_workspace_paid_at
  ON public.payment_transactions (workspace_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_workspace_source
  ON public.payment_transactions (workspace_id, source_type, source_record_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_reversal
  ON public.payment_transactions (reversal_of_transaction_id);

ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_transactions_select ON public.payment_transactions;
CREATE POLICY payment_transactions_select
  ON public.payment_transactions
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS payment_transactions_insert ON public.payment_transactions;
CREATE POLICY payment_transactions_insert
  ON public.payment_transactions
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS payment_transactions_update ON public.payment_transactions;
CREATE POLICY payment_transactions_update
  ON public.payment_transactions
  FOR UPDATE
  TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS payment_transactions_delete ON public.payment_transactions;
CREATE POLICY payment_transactions_delete
  ON public.payment_transactions
  FOR DELETE
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

INSERT INTO public.payment_transactions (
  id,
  workspace_id,
  source_module,
  source_type,
  source_record_id,
  source_subrecord_id,
  direction,
  amount,
  currency,
  payment_method,
  paid_at,
  counterparty_name,
  reference_label,
  note,
  created_by,
  reversal_of_transaction_id,
  metadata,
  created_at,
  updated_at,
  version,
  is_deleted
)
SELECT
  lp.id,
  lp.workspace_id,
  'loans',
  CASE
    WHEN COALESCE(l.loan_category, 'standard') = 'simple' THEN 'simple_loan'
    ELSE 'loan_payment'
  END,
  l.id,
  lp.id,
  CASE
    WHEN COALESCE(l.direction, 'lent') = 'borrowed' THEN 'outgoing'
    ELSE 'incoming'
  END,
  lp.amount,
  l.settlement_currency,
  COALESCE(NULLIF(lp.payment_method, ''), 'unknown'),
  lp.paid_at,
  l.borrower_name,
  l.loan_no,
  lp.note,
  lp.created_by,
  NULL,
  jsonb_build_object(
    'backfilled', true,
    'loanPaymentId', lp.id,
    'loanCategory', COALESCE(l.loan_category, 'standard'),
    'loanDirection', COALESCE(l.direction, 'lent')
  ),
  COALESCE(lp.created_at, now()),
  COALESCE(lp.updated_at, COALESCE(lp.created_at, now())),
  COALESCE(lp.version, 1),
  COALESCE(lp.is_deleted, false)
FROM public.loan_payments lp
JOIN public.loans l
  ON l.id = lp.loan_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.payment_transactions pt
  WHERE pt.id = lp.id
);

INSERT INTO public.payment_transactions (
  id,
  workspace_id,
  source_module,
  source_type,
  source_record_id,
  source_subrecord_id,
  direction,
  amount,
  currency,
  payment_method,
  paid_at,
  counterparty_name,
  reference_label,
  note,
  created_by,
  reversal_of_transaction_id,
  metadata,
  created_at,
  updated_at,
  version,
  is_deleted
)
SELECT
  gen_random_uuid(),
  so.workspace_id,
  'orders',
  'sales_order',
  so.id,
  NULL,
  'incoming',
  so.total,
  so.currency,
  COALESCE(NULLIF(so.payment_method, ''), 'unknown'),
  COALESCE(so.paid_at, so.updated_at, so.created_at, now()),
  so.customer_name,
  so.order_number,
  so.notes,
  NULL,
  NULL,
  jsonb_build_object(
    'backfilled', true,
    'orderStatus', so.status
  ),
  COALESCE(so.created_at, now()),
  COALESCE(so.updated_at, COALESCE(so.created_at, now())),
  COALESCE(so.version, 1),
  COALESCE(so.is_deleted, false)
FROM crm.sales_orders so
WHERE so.is_paid = true
  AND COALESCE(so.is_deleted, false) = false
  AND NOT EXISTS (
    SELECT 1
    FROM public.payment_transactions pt
    WHERE pt.source_type = 'sales_order'
      AND pt.source_record_id = so.id
      AND pt.reversal_of_transaction_id IS NULL
  );

INSERT INTO public.payment_transactions (
  id,
  workspace_id,
  source_module,
  source_type,
  source_record_id,
  source_subrecord_id,
  direction,
  amount,
  currency,
  payment_method,
  paid_at,
  counterparty_name,
  reference_label,
  note,
  created_by,
  reversal_of_transaction_id,
  metadata,
  created_at,
  updated_at,
  version,
  is_deleted
)
SELECT
  gen_random_uuid(),
  po.workspace_id,
  'orders',
  'purchase_order',
  po.id,
  NULL,
  'outgoing',
  po.total,
  po.currency,
  COALESCE(NULLIF(po.payment_method, ''), 'unknown'),
  COALESCE(po.paid_at, po.updated_at, po.created_at, now()),
  po.supplier_name,
  po.order_number,
  po.notes,
  NULL,
  NULL,
  jsonb_build_object(
    'backfilled', true,
    'orderStatus', po.status
  ),
  COALESCE(po.created_at, now()),
  COALESCE(po.updated_at, COALESCE(po.created_at, now())),
  COALESCE(po.version, 1),
  COALESCE(po.is_deleted, false)
FROM crm.purchase_orders po
WHERE po.is_paid = true
  AND COALESCE(po.is_deleted, false) = false
  AND NOT EXISTS (
    SELECT 1
    FROM public.payment_transactions pt
    WHERE pt.source_type = 'purchase_order'
      AND pt.source_record_id = po.id
      AND pt.reversal_of_transaction_id IS NULL
  );

INSERT INTO public.payment_transactions (
  id,
  workspace_id,
  source_module,
  source_type,
  source_record_id,
  source_subrecord_id,
  direction,
  amount,
  currency,
  payment_method,
  paid_at,
  counterparty_name,
  reference_label,
  note,
  created_by,
  reversal_of_transaction_id,
  metadata,
  created_at,
  updated_at,
  version,
  is_deleted
)
SELECT
  gen_random_uuid(),
  ei.workspace_id,
  'budget',
  'expense_item',
  ei.id,
  ei.series_id,
  'outgoing',
  ei.amount,
  ei.currency,
  'unknown',
  COALESCE(ei.paid_at, ei.updated_at, ei.created_at, now()),
  NULL,
  COALESCE(es.name, 'Expense'),
  NULL,
  NULL,
  NULL,
  jsonb_build_object(
    'backfilled', true,
    'month', ei.month,
    'seriesId', ei.series_id,
    'category', es.category,
    'subcategory', es.subcategory
  ),
  COALESCE(ei.created_at, now()),
  COALESCE(ei.updated_at, COALESCE(ei.created_at, now())),
  COALESCE(ei.version, 1),
  COALESCE(ei.is_deleted, false)
FROM budget.expense_items ei
LEFT JOIN budget.expense_series es
  ON es.id = ei.series_id
WHERE ei.status = 'paid'
  AND COALESCE(ei.is_deleted, false) = false
  AND NOT EXISTS (
    SELECT 1
    FROM public.payment_transactions pt
    WHERE pt.source_type = 'expense_item'
      AND pt.source_record_id = ei.id
      AND pt.reversal_of_transaction_id IS NULL
  );

INSERT INTO public.payment_transactions (
  id,
  workspace_id,
  source_module,
  source_type,
  source_record_id,
  source_subrecord_id,
  direction,
  amount,
  currency,
  payment_method,
  paid_at,
  counterparty_name,
  reference_label,
  note,
  created_by,
  reversal_of_transaction_id,
  metadata,
  created_at,
  updated_at,
  version,
  is_deleted
)
SELECT
  gen_random_uuid(),
  ps.workspace_id,
  'budget',
  'payroll_status',
  ps.id,
  ps.employee_id,
  'outgoing',
  COALESCE(e.salary, 0),
  COALESCE(e.salary_currency, 'usd'),
  'unknown',
  COALESCE(ps.paid_at, ps.updated_at, ps.created_at, now()),
  e.name,
  'Payroll ' || ps.month,
  NULL,
  NULL,
  NULL,
  jsonb_build_object(
    'backfilled', true,
    'employeeId', ps.employee_id,
    'month', ps.month
  ),
  COALESCE(ps.created_at, now()),
  COALESCE(ps.updated_at, COALESCE(ps.created_at, now())),
  COALESCE(ps.version, 1),
  COALESCE(ps.is_deleted, false)
FROM budget.payroll_statuses ps
JOIN public.employees e
  ON e.id = ps.employee_id
WHERE ps.status = 'paid'
  AND COALESCE(ps.is_deleted, false) = false
  AND COALESCE(e.is_deleted, false) = false
  AND NOT EXISTS (
    SELECT 1
    FROM public.payment_transactions pt
    WHERE pt.source_type = 'payroll_status'
      AND pt.source_record_id = ps.id
      AND pt.reversal_of_transaction_id IS NULL
  );
