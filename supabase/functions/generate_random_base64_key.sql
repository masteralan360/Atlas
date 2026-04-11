CREATE OR REPLACE FUNCTION public.generate_random_base64_key(length integer DEFAULT 32)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    generated_key text;
BEGIN
    IF length IS NULL OR length <= 0 OR length % 4 <> 0 THEN
        RAISE EXCEPTION 'Base64 key length must be a positive multiple of 4. Received: %', length;
    END IF;

    generated_key := pg_catalog.translate(
        pg_catalog.encode(extensions.gen_random_bytes((length / 4) * 3), 'base64'),
        E'\n\r',
        ''
    );

    IF pg_catalog.char_length(generated_key) <> length THEN
        RAISE EXCEPTION 'Generated key length mismatch. Expected %, got %', length, pg_catalog.char_length(generated_key);
    END IF;

    RETURN generated_key;
END;
$function$
