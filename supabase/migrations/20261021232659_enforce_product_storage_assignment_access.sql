-- A product is visible to a member only when its assigned storage is
-- accessible. Stock in a different permitted storage does not expose a
-- product assigned to an excluded storage.
DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND (
      COALESCE(is_service, false)
      OR storage_id IS NULL
      OR public.current_user_can_access_storage(workspace_id, storage_id)
    )
  );
