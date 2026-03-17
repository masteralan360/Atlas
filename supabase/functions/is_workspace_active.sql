CREATE OR REPLACE FUNCTION public.is_workspace_active(p_workspace_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM workspaces 
    WHERE id = p_workspace_id 
    AND (locked_workspace IS FALSE OR locked_workspace IS NULL)
    AND (subscription_expires_at IS NULL OR subscription_expires_at > NOW())
  );
END;
$function$
