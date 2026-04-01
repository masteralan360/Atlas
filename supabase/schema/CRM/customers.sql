CREATE TABLE crm.customers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  business_partner_id uuid NULL,
  name text NOT NULL,
  email text NULL,
  phone text NULL,
  address text NULL,
  city text NULL,
  country text NULL,
  notes text NULL,
  default_currency text NOT NULL DEFAULT 'usd'::text,
  total_orders numeric NULL DEFAULT 0,
  total_spent numeric NULL DEFAULT 0,
  outstanding_balance numeric NULL DEFAULT 0,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  credit_limit numeric NULL DEFAULT 0,
  is_ecommerce boolean NULL DEFAULT false,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_crm_customers_workspace
  ON crm.customers (workspace_id);

CREATE INDEX IF NOT EXISTS idx_crm_customers_workspace_updated
  ON crm.customers (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_customers_workspace_deleted
  ON crm.customers (workspace_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_crm_customers_business_partner
  ON crm.customers (business_partner_id);

ALTER TABLE crm.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_customers_select ON crm.customers;
CREATE POLICY crm_customers_select
  ON crm.customers
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_customers_insert ON crm.customers;
CREATE POLICY crm_customers_insert
  ON crm.customers
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_customers_update ON crm.customers;
CREATE POLICY crm_customers_update
  ON crm.customers
  FOR UPDATE
  TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_customers_delete ON crm.customers;
CREATE POLICY crm_customers_delete
  ON crm.customers
  FOR DELETE
  TO authenticated
  USING (workspace_id = public.current_workspace_id());
