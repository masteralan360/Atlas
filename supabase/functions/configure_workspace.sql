CREATE OR REPLACE FUNCTION public.configure_workspace(p_allow_pos boolean DEFAULT false, p_allow_customers boolean DEFAULT false, p_allow_suppliers boolean DEFAULT false, p_allow_orders boolean DEFAULT false, p_allow_invoices boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_workspace_id UUID;
    v_user_role TEXT;
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

    UPDATE public.workspaces
    SET 
        allow_pos = p_allow_pos,
        allow_customers = p_allow_customers,
        allow_suppliers = p_allow_suppliers,
        allow_orders = p_allow_orders,
        allow_invoices = p_allow_invoices,
        is_configured = true
    WHERE id = v_workspace_id;

    RETURN jsonb_build_object(
        'success', true,
        'allow_pos', p_allow_pos,
        'allow_customers', p_allow_customers,
        'allow_suppliers', p_allow_suppliers,
        'allow_orders', p_allow_orders,
        'allow_invoices', p_allow_invoices
    );
END;
$function$
