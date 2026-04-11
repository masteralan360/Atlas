CREATE OR REPLACE FUNCTION public.rotate_registration_keys()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    INSERT INTO public.keys (key_name, key_value)
    VALUES
        ('admin', public.generate_random_base64_key(32)),
        ('staff', public.generate_random_base64_key(32)),
        ('viewer', public.generate_random_base64_key(32))
    ON CONFLICT (key_name) DO UPDATE
    SET
        key_value = EXCLUDED.key_value,
        updated_at = now();
END;
$function$
