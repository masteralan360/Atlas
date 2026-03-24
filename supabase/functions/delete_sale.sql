CREATE OR REPLACE FUNCTION public.delete_sale(p_sale_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$

DECLARE

    item RECORD;

    p_workspace_id UUID;

    v_user_role TEXT;

    v_pos BOOLEAN;

BEGIN

    -- Verify Sale Existence and Get Workspace

    SELECT workspace_id INTO p_workspace_id FROM public.sales WHERE id = p_sale_id;

    

    IF p_workspace_id IS NULL THEN

        RAISE EXCEPTION 'Sale not found';

    END IF;



    -- Check if POS feature is enabled for this workspace

    SELECT pos INTO v_pos

    FROM public.workspaces

    WHERE id = p_workspace_id;



    IF NOT COALESCE(v_pos, false) THEN

        RAISE EXCEPTION 'POS feature is not enabled for this workspace';

    END IF;



    -- Check Permissions: User must be Admin in the same workspace

    SELECT role INTO v_user_role

    FROM public.profiles 

    WHERE id = auth.uid() 

    AND workspace_id = p_workspace_id;



    IF v_user_role IS DISTINCT FROM 'admin' THEN

        RAISE EXCEPTION 'Unauthorized: Only admins can delete sales';

    END IF;



    -- Delete Sale (Cascade will handle items) - NO inventory restoration

    DELETE FROM public.sales WHERE id = p_sale_id;



    RETURN jsonb_build_object('success', true);

END;

$function$
