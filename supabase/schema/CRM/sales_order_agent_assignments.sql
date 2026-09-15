CREATE TABLE crm.sales_order_agent_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES crm.sales_orders(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES crm.agents(id) ON DELETE RESTRICT,
  assignment_source text NOT NULL DEFAULT 'manual' CHECK (assignment_source IN ('manual', 'sales_account', 'order_creator_product', 'marketplace_delivery_product')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz NULL CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at),
  assigned_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  unassigned_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  reassignment_reason text NULL,
  previous_assignment_id uuid NULL REFERENCES crm.sales_order_agent_assignments(id) ON DELETE RESTRICT,
  customer_city_snapshot text NULL,
  delivery_charge_amount numeric NOT NULL DEFAULT 0 CHECK (delivery_charge_amount >= 0),
  internal_delivery_cost_amount numeric NOT NULL DEFAULT 0 CHECK (internal_delivery_cost_amount >= 0),
  manual_commission_type text NULL CHECK (manual_commission_type IS NULL OR manual_commission_type IN ('fixed_amount', 'percentage')),
  manual_commission_source_amount numeric NULL,
  manual_commission_source_currency text NULL CHECK (manual_commission_source_currency IS NULL OR manual_commission_source_currency IN ('usd', 'eur', 'iqd', 'try')),
  manual_commission_converted_amount numeric NULL,
  manual_commission_exchange_rate numeric NULL,
  manual_commission_exchange_rate_source text NULL,
  manual_commission_exchange_rate_timestamp timestamptz NULL,
  manual_commission_exchange_rates jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  is_deleted boolean NOT NULL DEFAULT false CHECK (is_deleted = false),
  CONSTRAINT sales_order_agent_assignments_previous_not_self CHECK (previous_assignment_id IS NULL OR previous_assignment_id <> id),
  CONSTRAINT sales_order_agent_assignments_manual_commission_shape_check CHECK (
    (manual_commission_type IS NULL
      AND manual_commission_source_amount IS NULL
      AND manual_commission_source_currency IS NULL
      AND manual_commission_converted_amount IS NULL
      AND manual_commission_exchange_rate IS NULL
      AND manual_commission_exchange_rate_source IS NULL
      AND manual_commission_exchange_rate_timestamp IS NULL
      AND manual_commission_exchange_rates IS NULL)
    OR (manual_commission_type = 'fixed_amount'
      AND manual_commission_source_amount >= 0
      AND manual_commission_source_currency IS NOT NULL
      AND manual_commission_converted_amount >= 0
      AND manual_commission_exchange_rate > 0
      AND NULLIF(btrim(manual_commission_exchange_rate_source), '') IS NOT NULL
      AND manual_commission_exchange_rate_timestamp IS NOT NULL
      AND jsonb_typeof(COALESCE(manual_commission_exchange_rates, '[]'::jsonb)) = 'array')
    OR (manual_commission_type = 'percentage'
      AND manual_commission_source_amount >= 0
      AND manual_commission_source_amount <= 100
      AND manual_commission_source_currency IS NOT NULL
      AND manual_commission_converted_amount >= 0
      AND manual_commission_exchange_rate = 1
      AND manual_commission_exchange_rate_source = 'native'
      AND manual_commission_exchange_rate_timestamp IS NOT NULL
      AND jsonb_typeof(COALESCE(manual_commission_exchange_rates, '[]'::jsonb)) = 'array')
  )
);

COMMENT ON COLUMN crm.sales_order_agent_assignments.assignment_source IS
  'manual is user-selected, sales_account follows the selected agent account, order_creator_product is product-only attribution derived from the linked staff user who created the sale, and marketplace_delivery_product is product-only attribution derived from the field agent who delivered a marketplace order.';

CREATE INDEX sales_order_agent_assignments_workspace_idx ON crm.sales_order_agent_assignments (workspace_id);
CREATE INDEX sales_order_agent_assignments_order_idx
  ON crm.sales_order_agent_assignments (order_id, assigned_at DESC) WHERE is_deleted = false;
CREATE INDEX sales_order_agent_assignments_agent_idx
  ON crm.sales_order_agent_assignments (agent_id, assigned_at DESC) WHERE is_deleted = false;
CREATE INDEX sales_order_agent_assignments_previous_idx ON crm.sales_order_agent_assignments (previous_assignment_id);
CREATE INDEX sales_order_agent_assignments_assigned_by_idx ON crm.sales_order_agent_assignments (assigned_by);
CREATE INDEX sales_order_agent_assignments_unassigned_by_idx ON crm.sales_order_agent_assignments (unassigned_by);
CREATE UNIQUE INDEX sales_order_agent_assignments_one_active_agent_idx
  ON crm.sales_order_agent_assignments (workspace_id, order_id, agent_id)
  WHERE unassigned_at IS NULL AND is_deleted = false;

ALTER TABLE crm.sales_order_agent_assignments ENABLE ROW LEVEL SECURITY;
