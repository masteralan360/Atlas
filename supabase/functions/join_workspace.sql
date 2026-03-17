CREATE OR REPLACE FUNCTION public.join_workspace(workspace_code_input text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    target_workspace_id UUID;
    target_workspace_name TEXT;
    current_user_id UUID;
    current_user_role TEXT;
BEGIN
    current_user_id := auth.uid();
    
    IF current_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    
    -- Get user's current role
    SELECT role INTO current_user_role
    FROM public.profiles
    WHERE id = current_user_id;
    
    -- Find workspace by code
    SELECT id, name INTO target_workspace_id, target_workspace_name
    FROM public.workspaces
    WHERE code = UPPER(workspace_code_input);
    
    IF target_workspace_id IS NULL THEN
        RAISE EXCEPTION 'Invalid workspace code';
    END IF;
    
    -- Update profiles table
    UPDATE public.profiles
    SET workspace_id = target_workspace_id
    WHERE id = current_user_id;
    
    -- Update auth.users metadata
    UPDATE auth.users
    SET raw_user_meta_data = raw_user_meta_data || jsonb_build_object(
        'workspace_id', target_workspace_id,
        'workspace_code', UPPER(workspace_code_input),
        'workspace_name', target_workspace_name
    )
    WHERE id = current_user_id;
    
    RETURN jsonb_build_object(
        'success', true, 
        'workspace_id', target_workspace_id,
        'workspace_code', UPPER(workspace_code_input),
        'workspace_name', target_workspace_name
    );
END;
$function$
