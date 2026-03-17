CREATE OR REPLACE FUNCTION public.admin_update_workspace_subscription(provided_key text, target_workspace_id uuid, new_expiry timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  is_valid BOOLEAN;
BEGIN
  -- Verify admin passkey
  SELECT verify_admin_passkey(provided_key) INTO is_valid;
  IF NOT is_valid THEN
    RAISE EXCEPTION 'Unauthorized: Invalid admin passkey';
  END IF;

  UPDATE workspaces
  SET 
    subscription_expires_at = new_expiry,
    -- If the new expiry is in the past, lock the workspace. Otherwise unlock it.
    locked_workspace = (new_expiry < NOW())
  WHERE id = target_workspace_id;

  RETURN jsonb_build_object('success', true);
END;
$function$
