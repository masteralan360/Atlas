-- Drop legacy workspace/admin RPCs that have been fully replaced by
-- direct table access and Edge Functions.
--
-- Intentionally kept SQL functions such as lookup_workspace_by_code,
-- complete_sale, delete_sale, return_sale_items, and return_whole_sale
-- are not touched here.

DROP FUNCTION IF EXISTS public.admin_update_workspace_features(text, uuid, boolean, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS public.admin_update_workspace_subscription(text, uuid, timestamp with time zone);
DROP FUNCTION IF EXISTS public.admin_schedule_workspace_mode_migration(text, uuid, text);
DROP FUNCTION IF EXISTS public.admin_finalize_workspace_mode_migration(text, uuid);
DROP FUNCTION IF EXISTS public.get_all_users(text);
DROP FUNCTION IF EXISTS public.get_all_workspaces(text);
DROP FUNCTION IF EXISTS public.create_workspace(text);
DROP FUNCTION IF EXISTS public.join_workspace(text);
DROP FUNCTION IF EXISTS public.kick_member(uuid);
DROP FUNCTION IF EXISTS public.delete_user_account(uuid);
DROP FUNCTION IF EXISTS public.configure_workspace(text, boolean, boolean, boolean, text);
DROP FUNCTION IF EXISTS public.get_workspace_features();
DROP FUNCTION IF EXISTS public.check_feature_enabled(text);

-- Older environments may still have pre-rationalization RLS policies that
-- reference check_workspace_access(uuid). Remove those legacy policies first.
DROP POLICY IF EXISTS "Workspace isolation" ON public.products;
DROP POLICY IF EXISTS "Profile view" ON public.profiles;
DROP POLICY IF EXISTS "Sales viewable by workspace members" ON public.sales;
DROP POLICY IF EXISTS "Sales modifiable by workspace admins" ON public.sales;

DROP FUNCTION IF EXISTS public.check_workspace_access(uuid);
DROP FUNCTION IF EXISTS public.is_workspace_active(uuid);
DROP FUNCTION IF EXISTS public.verify_admin_passkey(text);
