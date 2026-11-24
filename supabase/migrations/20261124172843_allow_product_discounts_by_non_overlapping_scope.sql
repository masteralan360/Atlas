-- A product may have multiple active discounts when each rule applies to a
-- different pricing source. The application and database both reject scopes
-- that could discount the same source.
DROP INDEX IF EXISTS public.uq_product_discounts_active_product;

CREATE INDEX IF NOT EXISTS idx_product_discounts_active_product_scope
  ON public.product_discounts (product_id, price_scope)
  WHERE is_active = true
    AND is_deleted = false;

CREATE OR REPLACE FUNCTION public.enforce_product_discount_scope_separation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_price_scope text := COALESCE(NEW.price_scope, 'all');
BEGIN
  IF NEW.is_active IS DISTINCT FROM true OR NEW.is_deleted IS DISTINCT FROM false THEN
    RETURN NEW;
  END IF;

  -- Serialize writes for this product so concurrent inserts cannot create
  -- overlapping active scopes between the conflict check and the write.
  PERFORM 1
  FROM public.products AS product
  WHERE product.id = NEW.product_id
    AND product.workspace_id = NEW.workspace_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.product_discounts AS existing
    WHERE existing.product_id = NEW.product_id
      AND existing.workspace_id = NEW.workspace_id
      AND existing.id <> NEW.id
      AND existing.is_active = true
      AND existing.is_deleted = false
      AND (
        v_price_scope = 'all'
        OR COALESCE(existing.price_scope, 'all') = 'all'
        OR (
          v_price_scope = 'native_only'
          AND COALESCE(existing.price_scope, 'all') = 'native_only'
        )
        OR (
          v_price_scope = 'specific_price_books'
          AND COALESCE(existing.price_scope, 'all') = 'specific_price_books'
          AND COALESCE(NEW.price_book_ids, ARRAY[]::uuid[])
            && COALESCE(existing.price_book_ids, ARRAY[]::uuid[])
        )
      )
  ) THEN
    RAISE EXCEPTION 'active_product_discount_scope_conflict'
      USING ERRCODE = '23505',
            CONSTRAINT = 'product_discounts_active_scope_separation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_product_discount_scope_separation ON public.product_discounts;
CREATE TRIGGER enforce_product_discount_scope_separation
  BEFORE INSERT OR UPDATE OF product_id, workspace_id, price_scope, price_book_ids, is_active, is_deleted
  ON public.product_discounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_product_discount_scope_separation();

REVOKE ALL ON FUNCTION public.enforce_product_discount_scope_separation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_product_discount_scope_separation() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
