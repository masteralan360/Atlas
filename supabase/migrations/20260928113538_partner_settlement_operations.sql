-- Preserve each obligation-level payment transaction while recording the
-- single user action that produced its payment rows.
-- Deliberately use a nullable, soft association: settlement sources are posted
-- through existing module workflows and may be replayed from offline queues.

CREATE TABLE IF NOT EXISTS public.partner_settlement_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  partner_name_snapshot text NOT NULL,
  direction text NOT NULL,
  paid_at timestamptz NOT NULL,
  payment_method text NOT NULL,
  note text NULL,
  created_by uuid NULL,
  account_id uuid NULL,
  account_name_snapshot text NULL,
  status text NOT NULL DEFAULT 'in_progress',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false
);

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS settlement_operation_id uuid NULL;

CREATE INDEX IF NOT EXISTS partner_settlement_operations_workspace_partner_time_idx
  ON public.partner_settlement_operations (workspace_id, partner_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS payment_transactions_workspace_settlement_operation_idx
  ON public.payment_transactions (workspace_id, settlement_operation_id)
  WHERE settlement_operation_id IS NOT NULL;

ALTER TABLE public.partner_settlement_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_settlement_operations_select ON public.partner_settlement_operations;
CREATE POLICY partner_settlement_operations_select
  ON public.partner_settlement_operations
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS partner_settlement_operations_insert ON public.partner_settlement_operations;
CREATE POLICY partner_settlement_operations_insert
  ON public.partner_settlement_operations
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS partner_settlement_operations_update ON public.partner_settlement_operations;
CREATE POLICY partner_settlement_operations_update
  ON public.partner_settlement_operations
  FOR UPDATE
  TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS partner_settlement_operations_delete ON public.partner_settlement_operations;
CREATE POLICY partner_settlement_operations_delete
  ON public.partner_settlement_operations
  FOR DELETE
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

REVOKE ALL ON TABLE public.partner_settlement_operations FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.partner_settlement_operations TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
