ALTER TABLE public.sales
  ALTER COLUMN exchange_source DROP DEFAULT,
  ALTER COLUMN exchange_source DROP NOT NULL,
  ALTER COLUMN exchange_rate DROP DEFAULT,
  ALTER COLUMN exchange_rate DROP NOT NULL,
  ALTER COLUMN exchange_rate_timestamp DROP DEFAULT,
  ALTER COLUMN exchange_rate_timestamp DROP NOT NULL,
  ALTER COLUMN exchange_rates DROP DEFAULT;

UPDATE public.sales
SET exchange_rates = NULL
WHERE exchange_rates = 'null'::jsonb
   OR exchange_rates = '[]'::jsonb;

UPDATE public.sales
SET
  exchange_source = NULL,
  exchange_rate = NULL,
  exchange_rate_timestamp = NULL
WHERE exchange_rates IS NULL;

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
    v_pos BOOLEAN;
    v_product_id UUID;
    v_storage_id UUID;
    v_quantity INTEGER;
BEGIN
    SELECT workspace_id INTO p_workspace_id
    FROM public.profiles
    WHERE id = auth.uid();

    IF p_workspace_id IS NULL THEN
        RAISE EXCEPTION 'User does not belong to a workspace';
    END IF;

    SELECT pos INTO v_pos
    FROM public.workspaces
    WHERE id = p_workspace_id;

    IF NOT COALESCE(v_pos, false) THEN
        RAISE EXCEPTION 'POS feature is not enabled for this workspace';
    END IF;

    total_sale_amount := COALESCE((payload->>'total_amount')::NUMERIC, 0);

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
        notes
    )
    VALUES (
        COALESCE((payload->>'id')::UUID, gen_random_uuid()),
        p_workspace_id,
        auth.uid(),
        total_sale_amount,
        COALESCE(payload->>'settlement_currency', 'usd'),
        NULLIF(payload->>'exchange_source', ''),
        (payload->>'exchange_rate')::NUMERIC,
        (payload->>'exchange_rate_timestamp')::TIMESTAMPTZ,
        CASE
            WHEN jsonb_typeof(payload->'exchange_rates') = 'array' THEN
                CASE
                    WHEN jsonb_array_length(payload->'exchange_rates') > 0 THEN payload->'exchange_rates'
                    ELSE NULL
                END
            ELSE NULL
        END,
        COALESCE(payload->>'origin', 'pos'),
        COALESCE(payload->>'payment_method', 'cash'),
        COALESCE((payload->>'system_verified')::BOOLEAN, true),
        COALESCE(payload->>'system_review_status', 'approved'),
        payload->>'system_review_reason',
        payload->>'notes'
    )
    RETURNING id, sequence_id INTO new_sale_id, v_sequence_id;

    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(payload->'items', '[]'::jsonb))
    LOOP
        v_product_id := (item->>'product_id')::UUID;
        v_quantity := COALESCE((item->>'quantity')::INTEGER, 0);
        v_storage_id := NULLIF(item->>'storage_id', '')::UUID;

        IF v_product_id IS NULL OR v_quantity <= 0 THEN
            RAISE EXCEPTION 'Invalid sale item payload';
        END IF;

        IF v_storage_id IS NULL THEN
            SELECT CASE WHEN COUNT(*) = 1 THEN MIN(storage_id::text)::uuid ELSE NULL END
            INTO v_storage_id
            FROM public.inventory
            WHERE workspace_id = p_workspace_id
              AND product_id = v_product_id
              AND COALESCE(is_deleted, false) = false;
        END IF;

        IF v_storage_id IS NULL THEN
            SELECT storage_id
            INTO v_storage_id
            FROM public.products
            WHERE id = v_product_id
              AND workspace_id = p_workspace_id;
        END IF;

        IF v_storage_id IS NULL THEN
            RAISE EXCEPTION 'Storage not found for product %', v_product_id;
        END IF;

        INSERT INTO public.sale_items (
            sale_id,
            product_id,
            storage_id,
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
            v_product_id,
            v_storage_id,
            v_quantity,
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

        UPDATE public.inventory
        SET
            quantity = quantity - v_quantity,
            updated_at = NOW(),
            version = COALESCE(version, 0) + 1,
            is_deleted = (quantity - v_quantity) <= 0
        WHERE workspace_id = p_workspace_id
          AND product_id = v_product_id
          AND storage_id = v_storage_id
          AND COALESCE(is_deleted, false) = false
          AND quantity >= v_quantity;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Insufficient inventory for product % in storage %', v_product_id, v_storage_id;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'sale_id', new_sale_id,
        'sequence_id', v_sequence_id
    );
END;
$function$;
