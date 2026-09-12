CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.complete_sale_once(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
DECLARE
    new_sale_id UUID;
    v_sequence_id BIGINT;
    item JSONB;
    snapshot JSONB;
    v_batch_record RECORD;
    p_workspace_id UUID;
    total_sale_amount NUMERIC := 0;
    v_pos BOOLEAN;
    v_max_discount_percent INTEGER := 100;
    v_product_id UUID;
    v_storage_id UUID;
    v_quantity NUMERIC;
    v_item_index INTEGER := 0;
    v_requested_workspace_id UUID;
    v_profile_source_workspace_id UUID;
    v_profile_current_workspace_id UUID;
    v_workspace_authorized BOOLEAN := false;
    v_sales_exchange JSONB;
    v_original_currency TEXT;
    v_item_settlement_currency TEXT;
    v_original_unit_price NUMERIC;
    v_negotiated_price NUMERIC;
    v_discount_percent NUMERIC;
    v_converted_unit_price NUMERIC;
    v_inventory_snapshot NUMERIC;
    v_items_total NUMERIC := 0;
    v_flags TEXT[] := ARRAY[]::TEXT[];
    v_has_mixed_currency BOOLEAN := false;
    v_has_exchange_snapshot BOOLEAN := false;
    v_system_verified BOOLEAN := true;
    v_system_review_status TEXT := 'approved';
    v_system_review_reason TEXT := NULL;
    v_has_active_batches BOOLEAN := false;
    v_batch_remaining NUMERIC := 0;
    v_allocated_quantity NUMERIC := 0;
    v_batch_allocations JSONB := '[]'::jsonb;
    v_plan TEXT;
    v_is_service BOOLEAN := false;
BEGIN
    v_requested_workspace_id := NULLIF(payload->>'workspace_id', '')::UUID;

    SELECT workspace_id, current_workspace
    INTO v_profile_source_workspace_id, v_profile_current_workspace_id
    FROM public.profiles
    WHERE id = auth.uid();

    p_workspace_id := COALESCE(v_requested_workspace_id, v_profile_current_workspace_id);

    IF p_workspace_id IS NULL THEN
        RAISE EXCEPTION 'User does not belong to a workspace';
    END IF;

    IF p_workspace_id IS DISTINCT FROM v_profile_current_workspace_id THEN
        IF v_profile_source_workspace_id IS NULL THEN
            RAISE EXCEPTION 'User does not belong to a workspace';
        END IF;

        IF p_workspace_id = v_profile_source_workspace_id THEN
            v_workspace_authorized := true;
        ELSE
            SELECT EXISTS (
                SELECT 1
                FROM public.workspace_branches
                WHERE source_workspace_id = v_profile_source_workspace_id
                  AND branch_workspace_id = p_workspace_id
                  AND archived_at IS NULL
            )
            INTO v_workspace_authorized;
        END IF;

        IF NOT COALESCE(v_workspace_authorized, false) THEN
            RAISE EXCEPTION 'Workspace access denied';
        END IF;
    END IF;

    SELECT plan, COALESCE(max_discount_percent, 100)
    INTO v_plan, v_max_discount_percent
    FROM public.workspaces
    WHERE id = p_workspace_id;

    v_pos := public.workspace_module_allowed(p_workspace_id, v_plan, 'pos');

    IF NOT COALESCE(v_pos, false) THEN
        RAISE EXCEPTION 'POS feature is not enabled for this workspace';
    END IF;

    total_sale_amount := COALESCE((payload->>'total_amount')::NUMERIC, 0);
    v_sales_exchange := CASE
        WHEN jsonb_typeof(payload->'sales_exchange') = 'array'
            THEN payload->'sales_exchange'
        ELSE '[]'::jsonb
    END;

    FOR snapshot IN SELECT * FROM jsonb_array_elements(v_sales_exchange)
    LOOP
        IF lower(COALESCE(snapshot->>'base_currency', '')) IN ('usd', 'eur', 'iqd', 'try')
            AND lower(COALESCE(snapshot->>'quote_currency', '')) IN ('usd', 'eur', 'iqd', 'try')
            AND lower(snapshot->>'base_currency') <> lower(snapshot->>'quote_currency')
            AND COALESCE((snapshot->>'base_amount')::NUMERIC, 0) > 0
            AND COALESCE((snapshot->>'quote_amount')::NUMERIC, 0) > 0
            AND NULLIF(snapshot->>'source', '') IS NOT NULL
            AND NULLIF(snapshot->>'captured_at', '') IS NOT NULL
            AND COALESCE(NULLIF(snapshot->>'rate_side', ''), 'mid')
                IN ('buy', 'sell', 'mid')
        THEN
            v_has_exchange_snapshot := true;
        ELSE
            RAISE EXCEPTION 'Invalid sales exchange snapshot';
        END IF;
    END LOOP;

    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(payload->'items', '[]'::jsonb))
    LOOP
        v_item_index := v_item_index + 1;
        v_quantity := COALESCE((item->>'quantity')::NUMERIC, 0);
        v_converted_unit_price := COALESCE((item->>'converted_unit_price')::NUMERIC, (item->>'unit_price')::NUMERIC, 0);
        v_items_total := v_items_total + (v_converted_unit_price * v_quantity);

        IF v_quantity <= 0 THEN
            v_flags := array_append(v_flags, format('Item %s: Invalid quantity (%s)', v_item_index, v_quantity));
        END IF;

        IF item->>'negotiated_price' IS NOT NULL THEN
            v_negotiated_price := (item->>'negotiated_price')::NUMERIC;

            IF v_negotiated_price < 0 THEN
                v_flags := array_append(v_flags, format('Item %s: Negative negotiated price', v_item_index));
            ELSE
                v_original_unit_price := COALESCE((item->>'original_unit_price')::NUMERIC, (item->>'unit_price')::NUMERIC, 0);

                IF v_original_unit_price > 0 THEN
                    v_discount_percent := ((v_original_unit_price - v_negotiated_price) / v_original_unit_price) * 100;
                    IF v_discount_percent > v_max_discount_percent THEN
                        v_flags := array_append(
                            v_flags,
                            format(
                                'Item %s: Discount %s%% exceeds limit of %s%%',
                                v_item_index,
                                trim(to_char(v_discount_percent, 'FM999999990.0')),
                                v_max_discount_percent
                            )
                        );
                    END IF;
                END IF;
            END IF;
        END IF;

        v_original_currency := COALESCE(item->>'original_currency', 'usd');
        v_item_settlement_currency := COALESCE(item->>'settlement_currency', COALESCE(payload->>'settlement_currency', 'usd'));
        IF v_original_currency IS DISTINCT FROM v_item_settlement_currency THEN
            v_has_mixed_currency := true;
        END IF;

        SELECT is_service
        INTO v_is_service
        FROM public.products
        WHERE id = NULLIF(item->>'product_id', '')::uuid
          AND workspace_id = p_workspace_id;

        v_is_service := COALESCE(v_is_service, false);

        IF NOT v_is_service THEN
            v_inventory_snapshot := COALESCE((item->>'inventory_snapshot')::NUMERIC, 0);
            IF v_quantity > v_inventory_snapshot THEN
                v_flags := array_append(
                    v_flags,
                    format(
                        'Item %s: Quantity %s exceeds inventory snapshot %s',
                        v_item_index,
                        v_quantity,
                        v_inventory_snapshot
                    )
                );
            END IF;
        END IF;
    END LOOP;

    IF ABS(v_items_total - total_sale_amount) > 0.01 THEN
        v_flags := array_append(
            v_flags,
            format(
                'Total mismatch: items sum to %s, sale total is %s',
                trim(to_char(v_items_total, 'FM999999990.00')),
                trim(to_char(total_sale_amount, 'FM999999990.00'))
            )
        );
    END IF;

    IF v_has_mixed_currency THEN
        IF NOT v_has_exchange_snapshot THEN
            v_flags := array_append(v_flags, 'Missing exchange rate for multi-currency sale');
        END IF;
    END IF;

    IF COALESCE(array_length(v_flags, 1), 0) > 0 THEN
        v_system_verified := false;
        v_system_review_status := 'flagged';
        v_system_review_reason := array_to_string(v_flags, '; ');
    END IF;

    INSERT INTO public.sales (
        id,
        workspace_id,
        cashier_id,
        total_amount,
        original_total_amount,
        currency,
        settlement_currency,
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
        total_sale_amount,
        lower(COALESCE(payload->>'settlement_currency', payload->>'currency', 'usd')),
        lower(COALESCE(payload->>'settlement_currency', payload->>'currency', 'usd')),
        COALESCE(payload->>'origin', 'pos'),
        COALESCE(payload->>'payment_method', 'cash'),
        v_system_verified,
        v_system_review_status,
        v_system_review_reason,
        payload->>'notes'
    )
    RETURNING id, sequence_id INTO new_sale_id, v_sequence_id;

    FOR snapshot IN SELECT * FROM jsonb_array_elements(v_sales_exchange)
    LOOP
        INSERT INTO public.sales_exchange (
            sale_id,
            workspace_id,
            base_currency,
            quote_currency,
            base_amount,
            quote_amount,
            source,
            captured_at,
            rate_side,
            source_price_id,
            source_price_updated_at
        )
        VALUES (
            new_sale_id,
            p_workspace_id,
            lower(snapshot->>'base_currency'),
            lower(snapshot->>'quote_currency'),
            (snapshot->>'base_amount')::NUMERIC,
            (snapshot->>'quote_amount')::NUMERIC,
            snapshot->>'source',
            (snapshot->>'captured_at')::TIMESTAMPTZ,
            COALESCE(NULLIF(snapshot->>'rate_side', ''), 'mid'),
            NULLIF(snapshot->>'source_price_id', '')::UUID,
            NULLIF(snapshot->>'source_price_updated_at', '')::TIMESTAMPTZ
        );
    END LOOP;

    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(payload->'items', '[]'::jsonb))
    LOOP
        v_product_id := (item->>'product_id')::UUID;
        v_quantity := COALESCE((item->>'quantity')::NUMERIC, 0);
        v_is_service := false;
        v_storage_id := NULL;
        v_has_active_batches := false;
        v_batch_remaining := v_quantity;
        v_batch_allocations := '[]'::jsonb;

        IF v_product_id IS NULL OR v_quantity <= 0 THEN
            RAISE EXCEPTION 'Invalid sale item payload';
        END IF;

        SELECT is_service
        INTO v_is_service
        FROM public.products
        WHERE id = v_product_id
          AND workspace_id = p_workspace_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Product not found for sale item %', v_product_id;
        END IF;

        v_is_service := COALESCE(v_is_service, false);

        IF NOT v_is_service THEN
            v_storage_id := NULLIF(item->>'storage_id', '')::UUID;

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

            SELECT EXISTS (
                SELECT 1
                FROM public.stock_batches
                WHERE workspace_id = p_workspace_id
                  AND product_id = v_product_id
                  AND storage_id = v_storage_id
                  AND COALESCE(is_deleted, false) = false
            )
            INTO v_has_active_batches;

            IF v_has_active_batches THEN
                FOR v_batch_record IN
                    SELECT *
                    FROM public.stock_batches
                    WHERE workspace_id = p_workspace_id
                      AND product_id = v_product_id
                      AND storage_id = v_storage_id
                      AND COALESCE(is_deleted, false) = false
                    ORDER BY expiry_date ASC NULLS LAST, manufacturing_date ASC NULLS LAST, created_at ASC, batch_number ASC
                    FOR UPDATE
                LOOP
                    EXIT WHEN v_batch_remaining <= 0;

                    v_allocated_quantity := LEAST(v_batch_remaining, COALESCE(v_batch_record.quantity, 0));
                    IF v_allocated_quantity <= 0 THEN
                        CONTINUE;
                    END IF;

                    UPDATE public.stock_batches
                    SET
                        quantity = v_batch_record.quantity - v_allocated_quantity,
                        updated_at = NOW(),
                        version = COALESCE(version, 0) + 1,
                        is_deleted = (v_batch_record.quantity - v_allocated_quantity) <= 0
                    WHERE id = v_batch_record.id;

                    v_batch_allocations := v_batch_allocations || jsonb_build_array(
                        jsonb_build_object(
                            'batch_id', v_batch_record.id,
                            'batch_number', v_batch_record.batch_number,
                            'quantity', v_allocated_quantity,
                            'price', v_batch_record.price,
                            'cost_price', v_batch_record.cost_price,
                            'currency', lower(v_batch_record.currency),
                            'expiry_date', v_batch_record.expiry_date,
                            'manufacturing_date', v_batch_record.manufacturing_date
                        )
                    );
                    v_batch_remaining := v_batch_remaining - v_allocated_quantity;
                END LOOP;

            END IF;
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
            inventory_snapshot,
            batch_allocations,
            original_batch_allocations,
            price_book_id
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
            CASE WHEN v_is_service THEN NULL ELSE COALESCE((item->>'inventory_snapshot')::NUMERIC, 0) END,
            CASE
                WHEN NOT v_is_service AND v_has_active_batches AND jsonb_array_length(v_batch_allocations) > 0 THEN v_batch_allocations
                ELSE NULL
            END,
            CASE
                WHEN NOT v_is_service AND v_has_active_batches AND jsonb_array_length(v_batch_allocations) > 0 THEN v_batch_allocations
                ELSE NULL
            END,
            (item->>'price_book_id')::uuid
        );

        IF NOT v_is_service THEN
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
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'sale_id', new_sale_id,
        'sequence_id', v_sequence_id,
        'system_verified', v_system_verified,
        'system_review_status', v_system_review_status,
        'system_review_reason', v_system_review_reason
    );
END;
$function$;

REVOKE ALL ON FUNCTION private.complete_sale_once(jsonb) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.complete_sale_once(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_sale(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $wrapper$
DECLARE
    v_sale_id uuid;
    v_existing record;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;

    BEGIN
        v_sale_id := NULLIF(pg_catalog.btrim(payload->>'id'), '')::uuid;
    EXCEPTION
        WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'Sale id is invalid' USING ERRCODE = '22023';
    END;
    IF v_sale_id IS NOT NULL THEN
        SELECT id, sequence_id, system_verified, system_review_status, system_review_reason
        INTO v_existing
        FROM public.sales
        WHERE id = v_sale_id;

        IF FOUND THEN
            RETURN pg_catalog.jsonb_build_object(
                'success', true,
                'sale_id', v_existing.id,
                'sequence_id', v_existing.sequence_id,
                'system_verified', v_existing.system_verified,
                'system_review_status', v_existing.system_review_status,
                'system_review_reason', v_existing.system_review_reason,
                'already_applied', true
            );
        END IF;
    END IF;

    BEGIN
        RETURN private.complete_sale_once(payload);
    EXCEPTION
        WHEN unique_violation THEN
            IF v_sale_id IS NULL THEN RAISE; END IF;
            SELECT id, sequence_id, system_verified, system_review_status, system_review_reason
            INTO v_existing
            FROM public.sales
            WHERE id = v_sale_id;
            IF NOT FOUND THEN RAISE; END IF;
            RETURN pg_catalog.jsonb_build_object(
                'success', true,
                'sale_id', v_existing.id,
                'sequence_id', v_existing.sequence_id,
                'system_verified', v_existing.system_verified,
                'system_review_status', v_existing.system_review_status,
                'system_review_reason', v_existing.system_review_reason,
                'already_applied', true
            );
    END;
END;
$wrapper$;

REVOKE ALL ON FUNCTION public.complete_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_sale(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- process_sale_return: service lines are refunded like any other line but
-- never restore stock (no storage resolution, no inventory upsert, no batch
-- restore). restored_storage_id stays NULL for service lines.
-- ---------------------------------------------------------------------------;
