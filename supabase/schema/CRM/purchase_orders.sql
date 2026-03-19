CREATE TABLE crm.purchase_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  order_number text NOT NULL,
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
  status text NOT NULL,
  expected_delivery_date timestamp with time zone NULL,
  actual_delivery_date timestamp with time zone NULL,
  is_paid boolean NULL DEFAULT false,
  paid_at timestamp with time zone NULL,
  payment_method text NULL,
  notes text NULL,
  items jsonb NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  PRIMARY KEY (id)
);

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

ALTER TABLE crm.purchase_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_purchase_orders_select ON crm.purchase_orders;
CREATE POLICY crm_purchase_orders_select
  ON crm.purchase_orders
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_purchase_orders_insert ON crm.purchase_orders;
CREATE POLICY crm_purchase_orders_insert
  ON crm.purchase_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_purchase_orders_update ON crm.purchase_orders;
CREATE POLICY crm_purchase_orders_update
  ON crm.purchase_orders
  FOR UPDATE
  TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_purchase_orders_delete ON crm.purchase_orders;
CREATE POLICY crm_purchase_orders_delete
  ON crm.purchase_orders
  FOR DELETE
  TO authenticated
  USING (workspace_id = public.current_workspace_id());
