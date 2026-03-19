REVOKE ALL ON SCHEMA crm FROM anon;
GRANT USAGE ON SCHEMA crm TO authenticated, service_role;

REVOKE ALL ON ALL TABLES IN SCHEMA crm FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA crm FROM anon;
REVOKE ALL ON ALL ROUTINES IN SCHEMA crm FROM anon;

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

ALTER TABLE crm.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.purchase_orders ENABLE ROW LEVEL SECURITY;

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
