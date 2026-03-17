CREATE OR REPLACE FUNCTION public.delete_user_account(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_role TEXT;
    v_workspace_id UUID;
BEGIN
    -- Get user role and workspace
    SELECT role, workspace_id INTO v_role, v_workspace_id
    FROM public.profiles
    WHERE id = target_user_id;

    -- If user is admin and has a workspace, soft delete it
    IF v_role = 'admin' AND v_workspace_id IS NOT NULL THEN
        UPDATE public.workspaces
        SET deleted_at = NOW()
        WHERE id = v_workspace_id;
    END IF;

    -- Delete from public.profiles
    DELETE FROM public.profiles WHERE id = target_user_id;
    
    -- Delete from auth.users
    DELETE FROM auth.users WHERE id = target_user_id;
END;
$function$
