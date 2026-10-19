-- A service is workspace-wide unless at least one access category is assigned.
-- Once categories are assigned, membership in any assigned category grants access.
CREATE OR REPLACE FUNCTION public.can_access_service(
  p_user_id uuid,
  p_service_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    p_user_id = auth.uid()
    AND product.workspace_id = public.current_workspace_id()
    AND public.service_access_user_in_workspace(p_user_id, product.workspace_id)
    AND public.services_module_allowed(product.workspace_id)
    AND (
      public.current_user_role() = 'admin'
      OR NOT EXISTS (
        SELECT 1
        FROM public.service_access_category_services AS assignment
        WHERE assignment.workspace_id = product.workspace_id
          AND assignment.service_id = product.id
      )
      OR EXISTS (
        SELECT 1
        FROM public.service_access_category_services AS service_category
        INNER JOIN public.service_access_category_members AS category_member
          ON category_member.workspace_id = service_category.workspace_id
          AND category_member.category_id = service_category.category_id
        WHERE service_category.workspace_id = product.workspace_id
          AND service_category.service_id = product.id
          AND category_member.user_id = p_user_id
      )
    ),
    false
  )
  FROM public.products AS product
  WHERE product.id = p_service_id
    AND COALESCE(product.is_service, false) = true;
$function$;

REVOKE ALL ON FUNCTION public.can_access_service(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_service(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.can_access_service(uuid, uuid) IS
  'Unassigned services are available to workspace users. Assigned services use OR semantics across category memberships.';
