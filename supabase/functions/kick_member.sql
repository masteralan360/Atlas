CREATE OR REPLACE FUNCTION public.kick_member(target_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    caller_role TEXT;
    caller_workspace_id UUID;
    target_role TEXT;
    target_workspace_id UUID;
BEGIN
    -- Get caller's info from JWT
    caller_role := auth.jwt() -> 'user_metadata' ->> 'role';
    caller_workspace_id := (auth.jwt() -> 'user_metadata' ->> 'workspace_id')::uuid;
    
    -- Check if caller is an admin
    IF caller_role != 'admin' THEN
        RAISE EXCEPTION 'Unauthorized: Only admins can kick members';
    END IF;
    
    -- Get target user's info from profiles
    SELECT role, workspace_id INTO target_role, target_workspace_id
    FROM public.profiles
    WHERE id = target_user_id;
    
    IF target_role IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;
    
    -- Check if target is in the same workspace
    IF target_workspace_id != caller_workspace_id THEN
        RAISE EXCEPTION 'Cannot kick members from other workspaces';
    END IF;
    
    -- Prevent kicking other admins
    IF target_role = 'admin' THEN
        RAISE EXCEPTION 'Cannot kick other admins';
    END IF;
    
    -- Prevent kicking yourself
    IF target_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Cannot kick yourself';
    END IF;
    
    -- Remove workspace_id from profiles table
    UPDATE public.profiles 
    SET workspace_id = NULL
    WHERE id = target_user_id;
    
    -- Update auth.users metadata to remove workspace info
    UPDATE auth.users
    SET raw_user_meta_data = raw_user_meta_data 
        - 'workspace_id' 
        - 'workspace_code' 
        - 'workspace_name'
    WHERE id = target_user_id;
    
    RETURN jsonb_build_object('success', true, 'message', 'Member kicked successfully');
END;
$function$
