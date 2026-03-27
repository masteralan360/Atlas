CREATE TABLE public.payment_transactions (
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
  PRIMARY KEY (id),
  CONSTRAINT payment_transactions_direction_check CHECK (direction IN ('incoming', 'outgoing'))
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
