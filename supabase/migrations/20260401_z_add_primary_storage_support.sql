ALTER TABLE public.storages
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

WITH ranked_storages AS (
    SELECT
        s.id,
        COALESCE(s.is_deleted, false) AS is_deleted,
        ROW_NUMBER() OVER (
            PARTITION BY s.workspace_id
            ORDER BY
                CASE
                    WHEN COALESCE(s.is_deleted, false) = false AND COALESCE(s.is_primary, false) = true THEN 0
                    WHEN COALESCE(s.is_deleted, false) = false AND s.is_system = true AND LOWER(s.name) = 'main' THEN 1
                    WHEN COALESCE(s.is_deleted, false) = false THEN 2
                    ELSE 3
                END,
                s.is_system DESC,
                s.is_protected DESC,
                s.created_at NULLS LAST,
                s.id
        ) AS storage_rank
    FROM public.storages s
),
normalized_storages AS (
    SELECT
        id,
        CASE
            WHEN is_deleted THEN false
            ELSE storage_rank = 1
        END AS should_be_primary
    FROM ranked_storages
)
UPDATE public.storages s
SET is_primary = normalized_storages.should_be_primary
FROM normalized_storages
WHERE s.id = normalized_storages.id
  AND COALESCE(s.is_primary, false) IS DISTINCT FROM normalized_storages.should_be_primary;

CREATE UNIQUE INDEX IF NOT EXISTS storages_workspace_active_primary_key
  ON public.storages (workspace_id)
  WHERE is_primary = true AND COALESCE(is_deleted, false) = false;

CREATE OR REPLACE FUNCTION public.ensure_primary_storage(p_workspace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_primary_storage_id uuid;
BEGIN
    SELECT id
    INTO v_primary_storage_id
    FROM public.storages
    WHERE workspace_id = p_workspace_id
      AND COALESCE(is_deleted, false) = false
      AND COALESCE(is_primary, false) = true
    ORDER BY is_system DESC, is_protected DESC, created_at NULLS LAST, id
    LIMIT 1;

    IF v_primary_storage_id IS NULL THEN
        SELECT id
        INTO v_primary_storage_id
        FROM public.storages
        WHERE workspace_id = p_workspace_id
          AND COALESCE(is_deleted, false) = false
          AND LOWER(name) = 'main'
        ORDER BY is_system DESC, is_protected DESC, created_at NULLS LAST, id
        LIMIT 1;
    END IF;

    IF v_primary_storage_id IS NULL THEN
        SELECT id
        INTO v_primary_storage_id
        FROM public.storages
        WHERE workspace_id = p_workspace_id
          AND COALESCE(is_deleted, false) = false
        ORDER BY is_system DESC, is_protected DESC, created_at NULLS LAST, id
        LIMIT 1;
    END IF;

    IF v_primary_storage_id IS NULL THEN
        INSERT INTO public.storages (
            workspace_id,
            name,
            is_system,
            is_protected,
            is_primary,
            created_at,
            updated_at,
            is_deleted
        )
        VALUES (
            p_workspace_id,
            'Main',
            true,
            true,
            true,
            timezone('utc', now()),
            timezone('utc', now()),
            false
        )
        RETURNING id INTO v_primary_storage_id;

        RETURN v_primary_storage_id;
    END IF;

    UPDATE public.storages
    SET
        is_primary = (id = v_primary_storage_id),
        updated_at = CASE
            WHEN id = v_primary_storage_id AND COALESCE(is_primary, false) = false THEN timezone('utc', now())
            ELSE updated_at
        END
    WHERE workspace_id = p_workspace_id
      AND COALESCE(is_deleted, false) = false
      AND COALESCE(is_primary, false) IS DISTINCT FROM (id = v_primary_storage_id);

    RETURN v_primary_storage_id;
END;
$function$;

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
    v_primary_storage_id UUID;
    v_original_storage_missing BOOLEAN := false;
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

    v_primary_storage_id := public.ensure_primary_storage(p_workspace_id);

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
        v_original_storage_missing := false;

        IF v_storage_id IS NOT NULL THEN
            PERFORM 1
            FROM public.storages
            WHERE id = v_storage_id
              AND workspace_id = p_workspace_id
              AND COALESCE(is_deleted, false) = false;

            IF NOT FOUND THEN
                v_original_storage_missing := true;
                v_storage_id := v_primary_storage_id;
            END IF;
        END IF;

        IF v_storage_id IS NULL THEN
            SELECT CASE WHEN COUNT(*) = 1 THEN MIN(i.storage_id::text)::uuid ELSE NULL END
            INTO v_storage_id
            FROM public.inventory i
            JOIN public.storages st
              ON st.id = i.storage_id
             AND st.workspace_id = p_workspace_id
             AND COALESCE(st.is_deleted, false) = false
            WHERE i.workspace_id = p_workspace_id
              AND i.product_id = item_record.product_id
              AND COALESCE(i.is_deleted, false) = false;
        END IF;

        IF v_storage_id IS NULL THEN
            SELECT p.storage_id
            INTO v_storage_id
            FROM public.products p
            JOIN public.storages st
              ON st.id = p.storage_id
             AND st.workspace_id = p_workspace_id
             AND COALESCE(st.is_deleted, false) = false
            WHERE p.id = item_record.product_id
              AND p.workspace_id = p_workspace_id;
        END IF;

        IF v_storage_id IS NULL THEN
            v_storage_id := v_primary_storage_id;
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
            storage_id = CASE
                WHEN storage_id IS NULL OR v_original_storage_missing THEN v_storage_id
                ELSE storage_id
            END,
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
$function$;

CREATE OR REPLACE FUNCTION public.migrate_products_to_main_storage(p_workspace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_main_storage_id uuid;
BEGIN
    INSERT INTO public.storages (
        workspace_id,
        name,
        is_system,
        is_protected,
        is_primary,
        created_at,
        updated_at,
        is_deleted
    )
    SELECT
        p_workspace_id,
        'Main',
        true,
        true,
        true,
        timezone('utc', now()),
        timezone('utc', now()),
        false
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.storages
        WHERE workspace_id = p_workspace_id
          AND LOWER(name) = 'main'
          AND COALESCE(is_deleted, false) = false
    );

    SELECT id
    INTO v_main_storage_id
    FROM public.storages
    WHERE workspace_id = p_workspace_id
      AND LOWER(name) = 'main'
      AND COALESCE(is_deleted, false) = false
    ORDER BY created_at NULLS LAST, id
    LIMIT 1;

    UPDATE public.storages
    SET
        is_primary = (id = v_main_storage_id),
        updated_at = CASE
            WHEN id = v_main_storage_id AND COALESCE(is_primary, false) = false THEN timezone('utc', now())
            ELSE updated_at
        END
    WHERE workspace_id = p_workspace_id
      AND COALESCE(is_deleted, false) = false
      AND COALESCE(is_primary, false) IS DISTINCT FROM (id = v_main_storage_id);

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
    SELECT
        gen_random_uuid(),
        p.workspace_id,
        p.id,
        COALESCE(p.storage_id, v_main_storage_id),
        COALESCE(p.quantity, 0),
        COALESCE(p.created_at, timezone('utc', now())),
        COALESCE(p.updated_at, timezone('utc', now())),
        GREATEST(COALESCE(p.version, 1), 1),
        false
    FROM public.products p
    WHERE p.workspace_id = p_workspace_id
      AND COALESCE(p.is_deleted, false) = false
      AND COALESCE(p.quantity, 0) > 0
      AND COALESCE(p.storage_id, v_main_storage_id) IS NOT NULL
    ON CONFLICT (workspace_id, product_id, storage_id) DO UPDATE
    SET
        quantity = EXCLUDED.quantity,
        updated_at = EXCLUDED.updated_at,
        version = GREATEST(public.inventory.version, EXCLUDED.version),
        is_deleted = false;

    UPDATE public.products
    SET
        storage_id = COALESCE(storage_id, v_main_storage_id),
        updated_at = timezone('utc', now())
    WHERE workspace_id = p_workspace_id
      AND COALESCE(is_deleted, false) = false
      AND COALESCE(quantity, 0) > 0
      AND storage_id IS NULL
      AND v_main_storage_id IS NOT NULL;
END;
$function$;
