CREATE OR REPLACE FUNCTION public.check_return_permissions(p_sale_id uuid, p_user_id uuid)
 RETURNS TABLE(workspace_id uuid, role text, pos boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    RETURN QUERY
    SELECT 
        s.workspace_id,
        pr.role,
        w.pos
    FROM public.sales s
    JOIN public.profiles pr ON pr.id = p_user_id AND pr.workspace_id = s.workspace_id
    JOIN public.workspaces w ON w.id = s.workspace_id
    WHERE s.id = p_sale_id;
END;
$function$
