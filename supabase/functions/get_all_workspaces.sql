DROP FUNCTION IF EXISTS public.get_all_workspaces(text);

CREATE FUNCTION public.get_all_workspaces(provided_key text)
 RETURNS TABLE(id uuid, name text, code text, created_at timestamp with time zone, data_mode text, pos boolean, crm boolean, invoices_history boolean, is_configured boolean, locked_workspace boolean, deleted_at timestamp with time zone, coordination text, logo_url text, subscription_expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF NOT public.verify_admin_passkey(provided_key) THEN
        RAISE EXCEPTION 'Unauthorized: Invalid admin passkey';
    END IF;

    RETURN QUERY
    SELECT 
        w.id,
        w.name,
        w.code,
        w.created_at,
        w.data_mode::text,
        COALESCE(w.pos, false),
        COALESCE(w.crm, false),
        COALESCE(w.invoices_history, false),
        COALESCE(w.is_configured, false),
        COALESCE(w.locked_workspace, false),
        w.deleted_at,
        w.coordination,
        w.logo_url,
        w.subscription_expires_at
    FROM public.workspaces w
    ORDER BY w.created_at DESC;
END;
$function$
