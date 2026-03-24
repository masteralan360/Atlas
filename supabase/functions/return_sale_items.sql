CREATE OR REPLACE FUNCTION public.return_sale_items(
    p_sale_item_ids uuid[],
    p_return_quantities integer[],
    p_return_reason text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    item_record RECORD;
    p_workspace_id UUID;
    v_user_role TEXT;
    v_pos BOOLEAN;
    v_sale_id UUID;
    v_requested_quantity INTEGER;
    v_return_quantity INTEGER;
    v_storage_id UUID;
    v_total_return_value NUMERIC := 0;
    v_sale_fully_returned BOOLEAN := false;
    idx INTEGER;
BEGIN
    IF p_sale_item_ids IS NULL OR array_length(p_sale_item_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'No items selected for return';
    END IF;

    IF p_return_quantities IS NULL OR array_length(p_return_quantities, 1) IS DISTINCT FROM array_length(p_sale_item_ids, 1) THEN
        RAISE EXCEPTION 'Return quantities must match selected sale items';
    END IF;

    SELECT si.*, s.workspace_id, s.id AS sale_id
    INTO item_record
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = ANY(p_sale_item_ids)
    LIMIT 1;

    IF item_record IS NULL THEN
        RAISE EXCEPTION 'Sale items not found';
    END IF;

    p_workspace_id := item_record.workspace_id;
    v_sale_id := item_record.sale_id;

    -- Check if POS feature is enabled for this workspace
    SELECT pos INTO v_pos
    FROM public.workspaces
    WHERE id = p_workspace_id;

    IF NOT COALESCE(v_pos, false) THEN
        RAISE EXCEPTION 'POS feature is not enabled for this workspace';
    END IF;

    SELECT role INTO v_user_role
    FROM public.profiles
    WHERE id = auth.uid()
      AND workspace_id = p_workspace_id;

    IF v_user_role NOT IN ('admin', 'staff') THEN
        RAISE EXCEPTION 'Unauthorized: Only admins and staff can return items';
    END IF;

    FOR idx IN 1..array_length(p_sale_item_ids, 1)
    LOOP
        SELECT si.*, s.workspace_id, s.id AS sale_id
        INTO item_record
        FROM public.sale_items si
        JOIN public.sales s ON s.id = si.sale_id
        WHERE si.id = p_sale_item_ids[idx]
        FOR UPDATE;

        IF item_record IS NULL THEN
            CONTINUE;
        END IF;

        IF item_record.sale_id IS DISTINCT FROM v_sale_id THEN
            RAISE EXCEPTION 'Selected sale items must belong to the same sale';
        END IF;

        v_requested_quantity := COALESCE(p_return_quantities[idx], 0);
        v_return_quantity := LEAST(
            GREATEST(v_requested_quantity, 0),
            item_record.quantity - COALESCE(item_record.returned_quantity, 0)
        );

        IF v_return_quantity <= 0 THEN
            CONTINUE;
        END IF;

        v_storage_id := item_record.storage_id;

        IF v_storage_id IS NULL THEN
            SELECT CASE WHEN COUNT(*) = 1 THEN MIN(storage_id::text)::uuid ELSE NULL END
            INTO v_storage_id
            FROM public.inventory
            WHERE workspace_id = p_workspace_id
              AND product_id = item_record.product_id
              AND COALESCE(is_deleted, false) = false;
        END IF;

        IF v_storage_id IS NULL THEN
            SELECT storage_id
            INTO v_storage_id
            FROM public.products
            WHERE id = item_record.product_id
              AND workspace_id = p_workspace_id;
        END IF;

        IF v_storage_id IS NULL THEN
            RAISE EXCEPTION 'Storage not found for returned product %', item_record.product_id;
        END IF;

        INSERT INTO public.inventory (
            id,
            workspace_id,
            product_id,
            storage_id,
            quantity,
            created_at,
            updated_at,
            version,
            is_deleted
        )
        VALUES (
            gen_random_uuid(),
            p_workspace_id,
            item_record.product_id,
            v_storage_id,
            v_return_quantity,
            NOW(),
            NOW(),
            1,
            false
        )
        ON CONFLICT (workspace_id, product_id, storage_id) DO UPDATE
        SET
            quantity = public.inventory.quantity + EXCLUDED.quantity,
            updated_at = NOW(),
            version = COALESCE(public.inventory.version, 0) + 1,
            is_deleted = false;

        UPDATE public.sale_items
        SET
            storage_id = COALESCE(storage_id, v_storage_id),
            returned_quantity = COALESCE(returned_quantity, 0) + v_return_quantity,
            is_returned = (COALESCE(returned_quantity, 0) + v_return_quantity) >= quantity,
            return_reason = p_return_reason,
            returned_at = NOW(),
            returned_by = auth.uid()
        WHERE id = item_record.id;

        v_total_return_value := v_total_return_value + (
            v_return_quantity * COALESCE(item_record.converted_unit_price, item_record.unit_price, 0)
        );
    END LOOP;

    SELECT NOT EXISTS (
        SELECT 1
        FROM public.sale_items
        WHERE sale_id = v_sale_id
          AND COALESCE(returned_quantity, 0) < quantity
    )
    INTO v_sale_fully_returned;

    UPDATE public.sales
    SET
        total_amount = GREATEST(0, COALESCE(total_amount, 0) - v_total_return_value),
        is_returned = v_sale_fully_returned,
        return_reason = CASE WHEN v_sale_fully_returned THEN p_return_reason ELSE return_reason END,
        returned_at = CASE WHEN v_sale_fully_returned THEN NOW() ELSE returned_at END,
        returned_by = CASE WHEN v_sale_fully_returned THEN auth.uid() ELSE returned_by END,
        updated_at = timezone('utc', now())
    WHERE id = v_sale_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Items returned successfully',
        'return_value', v_total_return_value
    );
END;
$function$
