CREATE OR REPLACE FUNCTION public.get_workspace_features()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_workspace_id UUID;
    v_result JSONB;
BEGIN
    SELECT workspace_id INTO v_workspace_id
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_workspace_id IS NULL THEN
        RETURN jsonb_build_object(
            'error', 'User does not belong to a workspace',
            'pos', false,
            'crm', true,
            'invoices_history', false,
            'is_configured', false,
            'coordination', null,
            'print_quality', 'low',
            'kds_enabled', false
        );
    END IF;

    SELECT jsonb_build_object(
        'workspace_id', id,
        'workspace_name', name,
        'data_mode', COALESCE(data_mode, 'cloud'),
        'pos', COALESCE(pos, false),
        'instant_pos', COALESCE(instant_pos, true),
        'sales_history', COALESCE(sales_history, true),
        'crm', COALESCE(crm, true),
        'travel_agency', COALESCE(travel_agency, true),
        'loans', COALESCE(loans, true),
        'net_revenue', COALESCE(net_revenue, true),
        'budget', COALESCE(budget, true),
        'monthly_comparison', COALESCE(monthly_comparison, true),
        'team_performance', COALESCE(team_performance, true),
        'products', COALESCE(products, true),
        'storages', COALESCE(storages, true),
        'inventory_transfer', COALESCE(inventory_transfer, true),
        'invoices_history', COALESCE(invoices_history, false),
        'hr', COALESCE(hr, true),
        'members', COALESCE(members, true),
        'is_configured', COALESCE(is_configured, false),
        'default_currency', COALESCE(default_currency, 'usd'),
        'iqd_display_preference', COALESCE(iqd_display_preference, 'IQD'),
        'eur_conversion_enabled', COALESCE(eur_conversion_enabled, false),
        'try_conversion_enabled', COALESCE(try_conversion_enabled, false),
        'locked_workspace', COALESCE(locked_workspace, false),
        'logo_url', logo_url,
        'coordination', coordination,
        'max_discount_percent', COALESCE(max_discount_percent, 100),
        'allow_whatsapp', COALESCE(allow_whatsapp, false),
        'kds_enabled', COALESCE(kds_enabled, false),
        'print_lang', COALESCE(print_lang, 'auto'),
        'print_qr', COALESCE(print_qr, false),
        'receipt_template', COALESCE(receipt_template, 'primary'),
        'a4_template', COALESCE(a4_template, 'primary'),
        'print_quality', COALESCE(print_quality, 'low'),
        'subscription_expires_at', subscription_expires_at
    ) INTO v_result
    FROM public.workspaces
    WHERE id = v_workspace_id;

    RETURN v_result;
END;
$function$
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
        data_mode = normalized_mode,
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
CREATE OR REPLACE FUNCTION public.admin_update_workspace_features(provided_key text, target_workspace_id uuid, new_pos boolean, new_crm boolean, new_invoices_history boolean, new_locked_workspace boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF NOT public.verify_admin_passkey(provided_key) THEN
        RAISE EXCEPTION 'Unauthorized: Invalid admin passkey';
    END IF;

    UPDATE public.workspaces
    SET 
        pos = new_pos,
        crm = new_crm,
        invoices_history = new_invoices_history,
        locked_workspace = new_locked_workspace,
        is_configured = true -- Ensure it's marked configured if admin touches it
    WHERE id = target_workspace_id;
END;
$function$
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
        w.data_mode,
        COALESCE(w.pos, false),
        COALESCE(w.crm, false),
        COALESCE(w.invoices_history, false),
        COALESCE(w.is_configured, false),
        COALESCE(w.locked_workspace, false),
        w.deleted_at,
        w.coordination,
        w.logo_url,
    FROM public.workspaces w
    ORDER BY w.created_at DESC;
END;
$function$
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

    -- Check if POS feature is enabled for this workspace
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
        COALESCE(payload->>'exchange_source', 'xeiqd'),
        COALESCE((payload->>'exchange_rate')::NUMERIC, 0),
        COALESCE((payload->>'exchange_rate_timestamp')::TIMESTAMPTZ, NOW()),
        COALESCE((payload->'exchange_rates'), '[]'::jsonb),
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
$function$
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
CREATE OR REPLACE FUNCTION public.check_return_permissions(p_sale_id uuid, p_user_id uuid)
 RETURNS TABLE(workspace_id uuid, role text, pos boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    RETURN QUERY
    SELECT 
        s.workspace_id,
        pr.role,
        w.pos
    FROM public.sales s
    JOIN public.profiles pr ON pr.id = p_user_id AND pr.workspace_id = s.workspace_id
    JOIN public.workspaces w ON w.id = s.workspace_id
    WHERE s.id = p_sale_id;
END;
$function$
