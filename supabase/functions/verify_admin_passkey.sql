CREATE OR REPLACE FUNCTION public.verify_admin_passkey(provided_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    valid_key TEXT;
BEGIN
    SELECT key_value INTO valid_key 
    FROM public.app_permissions 
    WHERE key_name = 'super_admin_passkey';
    
    RETURN provided_key = valid_key;
END;
$function$
