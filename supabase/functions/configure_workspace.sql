CREATE OR REPLACE FUNCTION public.configure_workspace(
    p_data_mode text DEFAULT 'cloud',
    p_pos boolean DEFAULT false,
    p_crm boolean DEFAULT true,
    p_invoices_history boolean DEFAULT false,
    p_logo_url text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_workspace_id UUID;
    v_user_role TEXT;
    v_is_configured BOOLEAN;
    normalized_mode TEXT;
BEGIN
    SELECT workspace_id, role INTO v_workspace_id, v_user_role
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_workspace_id IS NULL THEN
        RAISE EXCEPTION 'User does not belong to a workspace';
    END IF;

    IF v_user_role != 'admin' THEN
        RAISE EXCEPTION 'Unauthorized: Only admins can configure workspace features';
    END IF;

    SELECT COALESCE(is_configured, false)
    INTO v_is_configured
    FROM public.workspaces
    WHERE id = v_workspace_id;

    IF v_is_configured THEN
        RAISE EXCEPTION 'Workspace has already been configured. Mode changes are not allowed.';
    END IF;

    normalized_mode := lower(COALESCE(p_data_mode, 'cloud'));

    IF normalized_mode NOT IN ('cloud', 'local') THEN
        RAISE EXCEPTION 'Invalid workspace mode: %', p_data_mode;
    END IF;

    UPDATE public.workspaces
    SET
        data_mode = normalized_mode::workspace_data_mode,
        pos = p_pos,
        crm = p_crm,
        invoices_history = p_invoices_history,
        logo_url = p_logo_url,
        is_configured = true
    WHERE id = v_workspace_id;

    RETURN jsonb_build_object(
        'success', true,
        'data_mode', normalized_mode,
        'pos', p_pos,
        'crm', p_crm,
        'invoices_history', p_invoices_history,
        'logo_url', p_logo_url
    );
END;
$function$
