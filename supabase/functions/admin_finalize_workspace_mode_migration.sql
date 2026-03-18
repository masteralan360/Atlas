CREATE OR REPLACE FUNCTION public.admin_finalize_workspace_mode_migration(
    provided_key text,
    target_workspace_id uuid
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF NOT public.verify_admin_passkey(provided_key) THEN
        RAISE EXCEPTION 'Unauthorized: Invalid admin passkey';
    END IF;

    RAISE EXCEPTION 'Workspace mode switching is not supported after initial configuration';
END;
$function$
