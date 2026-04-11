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
        'connection_admin',
        'super_admin_passkey',
        'update_key'
    );

    PERFORM public.rotate_registration_keys();
END;
$function$
