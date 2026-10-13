ALTER TABLE public.price_book_unit_prices
  ADD COLUMN IF NOT EXISTS cost_price numeric NULL,
  ADD COLUMN IF NOT EXISTS minimum_selling_price numeric NULL;

ALTER TABLE public.price_book_items
  ADD COLUMN IF NOT EXISTS minimum_selling_price numeric NULL;

CREATE OR REPLACE FUNCTION public.validate_price_book_unit_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.is_deleted THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.price_books
    WHERE id = NEW.price_book_id
      AND workspace_id = NEW.workspace_id
      AND is_deleted = false
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = NEW.product_id
      AND workspace_id = NEW.workspace_id
      AND is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Price Book and product must belong to the same workspace' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.product_uoms AS uom
    WHERE uom.workspace_id = NEW.workspace_id
      AND uom.product_id = NEW.product_id
      AND uom.unit_ref = NEW.unit_ref
      AND uom.is_active = true
      AND uom.is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Unit price must reference an active selling unit configured for the product' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'price_book_unit_prices_cost_nonnegative'
      AND conrelid = 'public.price_book_unit_prices'::regclass
  ) THEN
    ALTER TABLE public.price_book_unit_prices
      ADD CONSTRAINT price_book_unit_prices_cost_nonnegative CHECK (
        cost_price IS NULL OR (
          cost_price >= 0
          AND cost_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'price_book_unit_prices_minimum_price_nonnegative'
      AND conrelid = 'public.price_book_unit_prices'::regclass
  ) THEN
    ALTER TABLE public.price_book_unit_prices
      ADD CONSTRAINT price_book_unit_prices_minimum_price_nonnegative CHECK (
        minimum_selling_price IS NULL OR (
          minimum_selling_price >= 0
          AND minimum_selling_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'price_book_items_minimum_price_nonnegative'
      AND conrelid = 'public.price_book_items'::regclass
  ) THEN
    ALTER TABLE public.price_book_items
      ADD CONSTRAINT price_book_items_minimum_price_nonnegative CHECK (
        minimum_selling_price IS NULL OR (
          minimum_selling_price >= 0
          AND minimum_selling_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
        )
      );
  END IF;
END;
$migration$;
