-- Product creation writes the product without a primary storage_id, then creates
-- its first explicit storage assignment. That assignment is the visibility source,
-- so its policy must not rely on SELECT RLS for the parent row during this bootstrap.
CREATE OR REPLACE FUNCTION private.product_storage_assignment_parent_allowed(
  p_workspace_id uuid,
  p_product_id uuid,
  p_storage_id uuid,
  p_is_deleted boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p_workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(p_workspace_id, p_storage_id)
    AND EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.id = p_product_id
        AND product.workspace_id = p_workspace_id
        AND COALESCE(product.is_deleted, false) = false
        AND COALESCE(product.is_service, false) = false
        AND (
          p_is_deleted
          OR public.current_user_can_access_product_storage(
            p_workspace_id,
            p_product_id,
            product.storage_id
          )
          OR (
            product.created_by = auth.uid()
            AND product.storage_scope = 'storage'
            AND product.storage_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM public.product_storage_assignments AS assignment
              WHERE assignment.workspace_id = p_workspace_id
                AND assignment.product_id = p_product_id
                AND assignment.is_deleted = false
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.inventory AS inventory_row
              WHERE inventory_row.workspace_id = p_workspace_id
                AND inventory_row.product_id = p_product_id
                AND COALESCE(inventory_row.is_deleted, false) = false
            )
          )
        )
    );
$function$;

REVOKE ALL ON FUNCTION private.product_storage_assignment_parent_allowed(uuid, uuid, uuid, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION private.product_storage_assignment_parent_allowed(uuid, uuid, uuid, boolean)
  TO authenticated;

DROP POLICY IF EXISTS product_storage_assignments_insert ON public.product_storage_assignments;
CREATE POLICY product_storage_assignments_insert
  ON public.product_storage_assignments FOR INSERT TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND is_deleted = false
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
    AND private.product_storage_assignment_parent_allowed(
      workspace_id, product_id, storage_id, false
    )
  );

DROP POLICY IF EXISTS product_storage_assignments_update ON public.product_storage_assignments;
CREATE POLICY product_storage_assignments_update
  ON public.product_storage_assignments FOR UPDATE TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
    AND private.product_storage_assignment_parent_allowed(
      workspace_id, product_id, storage_id, is_deleted
    )
  );
