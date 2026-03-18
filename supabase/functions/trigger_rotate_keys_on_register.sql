CREATE OR REPLACE FUNCTION public.trigger_rotate_keys_on_register()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    PERFORM public.rotate_signup_safe_app_permissions_keys();
    RETURN NEW;
END;
$function$
