ALTER TABLE public.storefront_promo_codes
  ADD COLUMN IF NOT EXISTS max_uses integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS used_count integer NOT NULL DEFAULT 0;

DO $promo_usage_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'storefront_promo_codes_max_uses_positive'
      AND conrelid = 'public.storefront_promo_codes'::regclass
  ) THEN
    ALTER TABLE public.storefront_promo_codes
      ADD CONSTRAINT storefront_promo_codes_max_uses_positive CHECK (max_uses > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'storefront_promo_codes_used_count_nonnegative'
      AND conrelid = 'public.storefront_promo_codes'::regclass
  ) THEN
    ALTER TABLE public.storefront_promo_codes
      ADD CONSTRAINT storefront_promo_codes_used_count_nonnegative CHECK (used_count >= 0);
  END IF;
END;
$promo_usage_constraints$;

WITH order_uses AS (
  SELECT
    workspace_id,
    upper(trim(promo_code)) AS code,
    count(*)::integer AS used_count
  FROM public.marketplace_orders
  WHERE website_storefront_key = 'jumla-khaleej'
    AND NULLIF(trim(promo_code), '') IS NOT NULL
  GROUP BY workspace_id, upper(trim(promo_code))
)
UPDATE public.storefront_promo_codes AS promo
SET used_count = GREATEST(promo.used_count, order_uses.used_count)
FROM order_uses
WHERE promo.workspace_id = order_uses.workspace_id
  AND promo.code = order_uses.code;

CREATE OR REPLACE FUNCTION public.consume_storefront_promo_code_order_submit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_promo_id uuid;
BEGIN
  IF NEW.website_storefront_key IS DISTINCT FROM 'jumla-khaleej'
    OR NULLIF(trim(COALESCE(NEW.promo_code, '')), '') IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.storefront_promo_codes
  SET used_count = used_count + 1
  WHERE workspace_id = NEW.workspace_id
    AND code = upper(trim(NEW.promo_code))
    AND is_active = true
    AND (expires_at IS NULL OR expires_at > now())
    AND used_count < max_uses
  RETURNING id INTO v_promo_id;

  IF v_promo_id IS NULL THEN
    RAISE EXCEPTION 'promo_code_limit_reached' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.consume_storefront_promo_code_order_submit() FROM PUBLIC;

DROP TRIGGER IF EXISTS consume_storefront_promo_code_order_submit
  ON public.marketplace_orders;
CREATE TRIGGER consume_storefront_promo_code_order_submit
BEFORE INSERT ON public.marketplace_orders
FOR EACH ROW
EXECUTE FUNCTION public.consume_storefront_promo_code_order_submit();
