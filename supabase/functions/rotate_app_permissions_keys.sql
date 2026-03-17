CREATE OR REPLACE FUNCTION public.rotate_app_permissions_keys()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    UPDATE public.app_permissions
    SET key_value = public.generate_random_alphanumeric_key(32)
    WHERE key_name IN (
        'registration_passkey',
        'connection_admin',
        'super_admin_passkey',
        'staff_passkey',
        'viewer_passkey',
        'update_key',
        'admin_passkey'
    );
END;
$function$
