CREATE OR REPLACE FUNCTION public.rotate_signup_safe_app_permissions_keys()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Legacy helper retained for compatibility with older trigger wiring.
    -- Registration keys now live in public.keys and rotate during signup.
    UPDATE public.app_permissions
    SET key_value = public.generate_random_alphanumeric_key(32)
    WHERE key_name IN (
        'connection_admin',
        'update_key'
    );
END;
$function$
