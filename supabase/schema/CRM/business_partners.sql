CREATE TABLE crm.business_partners (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  contact_name text NULL,
  email text NULL,
  phone text NULL,
  address text NULL,
  city text NULL,
  country text NULL,
  notes text NULL,
  default_currency text NOT NULL DEFAULT 'usd'::text,
  role text NOT NULL DEFAULT 'customer'::text,
  credit_limit numeric NULL DEFAULT 0,
  customer_facet_id uuid NULL,
  supplier_facet_id uuid NULL,
  total_sales_orders numeric NULL DEFAULT 0,
  total_sales_value numeric NULL DEFAULT 0,
  receivable_balance numeric NULL DEFAULT 0,
  total_purchase_orders numeric NULL DEFAULT 0,
  total_purchase_value numeric NULL DEFAULT 0,
  payable_balance numeric NULL DEFAULT 0,
  total_loan_count numeric NULL DEFAULT 0,
  loan_outstanding_balance numeric NULL DEFAULT 0,
  net_exposure numeric NULL DEFAULT 0,
  merged_into_business_partner_id uuid NULL,
  is_ecommerce boolean NULL DEFAULT false,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  CONSTRAINT business_partners_role_check CHECK (
    role IN ('customer', 'supplier', 'both')
  ),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_crm_business_partners_workspace
  ON crm.business_partners (workspace_id);

CREATE INDEX IF NOT EXISTS idx_crm_business_partners_workspace_updated
  ON crm.business_partners (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_business_partners_workspace_deleted
  ON crm.business_partners (workspace_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_crm_business_partners_role
  ON crm.business_partners (workspace_id, role);

ALTER TABLE crm.business_partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_business_partners_select ON crm.business_partners;
CREATE POLICY crm_business_partners_select
  ON crm.business_partners
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_business_partners_insert ON crm.business_partners;
CREATE POLICY crm_business_partners_insert
  ON crm.business_partners
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_business_partners_update ON crm.business_partners;
CREATE POLICY crm_business_partners_update
  ON crm.business_partners
  FOR UPDATE
  TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_business_partners_delete ON crm.business_partners;
CREATE POLICY crm_business_partners_delete
  ON crm.business_partners
  FOR DELETE
  TO authenticated
  USING (workspace_id = public.current_workspace_id());
