CREATE OR REPLACE FUNCTION public.generate_workspace_code()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
    chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    new_code TEXT;
    is_unique BOOLEAN DEFAULT FALSE;
BEGIN
    WHILE NOT is_unique LOOP
        new_code := '';
        FOR i IN 1..4 LOOP
            new_code := new_code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
        END LOOP;
        new_code := new_code || '-';
        FOR i IN 1..4 LOOP
            new_code := new_code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
        END LOOP;
        
        SELECT NOT EXISTS (SELECT 1 FROM public.workspaces WHERE code = new_code) INTO is_unique;
    END LOOP;
    RETURN new_code;
END;
$function$
