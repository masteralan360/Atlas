CREATE OR REPLACE FUNCTION public.return_whole_sale(p_sale_id uuid, p_return_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_item_ids UUID[];
    v_item_quantities INTEGER[];
    v_user_role TEXT;
    v_workspace_id UUID;
BEGIN
    -- Check permissions first (Whole sale return usually requires higher privilege)
    SELECT p.role, p.workspace_id INTO v_user_role, v_workspace_id
    FROM public.check_return_permissions(p_sale_id, auth.uid()) p;

    IF v_user_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Unauthorized: Only admins can return whole sales';
    END IF;

    -- Get all non-returned quantities
    SELECT 
        array_agg(id),
        array_agg(quantity - returned_quantity)
    INTO v_item_ids, v_item_quantities
    FROM public.sale_items
    WHERE sale_id = p_sale_id AND is_returned = FALSE;

    IF v_item_ids IS NULL OR array_length(v_item_ids, 1) = 0 THEN
        RAISE EXCEPTION 'No returnable items found in this sale';
    END IF;

    -- Delegate to return_sale_items for consistency
    RETURN public.return_sale_items(v_item_ids, v_item_quantities, p_return_reason);
END;
$function$
