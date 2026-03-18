CREATE OR REPLACE FUNCTION public.rotate_signup_safe_app_permissions_keys()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Keep human-entered passkeys stable. Signup should not invalidate
    -- registration or admin/staff/viewer passkeys for the next operator.
    UPDATE public.app_permissions
    SET key_value = public.generate_random_alphanumeric_key(32)
    WHERE key_name IN (
        'connection_admin',
        'update_key'
    );
END;
$function$
