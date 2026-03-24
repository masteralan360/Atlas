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
