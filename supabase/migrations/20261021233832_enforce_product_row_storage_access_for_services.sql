-- Services without inventory remain visible as catalog entries. Products that
-- do have inventory, including services, must pass the same storage boundary
-- so a product row's aggregate quantity cannot expose excluded stock.
DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND public.current_user_can_access_product_storage(workspace_id, id, storage_id)
  );
