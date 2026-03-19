CREATE SCHEMA IF NOT EXISTS crm;

REVOKE ALL ON SCHEMA crm FROM anon;
GRANT USAGE ON SCHEMA crm TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA crm TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA crm TO authenticated, service_role;
GRANT EXECUTE ON ALL ROUTINES IN SCHEMA crm TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA crm REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm REVOKE ALL ON ROUTINES FROM anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT EXECUTE ON ROUTINES TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
    SELECT workspace_id
    FROM public.profiles
    WHERE id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.current_workspace_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_workspace_id() TO authenticated, service_role;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS allow_crm boolean NOT NULL DEFAULT true;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS allow_customers boolean NOT NULL DEFAULT false;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS allow_orders boolean NOT NULL DEFAULT false;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS allow_suppliers boolean NOT NULL DEFAULT false;

UPDATE public.workspaces
SET
  allow_crm = COALESCE(allow_crm, true),
  allow_customers = COALESCE(allow_crm, true),
  allow_orders = COALESCE(allow_crm, true),
  allow_suppliers = COALESCE(allow_crm, true)
WHERE TRUE;

CREATE TABLE IF NOT EXISTS crm.customers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
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
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_crm_customers_workspace
  ON crm.customers (workspace_id);

CREATE INDEX IF NOT EXISTS idx_crm_customers_workspace_updated
  ON crm.customers (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_customers_workspace_deleted
  ON crm.customers (workspace_id, is_deleted);

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

CREATE TABLE IF NOT EXISTS crm.suppliers (
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

CREATE TABLE IF NOT EXISTS crm.sales_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  order_number text NOT NULL,
  customer_id uuid NOT NULL,
  customer_name text NULL,
  subtotal numeric NULL DEFAULT 0,
  discount numeric NULL DEFAULT 0,
  tax numeric NULL DEFAULT 0,
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
  reserved_at timestamp with time zone NULL,
  shipping_address text NULL,
  notes text NULL,
  items jsonb NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  PRIMARY KEY (id)
);

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

ALTER TABLE crm.sales_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_sales_orders_select ON crm.sales_orders;
CREATE POLICY crm_sales_orders_select
  ON crm.sales_orders
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_sales_orders_insert ON crm.sales_orders;
CREATE POLICY crm_sales_orders_insert
  ON crm.sales_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_sales_orders_update ON crm.sales_orders;
CREATE POLICY crm_sales_orders_update
  ON crm.sales_orders
  FOR UPDATE
  TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS crm_sales_orders_delete ON crm.sales_orders;
CREATE POLICY crm_sales_orders_delete
  ON crm.sales_orders
  FOR DELETE
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

CREATE TABLE IF NOT EXISTS crm.purchase_orders (
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
