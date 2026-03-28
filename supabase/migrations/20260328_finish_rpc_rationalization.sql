DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND workspace_id IS NOT DISTINCT FROM public.current_workspace_id()
    AND role IS NOT DISTINCT FROM public.current_user_role()
  );

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_data_mode_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_data_mode_check
  CHECK ((data_mode::text) = ANY (ARRAY['cloud'::text, 'local'::text, 'hybrid'::text]));

CREATE OR REPLACE FUNCTION public.prevent_workspace_mode_switch()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.data_mode IS DISTINCT FROM OLD.data_mode AND COALESCE(OLD.is_configured, false) THEN
    IF COALESCE(OLD.data_mode::text, 'cloud') = 'local' OR COALESCE(NEW.data_mode::text, 'cloud') = 'local' THEN
      RAISE EXCEPTION 'Workspace mode cannot enter or leave local mode after initial configuration';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_restricted_workspace_client_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  request_role text := current_setting('request.jwt.claim.role', true);
BEGIN
  IF request_role = 'authenticated' THEN
    IF NEW.code IS DISTINCT FROM OLD.code
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
      OR NEW.locked_workspace IS DISTINCT FROM OLD.locked_workspace
      OR NEW.subscription_expires_at IS DISTINCT FROM OLD.subscription_expires_at
      OR COALESCE(NEW.member_count, 0) IS DISTINCT FROM COALESCE(OLD.member_count, 0) THEN
      RAISE EXCEPTION 'Restricted workspace fields cannot be updated from the client';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS prevent_restricted_workspace_client_updates_on_workspaces ON public.workspaces;
CREATE TRIGGER prevent_restricted_workspace_client_updates_on_workspaces
BEFORE UPDATE ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION public.prevent_restricted_workspace_client_updates();

-- Intentionally keep legacy RPCs in the database during the transition.
-- The app no longer calls them, but retaining them makes rollback safer
-- until the new direct-access + Edge Function flow has been validated in production.
--
-- Legacy functions intentionally retained but disconnected from runtime:
--   public.get_workspace_features()
--   public.configure_workspace(text, boolean, boolean, boolean, text)
--   public.create_workspace(text)
--   public.join_workspace(text)
--   public.kick_member(uuid)
--   public.verify_admin_passkey(text)
--   public.get_all_users(text)
--   public.get_all_workspaces(text)
--   public.delete_user_account(uuid)
--   public.admin_update_workspace_features(text, uuid, boolean, boolean, boolean, boolean)
--   public.admin_update_workspace_subscription(text, uuid, timestamp with time zone)
--   public.admin_schedule_workspace_mode_migration(text, uuid, text)
--   public.admin_finalize_workspace_mode_migration(text, uuid)
--
-- Create a separate cleanup migration later if you decide to remove them permanently.
