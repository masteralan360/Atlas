CREATE OR REPLACE FUNCTION public.get_all_users(provided_key text)
 RETURNS TABLE(id uuid, name text, role text, workspace_id uuid, workspace_name text, created_at timestamp with time zone, email text, phone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF NOT public.verify_admin_passkey(provided_key) THEN
        RAISE EXCEPTION 'Unauthorized: Invalid admin passkey';
    END IF;

    RETURN QUERY
    SELECT 
        u.id, 
        p.name, 
        p.role, 
        p.workspace_id,
        w.name as workspace_name,
        u.created_at,
        u.email::TEXT,
        (u.raw_user_meta_data->>'phone')::TEXT as phone
    FROM auth.users u
    LEFT JOIN public.profiles p ON u.id = p.id
    LEFT JOIN public.workspaces w ON p.workspace_id = w.id
    ORDER BY u.created_at DESC;
END;
$function$
