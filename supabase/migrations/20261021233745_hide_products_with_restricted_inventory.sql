-- Product rows contain a workspace-wide quantity snapshot. A member must not
-- receive a product row when any of its active inventory is in an excluded
-- storage, even if the same product also has stock in an accessible storage.
CREATE OR REPLACE FUNCTION public.current_user_can_access_product_storage(
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
