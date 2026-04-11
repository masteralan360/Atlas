CREATE TABLE public.keys (
  key_name text NOT NULL,
  key_value text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT keys_pkey PRIMARY KEY (key_name),
  CONSTRAINT keys_key_name_check CHECK ((key_name = ANY (ARRAY['admin'::text, 'staff'::text, 'viewer'::text]))),
  CONSTRAINT keys_key_value_length_check CHECK ((char_length(key_value) = 32)),
  CONSTRAINT keys_key_value_base64_check CHECK ((key_value ~ '^[A-Za-z0-9+/]{32}$'::text)),
  CONSTRAINT keys_key_value_key UNIQUE (key_value)
);

ALTER TABLE public.keys ENABLE ROW LEVEL SECURITY;

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
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.check_registration_passkey()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    provided_key text;
    requested_role text;
    valid_key text;
    configured_key_count integer;
BEGIN
    provided_key := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'passkey', '')), '');
    requested_role := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'role', '')), '');

    IF requested_role IS NULL THEN
        RAISE EXCEPTION 'Role is required for registration. Meta: %', NEW.raw_user_meta_data;
    END IF;

    IF requested_role NOT IN ('admin', 'staff', 'viewer') THEN
        RAISE EXCEPTION 'Invalid role requested: %. Meta: %', requested_role, NEW.raw_user_meta_data;
    END IF;

    IF provided_key IS NULL THEN
        RAISE EXCEPTION 'Registration passkey is required.';
    END IF;

    PERFORM 1
    FROM public.keys
    WHERE key_name IN ('admin', 'staff', 'viewer')
    ORDER BY key_name
    FOR UPDATE;

    SELECT count(*)
    INTO configured_key_count
    FROM public.keys
    WHERE key_name IN ('admin', 'staff', 'viewer');

    IF configured_key_count <> 3 THEN
        RAISE EXCEPTION 'Registration keys are not fully configured. Expected 3 active keys, found %.', configured_key_count;
    END IF;

    SELECT key_value
    INTO valid_key
    FROM public.keys
    WHERE key_name = requested_role;

    IF valid_key IS NULL OR provided_key <> valid_key THEN
        RAISE EXCEPTION 'Invalid passkey provided for role: %.', requested_role;
    END IF;

    PERFORM public.rotate_registration_keys();

    NEW.raw_user_meta_data = COALESCE(NEW.raw_user_meta_data, '{}'::jsonb) - 'passkey';

    RETURN NEW;
END;
$function$;

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
$function$;

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
$function$;

SELECT public.rotate_registration_keys();

DELETE FROM public.app_permissions
WHERE key_name IN (
  'registration_passkey',
  'admin_passkey',
  'staff_passkey',
  'viewer_passkey'
);
