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
$function$
