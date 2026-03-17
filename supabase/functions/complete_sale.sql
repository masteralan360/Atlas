CREATE OR REPLACE FUNCTION public.complete_sale(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    new_sale_id UUID;
    v_sequence_id BIGINT;
    item JSONB;
    p_workspace_id UUID;
    total_sale_amount NUMERIC := 0;
    v_allow_pos BOOLEAN;
BEGIN
    -- Get current user's workspace
    SELECT workspace_id INTO p_workspace_id 
    FROM public.profiles 
    WHERE id = auth.uid();

    IF p_workspace_id IS NULL THEN
        RAISE EXCEPTION 'User does not belong to a workspace';
    END IF;

    -- Check if POS feature is enabled for this workspace
    SELECT allow_pos INTO v_allow_pos
    FROM public.workspaces
    WHERE id = p_workspace_id;

    IF NOT COALESCE(v_allow_pos, false) THEN
        RAISE EXCEPTION 'POS feature is not enabled for this workspace';
    END IF;

    total_sale_amount := (payload->>'total_amount')::NUMERIC;

    -- Insert Sale Record
    INSERT INTO public.sales (
        id,
        workspace_id, 
        cashier_id, 
        total_amount, 
        settlement_currency,
        exchange_source,
        exchange_rate,
        exchange_rate_timestamp,
        exchange_rates,
        origin,
        payment_method,
        system_verified,
        system_review_status,
        system_review_reason,
        notes -- Added field
    )
    VALUES (
        COALESCE((payload->>'id')::UUID, gen_random_uuid()),
        p_workspace_id, 
        auth.uid(), 
        total_sale_amount, 
        COALESCE(payload->>'settlement_currency', 'usd'),
        COALESCE(payload->>'exchange_source', 'xeiqd'),
        COALESCE((payload->>'exchange_rate')::NUMERIC, 0),
        COALESCE((payload->>'exchange_rate_timestamp')::TIMESTAMPTZ, NOW()),
        COALESCE((payload->'exchange_rates'), '[]'::jsonb),
        COALESCE(payload->>'origin', 'pos'),
        COALESCE(payload->>'payment_method', 'cash'),
        COALESCE((payload->>'system_verified')::BOOLEAN, true),
        COALESCE(payload->>'system_review_status', 'approved'),
        payload->>'system_review_reason',
        payload->>'notes' -- Added field
    )
    RETURNING id, sequence_id INTO new_sale_id, v_sequence_id;

    -- Process Items
    FOR item IN SELECT * FROM jsonb_array_elements(payload->'items')
    LOOP
        -- Insert Sale Item
        INSERT INTO public.sale_items (
            sale_id, 
            product_id, 
            quantity, 
            unit_price, 
            total_price,
            cost_price,
            converted_cost_price,
            original_currency,
            original_unit_price,
            converted_unit_price,
            settlement_currency,
            negotiated_price,
            inventory_snapshot
        )
        VALUES (
            new_sale_id,
            (item->>'product_id')::UUID,
            (item->>'quantity')::INTEGER,
            (item->>'unit_price')::NUMERIC,
            (item->>'total_price')::NUMERIC,
            COALESCE((item->>'cost_price')::NUMERIC, 0),
            COALESCE((item->>'converted_cost_price')::NUMERIC, 0),
            COALESCE(item->>'original_currency', 'usd'),
            COALESCE((item->>'original_unit_price')::NUMERIC, (item->>'unit_price')::NUMERIC),
            COALESCE((item->>'converted_unit_price')::NUMERIC, (item->>'unit_price')::NUMERIC),
            COALESCE(item->>'settlement_currency', 'usd'),
            (item->>'negotiated_price')::NUMERIC,
            COALESCE((item->>'inventory_snapshot')::INTEGER, 0)
        );

        -- Update Inventory
        UPDATE public.products
        SET quantity = quantity - (item->>'quantity')::INTEGER
        WHERE id = (item->>'product_id')::UUID
          AND workspace_id = p_workspace_id;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true, 
        'sale_id', new_sale_id,
        'sequence_id', v_sequence_id
    );
END;
$function$
