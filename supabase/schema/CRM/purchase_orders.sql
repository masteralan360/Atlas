CREATE TABLE crm.purchase_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  order_number text NOT NULL,
  business_partner_id uuid NULL,
  supplier_id uuid NOT NULL,
  supplier_name text NULL,
  subtotal numeric NULL DEFAULT 0,
  discount numeric NULL DEFAULT 0,
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
  linked_loan_id uuid NULL,
  is_installment_based boolean NOT NULL DEFAULT false,
  installment_count integer NOT NULL DEFAULT 0,
  installment_frequency text NULL,
  first_due_date date NULL,
  next_due_date date NULL,
  destination_storage_id uuid NULL,
  notes text NULL,
  items jsonb NULL DEFAULT '[]'::jsonb,
  approval_status text NULL,
  approval_requested_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  approval_requested_at timestamp with time zone NULL,
  approval_reviewed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  approval_reviewed_at timestamp with time zone NULL,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  PRIMARY KEY (id)
);

ALTER TABLE crm.purchase_orders
  ADD CONSTRAINT purchase_orders_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('cash', 'fib', 'qicard', 'zaincash', 'fastpay', 'bank_transfer', 'loan', 'installments'));

ALTER TABLE crm.purchase_orders
  ADD CONSTRAINT crm_purchase_orders_approval_status_check
  CHECK (approval_status IS NULL OR approval_status IN ('requested', 'approved', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_workspace
  ON crm.purchase_orders (workspace_id);

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_workspace_updated
  ON crm.purchase_orders (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_workspace_deleted
  ON crm.purchase_orders (workspace_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_workspace_status
  ON crm.purchase_orders (workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_supplier
  ON crm.purchase_orders (supplier_id);

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_business_partner
  ON crm.purchase_orders (business_partner_id);

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_workspace_approval_status
  ON crm.purchase_orders (workspace_id, approval_status, updated_at DESC)
  WHERE COALESCE(is_deleted, false) = false;

ALTER TABLE crm.purchase_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_purchase_orders_select ON crm.purchase_orders;
CREATE POLICY crm_purchase_orders_select
  ON crm.purchase_orders
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = purchase_orders.workspace_id),
      'orders'
    )
  );

DROP POLICY IF EXISTS crm_purchase_orders_insert ON crm.purchase_orders;
CREATE POLICY crm_purchase_orders_insert
  ON crm.purchase_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = purchase_orders.workspace_id),
      'orders'
    )
    AND crm.order_request_write_allowed(
      purchase_orders.workspace_id,
      'orders.requirePurchaseOrderRequest',
      purchase_orders.approval_status,
      purchase_orders.approval_requested_by,
      purchase_orders.approval_requested_at
    )
  );

DROP POLICY IF EXISTS crm_purchase_orders_update ON crm.purchase_orders;
CREATE POLICY crm_purchase_orders_update
  ON crm.purchase_orders
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = purchase_orders.workspace_id),
      'orders'
    )
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = purchase_orders.workspace_id),
      'orders'
    )
    AND crm.order_request_write_allowed(
      purchase_orders.workspace_id,
      'orders.requirePurchaseOrderRequest',
      purchase_orders.approval_status,
      purchase_orders.approval_requested_by,
      purchase_orders.approval_requested_at
    )
  );

DROP POLICY IF EXISTS crm_purchase_orders_delete ON crm.purchase_orders;
CREATE POLICY crm_purchase_orders_delete
  ON crm.purchase_orders
  FOR DELETE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = purchase_orders.workspace_id),
      'orders'
    )
  );
