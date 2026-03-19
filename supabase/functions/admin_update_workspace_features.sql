CREATE OR REPLACE FUNCTION public.admin_update_workspace_features(provided_key text, target_workspace_id uuid, new_allow_pos boolean, new_allow_crm boolean, new_allow_invoices boolean, new_locked_workspace boolean)
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
        allow_pos = new_allow_pos,
        allow_crm = new_allow_crm,
        allow_customers = new_allow_crm,
        allow_suppliers = new_allow_crm,
        allow_orders = new_allow_crm,
        allow_invoices = new_allow_invoices,
        locked_workspace = new_locked_workspace,
        is_configured = true -- Ensure it's marked configured if admin touches it
    WHERE id = target_workspace_id;
END;
$function$
