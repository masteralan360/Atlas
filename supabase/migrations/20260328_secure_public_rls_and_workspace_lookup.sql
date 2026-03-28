CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT role
  FROM public.profiles
  WHERE id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.lookup_workspace_by_code(p_code text)
RETURNS TABLE(id uuid, name text, code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT w.id, w.name, w.code
  FROM public.workspaces w
  WHERE w.code = UPPER(TRIM(COALESCE(p_code, '')))
    AND w.deleted_at IS NULL
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.lookup_workspace_by_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_workspace_by_code(text) TO anon, authenticated, service_role;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'categories',
    'employees',
    'inventory',
    'inventory_transfer_transactions',
    'invoices',
    'loan_installments',
    'loan_payments',
    'loans',
    'products',
    'reorder_transfer_rules',
    'sales',
    'storages',
    'workspace_contacts'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_select', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (workspace_id = public.current_workspace_id())',
      table_name || '_select',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_insert', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_insert',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_update', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff'')) WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_update',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_delete', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_delete',
      table_name
    );
  END LOOP;
END $$;

ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sale_items_select ON public.sale_items;
CREATE POLICY sale_items_select
  ON public.sale_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.sales s
      WHERE s.id = sale_items.sale_id
        AND s.workspace_id = public.current_workspace_id()
    )
  );

DROP POLICY IF EXISTS sale_items_insert ON public.sale_items;
CREATE POLICY sale_items_insert
  ON public.sale_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND EXISTS (
      SELECT 1
      FROM public.sales s
      WHERE s.id = sale_items.sale_id
        AND s.workspace_id = public.current_workspace_id()
    )
  );

DROP POLICY IF EXISTS sale_items_update ON public.sale_items;
CREATE POLICY sale_items_update
  ON public.sale_items
  FOR UPDATE
  TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND EXISTS (
      SELECT 1
      FROM public.sales s
      WHERE s.id = sale_items.sale_id
        AND s.workspace_id = public.current_workspace_id()
    )
  )
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND EXISTS (
      SELECT 1
      FROM public.sales s
      WHERE s.id = sale_items.sale_id
        AND s.workspace_id = public.current_workspace_id()
    )
  );

DROP POLICY IF EXISTS sale_items_delete ON public.sale_items;
CREATE POLICY sale_items_delete
  ON public.sale_items
  FOR DELETE
  TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND EXISTS (
      SELECT 1
      FROM public.sales s
      WHERE s.id = sale_items.sale_id
        AND s.workspace_id = public.current_workspace_id()
    )
  );

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select_self_or_workspace ON public.profiles;
CREATE POLICY profiles_select_self_or_workspace
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR workspace_id = public.current_workspace_id()
  );

DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspaces_select_current ON public.workspaces;
CREATE POLICY workspaces_select_current
  ON public.workspaces
  FOR SELECT
  TO authenticated
  USING (id = public.current_workspace_id());

DROP POLICY IF EXISTS workspaces_update_current_admin ON public.workspaces;
CREATE POLICY workspaces_update_current_admin
  ON public.workspaces
  FOR UPDATE
  TO authenticated
  USING (
    id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
  )
  WITH CHECK (
    id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
  );

ALTER TABLE public.app_permissions ENABLE ROW LEVEL SECURITY;
