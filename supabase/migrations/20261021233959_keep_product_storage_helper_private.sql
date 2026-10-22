-- Keep the RLS helper out of PostgREST's public RPC surface. The policy still
-- calls it as a narrowly scoped SECURITY DEFINER function.
DROP POLICY IF EXISTS products_select ON public.products;

CREATE OR REPLACE FUNCTION private.current_user_can_access_product_storage(
  p_workspace_id uuid,
  p_product_id uuid,
  p_storage_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    p_workspace_id = public.current_workspace_id()
    AND (
      p_storage_id IS NULL
      OR public.current_user_can_access_storage(p_workspace_id, p_storage_id)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.inventory AS inventory_row
      WHERE inventory_row.workspace_id = p_workspace_id
        AND inventory_row.product_id = p_product_id
        AND COALESCE(inventory_row.is_deleted, false) = false
        AND NOT public.current_user_can_access_storage(p_workspace_id, inventory_row.storage_id)
    );
$function$;

GRANT USAGE ON SCHEMA private TO authenticated;
REVOKE ALL ON FUNCTION private.current_user_can_access_product_storage(uuid, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION private.current_user_can_access_product_storage(uuid, uuid, uuid) TO authenticated;

CREATE POLICY products_select ON public.products FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND private.current_user_can_access_product_storage(workspace_id, id, storage_id)
  );

DROP FUNCTION public.current_user_can_access_product_storage(uuid, uuid, uuid);
