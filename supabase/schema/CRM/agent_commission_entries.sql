CREATE TABLE crm.agent_commission_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  order_id uuid NULL REFERENCES crm.sales_orders(id) ON DELETE RESTRICT,
  assignment_id uuid NULL REFERENCES crm.sales_order_agent_assignments(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES crm.agents(id) ON DELETE RESTRICT,
  membership_id uuid NULL REFERENCES crm.agent_commission_memberships(id) ON DELETE RESTRICT,
  plan_id uuid NULL REFERENCES crm.agent_commission_plans(id) ON DELETE RESTRICT,
  order_return_id uuid NULL REFERENCES public.order_returns(id) ON DELETE RESTRICT,
  related_entry_id uuid NULL REFERENCES crm.agent_commission_entries(id) ON DELETE RESTRICT,
  commission_mode text NOT NULL DEFAULT 'payable' CHECK (commission_mode IN ('payable', 'tracked')),
  kind text NOT NULL CHECK (kind IN ('estimate', 'accrual', 'approval', 'reversal', 'payout', 'recovery', 'adjustment')),
  status text NOT NULL CHECK (status IN ('estimated', 'earned', 'approved', 'paid', 'reversed')),
  currency text NOT NULL CHECK (currency IN ('usd', 'eur', 'iqd', 'try')),
  calculation_basis text NOT NULL DEFAULT 'net_profit' CHECK (calculation_basis IN ('net_profit', 'net_revenue')),
  include_tax boolean NOT NULL DEFAULT false,
  include_delivery_charge boolean NOT NULL DEFAULT false,
  basis_amount numeric NOT NULL DEFAULT 0,
  revenue_amount numeric NOT NULL DEFAULT 0,
  cost_amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  delivery_charge_amount numeric NOT NULL DEFAULT 0,
  rate_percent numeric(9, 6) NOT NULL DEFAULT 0,
  amount numeric NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payout_reference text NULL,
  settlement_source text NOT NULL DEFAULT 'manual' CHECK (settlement_source IN ('manual', 'automatic')),
  notes text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1 CHECK (version = 1),
  is_deleted boolean NOT NULL DEFAULT false CHECK (is_deleted = false),
  CONSTRAINT agent_commission_entries_snapshots_check CHECK (
    basis_amount >= 0 AND revenue_amount >= 0 AND cost_amount >= 0
    AND tax_amount >= 0 AND delivery_charge_amount >= 0
    AND rate_percent >= 0 AND rate_percent <= 100
  ),
  CONSTRAINT agent_commission_entries_kind_status_check CHECK (
    (kind = 'estimate' AND status = 'estimated' AND amount >= 0)
    OR (kind = 'accrual' AND status = 'earned' AND amount >= 0)
    OR (kind = 'approval' AND status = 'approved' AND amount = 0)
    OR (kind = 'reversal' AND status = 'reversed' AND amount <= 0)
    OR (kind = 'payout' AND status = 'paid' AND amount <= 0 AND NULLIF(btrim(payout_reference), '') IS NOT NULL)
    OR (kind = 'recovery' AND status = 'paid' AND amount >= 0 AND NULLIF(btrim(payout_reference), '') IS NOT NULL)
    OR (kind = 'adjustment' AND status IN ('earned', 'approved', 'reversed'))
  ),
  CONSTRAINT agent_commission_entries_return_kind_check CHECK (order_return_id IS NULL OR kind = 'reversal'),
  CONSTRAINT agent_commission_entries_tracked_nonfinancial_check CHECK (commission_mode = 'payable' OR kind NOT IN ('approval', 'payout', 'recovery')),
  CONSTRAINT agent_commission_entries_related_not_self CHECK (related_entry_id IS NULL OR related_entry_id <> id)
);

CREATE INDEX agent_commission_entries_workspace_idx ON crm.agent_commission_entries (workspace_id);
CREATE INDEX agent_commission_entries_order_idx ON crm.agent_commission_entries (order_id, occurred_at DESC);
CREATE INDEX agent_commission_entries_assignment_idx ON crm.agent_commission_entries (assignment_id);
CREATE INDEX agent_commission_entries_agent_idx ON crm.agent_commission_entries (agent_id, occurred_at DESC);
CREATE INDEX agent_commission_entries_workspace_agent_currency_idx
  ON crm.agent_commission_entries (workspace_id, agent_id, currency, occurred_at DESC);
CREATE INDEX agent_commission_entries_membership_idx ON crm.agent_commission_entries (membership_id);
CREATE INDEX agent_commission_entries_plan_idx ON crm.agent_commission_entries (plan_id);
CREATE INDEX agent_commission_entries_return_idx ON crm.agent_commission_entries (order_return_id);
CREATE INDEX agent_commission_entries_related_idx ON crm.agent_commission_entries (related_entry_id);
CREATE INDEX agent_commission_entries_created_by_idx ON crm.agent_commission_entries (created_by);
CREATE INDEX agent_commission_entries_workspace_status_idx
  ON crm.agent_commission_entries (workspace_id, status, occurred_at DESC);
CREATE INDEX agent_commission_entries_workspace_mode_agent_idx
  ON crm.agent_commission_entries (workspace_id, commission_mode, agent_id, occurred_at DESC)
  WHERE is_deleted = false;
CREATE UNIQUE INDEX agent_commission_entries_one_accrual_per_assignment_idx
  ON crm.agent_commission_entries (assignment_id) WHERE kind = 'accrual';
CREATE UNIQUE INDEX agent_commission_entries_one_reversal_per_return_idx
  ON crm.agent_commission_entries (order_return_id, assignment_id)
  WHERE kind = 'reversal' AND order_return_id IS NOT NULL;
CREATE UNIQUE INDEX agent_commission_entries_one_approval_per_source_idx
  ON crm.agent_commission_entries (related_entry_id) WHERE kind = 'approval';
CREATE INDEX agent_commission_entries_payout_order_idx
  ON crm.agent_commission_entries (
    workspace_id, agent_id, currency, order_id, occurred_at DESC
  ) WHERE kind = 'payout';
CREATE INDEX agent_commission_entries_recovery_order_idx
  ON crm.agent_commission_entries (
    workspace_id, agent_id, currency, order_id, occurred_at DESC
  ) WHERE kind = 'recovery';

ALTER TABLE crm.agent_commission_entries ENABLE ROW LEVEL SECURITY;
