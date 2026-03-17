CREATE OR REPLACE FUNCTION public.generate_random_alphanumeric_key(length integer DEFAULT 32)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    result TEXT := '';
    i INT;
BEGIN
    FOR i IN 1..length LOOP
        result := result || pg_catalog.substr(chars, pg_catalog.floor(pg_catalog.random() * pg_catalog.length(chars) + 1)::INT, 1);
    END LOOP;
    RETURN result;
END;
$function$
