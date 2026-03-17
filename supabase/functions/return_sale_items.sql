CREATE OR REPLACE FUNCTION public.return_sale_items(p_sale_item_ids uuid[], p_return_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    item_record RECORD;
    p_workspace_id UUID;
    v_user_role TEXT;
    v_allow_pos BOOLEAN;
    sale_id UUID;
BEGIN
    -- Check if array is empty
    IF p_sale_item_ids IS NULL OR array_length(p_sale_item_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'No items selected for return';
    END IF;

    -- Get first item to determine workspace and sale
    SELECT si.*, s.workspace_id
    INTO item_record
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = ANY(p_sale_item_ids)
    LIMIT 1;
    
    -- Extract workspace_id from the record
    p_workspace_id := item_record.workspace_id;
    
    IF item_record IS NULL THEN
        RAISE EXCEPTION 'Sale items not found';
    END IF;

    -- Check if POS feature is enabled
    SELECT allow_pos INTO v_allow_pos
    FROM public.workspaces
    WHERE id = p_workspace_id;

    IF NOT COALESCE(v_allow_pos, false) THEN
        RAISE EXCEPTION 'POS feature is not enabled for this workspace';
    END IF;

    -- Check user permissions (Admin or Staff can return items)
    SELECT role INTO v_user_role
    FROM public.profiles 
    WHERE id = auth.uid() 
    AND workspace_id = p_workspace_id;

    IF v_user_role NOT IN ('admin', 'staff') THEN
        RAISE EXCEPTION 'Unauthorized: Only admins and staff can return items';
    END IF;

    -- Process each item
    FOR item_record IN 
        SELECT si.*, s.id as sale_id
        FROM public.sale_items si
        JOIN public.sales s ON s.id = si.sale_id
        WHERE si.id = ANY(p_sale_item_ids)
    LOOP
        -- Check if item is already returned
        IF item_record.is_returned = TRUE THEN
            CONTINUE; -- Skip already returned items
        END IF;

        -- Update the item as returned
        UPDATE public.sale_items
        SET 
            is_returned = TRUE,
            return_reason = p_return_reason,
            returned_at = NOW(),
            returned_by = auth.uid()
        WHERE id = item_record.id;

        -- Restore inventory
        UPDATE public.products
        SET quantity = quantity + item_record.quantity
        WHERE id = item_record.product_id
          AND workspace_id = p_workspace_id;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'message', 'Items returned successfully');
END;
$function$
