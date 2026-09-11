CREATE TABLE crm.sales_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  order_number text NOT NULL,
  business_partner_id uuid NULL,
  customer_id uuid NOT NULL,
  customer_name text NULL,
  sales_account_agent_id uuid NULL REFERENCES crm.agents(id) ON DELETE RESTRICT,
  subtotal numeric NULL DEFAULT 0,
  discount numeric NULL DEFAULT 0,
  tax numeric NULL DEFAULT 0,
  total numeric NULL DEFAULT 0,
  currency text NOT NULL,
  exchange_rate numeric NULL,
  exchange_rate_source text NULL,
  exchange_rate_timestamp timestamp with time zone NULL,
  exchange_rates jsonb NULL,
  order_adjustments jsonb NULL,
  status text NOT NULL,
  expected_delivery_date timestamp with time zone NULL,
  actual_delivery_date timestamp with time zone NULL,
  is_paid boolean NULL DEFAULT false,
  payment_status text NOT NULL DEFAULT 'unpaid'::text,
  paid_amount numeric NOT NULL DEFAULT 0,
  balance_amount numeric NOT NULL DEFAULT 0,
  paid_at timestamp with time zone NULL,
  payment_method text NULL,
  initial_payment_amount numeric NOT NULL DEFAULT 0,
  partner_balance_snapshot jsonb NULL,
  linked_loan_id uuid NULL,
  is_installment_based boolean NOT NULL DEFAULT false,
  installment_count integer NOT NULL DEFAULT 0,
  installment_frequency text NULL,
  first_due_date date NULL,
  next_due_date date NULL,
  reserved_at timestamp with time zone NULL,
  source_storage_id uuid NULL,
  shipping_address text NULL,
  notes text NULL,
  items jsonb NULL DEFAULT '[]'::jsonb,
  approval_status text NULL,
  approval_requested_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  approval_requested_at timestamp with time zone NULL,
  approval_reviewed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  approval_reviewed_at timestamp with time zone NULL,
  is_locked boolean NOT NULL DEFAULT false,
  source_channel text NOT NULL DEFAULT 'manual'::text,
  marketplace_order_id uuid NULL,
  original_total_amount numeric NULL,
  returned_amount numeric NOT NULL DEFAULT 0,
  return_status text NOT NULL DEFAULT 'none'::text,
  returned_at timestamp with time zone NULL,
  returned_by uuid NULL,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  PRIMARY KEY (id)
);

ALTER TABLE crm.sales_orders
  ADD CONSTRAINT sales_orders_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('cash', 'fib', 'qicard', 'zaincash', 'fastpay', 'bank_transfer', 'loan', 'installments', 'credit'));

ALTER TABLE crm.sales_orders
  ADD CONSTRAINT crm_sales_orders_approval_status_check
  CHECK (approval_status IS NULL OR approval_status IN ('requested', 'approved', 'rejected'));

ALTER TABLE crm.sales_orders
  ADD CONSTRAINT sales_orders_return_status_check
  CHECK (return_status IN ('none', 'partial', 'full'));

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_workspace
  ON crm.sales_orders (workspace_id);

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_workspace_updated
  ON crm.sales_orders (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_workspace_deleted
  ON crm.sales_orders (workspace_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_workspace_status
  ON crm.sales_orders (workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_customer
  ON crm.sales_orders (customer_id);

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_business_partner
  ON crm.sales_orders (business_partner_id);

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_sales_account_agent
  ON crm.sales_orders (workspace_id, sales_account_agent_id)
  WHERE sales_account_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_source_channel
  ON crm.sales_orders (workspace_id, source_channel, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_workspace_approval_status
  ON crm.sales_orders (workspace_id, approval_status, updated_at DESC)
  WHERE COALESCE(is_deleted, false) = false;

ALTER TABLE crm.sales_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_sales_orders_select ON crm.sales_orders;
CREATE POLICY crm_sales_orders_select
  ON crm.sales_orders
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = sales_orders.workspace_id),
      'orders'
    )
    AND (
      NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
      OR created_by = (SELECT auth.uid())
      OR private.sales_agent_commissions_can_view_assigned_order(workspace_id, id)
    )
  );

DROP POLICY IF EXISTS crm_sales_orders_insert ON crm.sales_orders;
CREATE POLICY crm_sales_orders_insert
  ON crm.sales_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = sales_orders.workspace_id),
      'orders'
    )
    AND crm.order_request_write_allowed(
      sales_orders.workspace_id,
      'orders.requireSalesOrderRequest',
      sales_orders.approval_status,
      sales_orders.approval_requested_by,
      sales_orders.approval_requested_at
    )
  );

DROP POLICY IF EXISTS crm_sales_orders_update ON crm.sales_orders;
CREATE POLICY crm_sales_orders_update
  ON crm.sales_orders
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = sales_orders.workspace_id),
      'orders'
    )
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = sales_orders.workspace_id),
      'orders'
    )
    AND crm.order_request_write_allowed(
      sales_orders.workspace_id,
      'orders.requireSalesOrderRequest',
      sales_orders.approval_status,
      sales_orders.approval_requested_by,
      sales_orders.approval_requested_at
    )
  );

DROP POLICY IF EXISTS crm_sales_orders_delete ON crm.sales_orders;
CREATE POLICY crm_sales_orders_delete
  ON crm.sales_orders
  FOR DELETE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = sales_orders.workspace_id),
      'orders'
    )
  );
