CREATE OR REPLACE FUNCTION public.trigger_rotate_keys_on_register()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Registration keys now rotate inside check_registration_passkey()
    -- so validation and rotation happen atomically in a single transaction.
    RETURN NEW;
END;
$function$
