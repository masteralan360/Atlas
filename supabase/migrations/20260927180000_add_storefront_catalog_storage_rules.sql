-- Storefront catalog rules can target native products, a price book, or a
-- workspace storage. Storage targets control inventory sources per storefront.

ALTER TABLE public.workspace_storefront_catalog_rules
  ADD COLUMN IF NOT EXISTS target_type text,
  ADD COLUMN IF NOT EXISTS storage_id uuid REFERENCES public.storages(id) ON DELETE CASCADE;

UPDATE public.workspace_storefront_catalog_rules
SET target_type = CASE
  WHEN storage_id IS NOT NULL THEN 'storage'
  WHEN price_book_id IS NOT NULL THEN 'price_book'
  ELSE 'native'
END
WHERE target_type IS NULL;

ALTER TABLE public.workspace_storefront_catalog_rules
  ALTER COLUMN target_type SET NOT NULL;

ALTER TABLE public.workspace_storefront_catalog_rules
  DROP CONSTRAINT IF EXISTS storefront_catalog_rules_target_matches_columns;

ALTER TABLE public.workspace_storefront_catalog_rules
  ADD CONSTRAINT storefront_catalog_rules_target_matches_columns
  CHECK (
    (target_type = 'native' AND price_book_id IS NULL AND storage_id IS NULL)
    OR (target_type = 'price_book' AND price_book_id IS NOT NULL AND storage_id IS NULL)
    OR (target_type = 'storage' AND price_book_id IS NULL AND storage_id IS NOT NULL)
  );

ALTER TABLE public.workspace_storefront_catalog_rules
  DROP CONSTRAINT IF EXISTS storefront_catalog_rules_target_type_valid;

ALTER TABLE public.workspace_storefront_catalog_rules
  ADD CONSTRAINT storefront_catalog_rules_target_type_valid
  CHECK (target_type IN ('native', 'price_book', 'storage'));

DROP INDEX IF EXISTS public.uq_storefront_catalog_rules_native;
DROP INDEX IF EXISTS public.uq_storefront_catalog_rules_price_book;

CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_catalog_rules_native
  ON public.workspace_storefront_catalog_rules (
    workspace_id,
    COALESCE(storefront_id, '00000000-0000-0000-0000-000000000000'),
    rule_type
  )
  WHERE target_type = 'native';

CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_catalog_rules_price_book
  ON public.workspace_storefront_catalog_rules (
    workspace_id,
    COALESCE(storefront_id, '00000000-0000-0000-0000-000000000000'),
    rule_type,
    price_book_id
  )
  WHERE target_type = 'price_book';

CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_catalog_rules_storage
  ON public.workspace_storefront_catalog_rules (
    workspace_id,
    COALESCE(storefront_id, '00000000-0000-0000-0000-000000000000'),
    rule_type,
    storage_id
  )
  WHERE target_type = 'storage';

CREATE OR REPLACE FUNCTION public.enforce_storefront_catalog_rule_workspace_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Older clients omit target_type. Infer it so they can continue saving
  -- existing native and price-book rules after this migration is deployed.
  IF NEW.target_type IS NULL THEN
    NEW.target_type := CASE
      WHEN NEW.storage_id IS NOT NULL THEN 'storage'
      WHEN NEW.price_book_id IS NOT NULL THEN 'price_book'
      ELSE 'native'
    END;
  END IF;

  IF NEW.target_type = 'price_book'
     AND NOT EXISTS (
       SELECT 1
       FROM public.price_books AS price_book
       WHERE price_book.id = NEW.price_book_id
         AND price_book.workspace_id = NEW.workspace_id
     )
  THEN
    RAISE EXCEPTION 'Storefront catalog rule must reference a price book in the same workspace'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.target_type = 'storage'
     AND NOT EXISTS (
       SELECT 1
       FROM public.storages AS storage
       WHERE storage.id = NEW.storage_id
         AND storage.workspace_id = NEW.workspace_id
         AND COALESCE(storage.is_deleted, false) = false
     )
  THEN
    RAISE EXCEPTION 'Storefront catalog rule must reference an active storage in the same workspace'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.storefront_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.workspace_storefronts AS storefront
       WHERE storefront.id = NEW.storefront_id
         AND storefront.workspace_id = NEW.workspace_id
     )
  THEN
    RAISE EXCEPTION 'Storefront catalog rule must reference a storefront in the same workspace'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_storefront_catalog_rule_workspace_links ON public.workspace_storefront_catalog_rules;
CREATE TRIGGER enforce_storefront_catalog_rule_workspace_links
BEFORE INSERT OR UPDATE ON public.workspace_storefront_catalog_rules
FOR EACH ROW
EXECUTE FUNCTION public.enforce_storefront_catalog_rule_workspace_links();

COMMENT ON COLUMN public.workspace_storefront_catalog_rules.target_type IS
  'Target kind for this storefront catalog rule: native, price_book, or storage.';

COMMENT ON COLUMN public.workspace_storefront_catalog_rules.storage_id IS
  'Workspace inventory source targeted by a storefront storage inclusion or exclusion rule.';
