-- Supabase grants EXECUTE to API roles by default. Keep RPCs limited to the
-- intended authenticated callers and make trigger-only helpers non-callable.

REVOKE ALL ON FUNCTION public.enforce_service_access_category_member()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_service_access_category_service()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_service_legacy_access_policy()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_service_access_on_sale_item()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_service_access_on_sale_return()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_service_access_on_product_exchange()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_service_access_on_order_return()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION crm.enforce_service_order_items()
  FROM PUBLIC, anon, authenticated, service_role;

-- Internal lookup used only by SECURITY DEFINER RPCs and triggers.
REVOKE ALL ON FUNCTION public.service_access_user_in_workspace(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- RLS helpers and administrator RPCs remain available to authenticated users.
REVOKE ALL ON FUNCTION public.can_access_service(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.can_view_product_service_details(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_accessible_service_ids(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_service_access_workspace_members(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_service_access_settings(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.set_service_access_categories(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.set_service_access_category_members(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.sale_service_details_visible(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.sales_order_service_details_visible(uuid, uuid, jsonb) FROM anon;
