CREATE TABLE crm.suppliers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  contact_name text NULL,
  email text NULL,
  phone text NULL,
  address text NULL,
  city text NULL,
  country text NULL,
  default_currency text NOT NULL DEFAULT 'usd'::text,
  notes text NULL,
  total_purchases numeric NULL DEFAULT 0,
  total_spent numeric NULL DEFAULT 0,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  credit_limit numeric NULL DEFAULT 0,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_crm_suppliers_workspace
  ON crm.suppliers (workspace_id);

CREATE INDEX IF NOT EXISTS idx_crm_suppliers_workspace_updated
  ON crm.suppliers (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_suppliers_workspace_deleted
  ON crm.suppliers (workspace_id, is_deleted);

ALTER TABLE crm.suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_suppliers_select ON crm.suppliers;
CREATE POLICY crm_suppliers_select
  ON crm.suppliers
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_suppliers_insert ON crm.suppliers;
CREATE POLICY crm_suppliers_insert
  ON crm.suppliers
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_suppliers_update ON crm.suppliers;
CREATE POLICY crm_suppliers_update
  ON crm.suppliers
  FOR UPDATE
  TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_suppliers_delete ON crm.suppliers;
CREATE POLICY crm_suppliers_delete
  ON crm.suppliers
  FOR DELETE
  TO authenticated
  USING (workspace_id = public.current_workspace_id());
