-- An INSERT ... ON CONFLICT DO UPDATE checks SELECT RLS against its proposed
-- row. The storage helper looks that row up in products using a STABLE snapshot,
-- where a newly inserted product does not exist yet. Even workspace admins were
-- therefore unable to upload new products, leaving their UoMs without parents.
-- Admins already have access to every product storage in their current workspace;
-- evaluate that permission directly from the proposed row. Preserve the service
-- entitlement/category policies and the existing storage checks for other roles.
ALTER POLICY products_select ON public.products
  USING (
    workspace_id = (SELECT public.current_workspace_id())
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND (
      COALESCE(is_service, false)
      OR (SELECT public.current_user_role()) = 'admin'
      OR public.current_user_can_access_product_storage(workspace_id, id, storage_id)
    )
  );
