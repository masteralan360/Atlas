CREATE OR REPLACE FUNCTION public.check_feature_enabled(p_feature text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_workspace_id UUID;
    v_enabled BOOLEAN := false;
BEGIN
    SELECT workspace_id INTO v_workspace_id
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_workspace_id IS NULL THEN
        RETURN false;
    END IF;

    EXECUTE format(
        'SELECT %I FROM public.workspaces WHERE id = $1',
        p_feature
    ) INTO v_enabled USING v_workspace_id;

    RETURN COALESCE(v_enabled, false);
END;
$function$
