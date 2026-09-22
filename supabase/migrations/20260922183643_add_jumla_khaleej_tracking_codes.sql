ALTER TABLE public.marketplace_orders
  ADD COLUMN IF NOT EXISTS tracking_code text;

ALTER TABLE public.marketplace_orders
  ADD CONSTRAINT marketplace_orders_tracking_code_format
  CHECK (tracking_code IS NULL OR tracking_code ~ '^[1-9][0-9]{8}$');

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_orders_tracking_code_unique
  ON public.marketplace_orders (tracking_code)
  WHERE tracking_code IS NOT NULL;

CREATE OR REPLACE FUNCTION public.assign_jumla_khaleej_tracking_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  candidate text;
  bytes bytea;
  random_number bigint;
BEGIN
  IF NEW.website_storefront_key IS DISTINCT FROM 'jumla-khaleej' OR NEW.tracking_code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  FOR attempt IN 1..20 LOOP
    bytes := extensions.gen_random_bytes(4);
    random_number :=
      (pg_catalog.get_byte(bytes, 0)::bigint << 24) |
      (pg_catalog.get_byte(bytes, 1)::bigint << 16) |
      (pg_catalog.get_byte(bytes, 2)::bigint << 8) |
       pg_catalog.get_byte(bytes, 3)::bigint;
    -- Rejection sampling avoids modulo bias across the 900 million codes.
    IF random_number >= 3600000000 THEN
      CONTINUE;
    END IF;
    candidate := (100000000 + random_number % 900000000)::text;
    IF NOT EXISTS (
      SELECT 1 FROM public.marketplace_orders WHERE tracking_code = candidate
    ) THEN
      NEW.tracking_code := candidate;
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Unable to allocate storefront tracking code';
END;
$$;

DROP TRIGGER IF EXISTS assign_jumla_khaleej_tracking_code_on_write ON public.marketplace_orders;
CREATE TRIGGER assign_jumla_khaleej_tracking_code_on_write
BEFORE INSERT OR UPDATE OF website_storefront_key, tracking_code ON public.marketplace_orders
FOR EACH ROW
EXECUTE FUNCTION public.assign_jumla_khaleej_tracking_code();

UPDATE public.marketplace_orders
SET tracking_code = NULL
WHERE website_storefront_key = 'jumla-khaleej'
  AND tracking_code IS NULL;

CREATE TABLE IF NOT EXISTS public.storefront_tracking_rate_limits (
  requester_hash text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);

ALTER TABLE public.storefront_tracking_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.storefront_tracking_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.storefront_tracking_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.consume_storefront_tracking_lookups(
  p_requester_hash text,
  p_count integer
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  current_attempts integer;
BEGIN
  IF p_requester_hash IS NULL OR pg_catalog.length(p_requester_hash) <> 64
     OR p_count < 1 OR p_count > 20 THEN
    RETURN false;
  END IF;

  INSERT INTO public.storefront_tracking_rate_limits AS limits
    (requester_hash, window_started_at, attempts)
  VALUES (p_requester_hash, now(), p_count)
  ON CONFLICT (requester_hash) DO UPDATE
  SET window_started_at = CASE
        WHEN limits.window_started_at < now() - interval '1 hour' THEN now()
        ELSE limits.window_started_at
      END,
      attempts = CASE
        WHEN limits.window_started_at < now() - interval '1 hour' THEN p_count
        ELSE limits.attempts + p_count
      END
  RETURNING attempts INTO current_attempts;

  RETURN current_attempts <= 120;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_storefront_tracking_lookups(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_storefront_tracking_lookups(text, integer) TO service_role;
