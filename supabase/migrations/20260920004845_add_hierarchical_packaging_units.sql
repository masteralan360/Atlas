-- Generic two-level selling units. Inventory is always stored in the smaller
-- (child) unit; a product supplies its own conversion factor and independent
-- prices for both selling units.

SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.unit_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NULL,
  parent_unit_ref text NOT NULL,
  parent_unit_code text NOT NULL,
  child_unit_ref text NOT NULL,
  child_unit_code text NOT NULL,
  is_archived boolean NOT NULL DEFAULT false,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT unit_relationships_distinct_units CHECK (parent_unit_ref <> child_unit_ref),
  CONSTRAINT unit_relationships_parent_ref_format CHECK (parent_unit_ref ~ '^(builtin|custom):.+$'),
  CONSTRAINT unit_relationships_child_ref_format CHECK (child_unit_ref ~ '^(builtin|custom):.+$'),
  CONSTRAINT unit_relationships_parent_code_not_blank CHECK (char_length(btrim(parent_unit_code)) > 0),
  CONSTRAINT unit_relationships_child_code_not_blank CHECK (char_length(btrim(child_unit_code)) > 0)
);

CREATE TABLE IF NOT EXISTS public.product_unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  relationship_id uuid NOT NULL REFERENCES public.unit_relationships(id) ON DELETE RESTRICT,
  factor numeric NOT NULL,
  parent_price numeric NOT NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT product_unit_conversions_product_unique UNIQUE (product_id),
  CONSTRAINT product_unit_conversions_factor_positive CHECK (
    factor > 0 AND factor::text NOT IN ('NaN', 'Infinity', '-Infinity')
  ),
  CONSTRAINT product_unit_conversions_parent_price_nonnegative CHECK (
    parent_price >= 0 AND parent_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
  )
);

CREATE TABLE IF NOT EXISTS public.price_book_unit_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  price_book_id uuid NOT NULL REFERENCES public.price_books(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  unit_ref text NOT NULL,
  price numeric NOT NULL,
  currency text NOT NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT price_book_unit_prices_unique UNIQUE (price_book_id, product_id, unit_ref),
  CONSTRAINT price_book_unit_prices_ref_format CHECK (unit_ref ~ '^(builtin|custom):.+$'),
  CONSTRAINT price_book_unit_prices_price_nonnegative CHECK (
    price >= 0 AND price::text NOT IN ('NaN', 'Infinity', '-Infinity')
  ),
  CONSTRAINT price_book_unit_prices_currency_check CHECK (currency IN ('usd', 'eur', 'iqd', 'try'))
);

CREATE INDEX IF NOT EXISTS idx_unit_relationships_workspace_updated
  ON public.unit_relationships (workspace_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_relationships_active_pair
  ON public.unit_relationships (workspace_id, parent_unit_ref, child_unit_ref)
  WHERE is_deleted = false AND is_archived = false;
CREATE INDEX IF NOT EXISTS idx_product_unit_conversions_workspace_updated
  ON public.product_unit_conversions (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_unit_conversions_relationship
  ON public.product_unit_conversions (workspace_id, relationship_id);
CREATE INDEX IF NOT EXISTS idx_price_book_unit_prices_workspace_updated
  ON public.price_book_unit_prices (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_book_unit_prices_product
  ON public.price_book_unit_prices (workspace_id, product_id);

DROP TRIGGER IF EXISTS update_unit_relationships_updated_at ON public.unit_relationships;
CREATE TRIGGER update_unit_relationships_updated_at
BEFORE UPDATE ON public.unit_relationships
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_product_unit_conversions_updated_at ON public.product_unit_conversions;
CREATE TRIGGER update_product_unit_conversions_updated_at
BEFORE UPDATE ON public.product_unit_conversions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_price_book_unit_prices_updated_at ON public.price_book_unit_prices;
CREATE TRIGGER update_price_book_unit_prices_updated_at
BEFORE UPDATE ON public.price_book_unit_prices
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.validate_unit_relationship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unit-relationships:' || NEW.workspace_id::text, 0)
  );
  IF NEW.parent_unit_ref = NEW.child_unit_ref THEN
    RAISE EXCEPTION 'A unit cannot contain itself' USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_unit_ref LIKE 'builtin:%'
    AND NEW.parent_unit_ref <> ('builtin:' || lower(btrim(NEW.parent_unit_code)))
  THEN
    RAISE EXCEPTION 'Parent built-in unit reference does not match its code' USING ERRCODE = '23514';
  END IF;
  IF NEW.child_unit_ref LIKE 'builtin:%'
    AND NEW.child_unit_ref <> ('builtin:' || lower(btrim(NEW.child_unit_code)))
  THEN
    RAISE EXCEPTION 'Child built-in unit reference does not match its code' USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_unit_ref LIKE 'custom:%' AND NOT EXISTS (
    SELECT 1 FROM public.units
    WHERE id = substring(NEW.parent_unit_ref FROM 8)::uuid
      AND workspace_id = NEW.workspace_id
      AND lower(btrim(code)) = lower(btrim(NEW.parent_unit_code))
      AND is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Parent custom unit is unavailable in this workspace' USING ERRCODE = '23503';
  END IF;

  IF NEW.child_unit_ref LIKE 'custom:%' AND NOT EXISTS (
    SELECT 1 FROM public.units
    WHERE id = substring(NEW.child_unit_ref FROM 8)::uuid
      AND workspace_id = NEW.workspace_id
      AND lower(btrim(code)) = lower(btrim(NEW.child_unit_code))
      AND is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Child custom unit is unavailable in this workspace' USING ERRCODE = '23503';
  END IF;

  IF NOT NEW.is_archived AND EXISTS (
    SELECT 1 FROM public.unit_relationships
    WHERE workspace_id = NEW.workspace_id
      AND id <> NEW.id
      AND is_deleted = false
      AND is_archived = false
      AND parent_unit_ref = NEW.child_unit_ref
      AND child_unit_ref = NEW.parent_unit_ref
  ) THEN
    RAISE EXCEPTION 'The reverse unit relationship already exists' USING ERRCODE = '23514';
  END IF;

  IF NOT NEW.is_archived AND EXISTS (
    WITH RECURSIVE edges(parent_ref, child_ref) AS (
      SELECT parent_unit_ref, child_unit_ref
      FROM public.unit_relationships
      WHERE workspace_id = NEW.workspace_id
        AND id <> NEW.id
        AND is_deleted = false
        AND is_archived = false
      UNION ALL
      SELECT NEW.parent_unit_ref, NEW.child_unit_ref
    ), reachable(unit_ref) AS (
      SELECT NEW.child_unit_ref
      UNION
      SELECT edges.child_ref
      FROM reachable
      JOIN edges ON edges.parent_ref = reachable.unit_ref
    )
    SELECT 1 FROM reachable WHERE unit_ref = NEW.parent_unit_ref
  ) THEN
    RAISE EXCEPTION 'Unit relationships cannot contain a cycle' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
    AND (NEW.parent_unit_ref, NEW.child_unit_ref) IS DISTINCT FROM (OLD.parent_unit_ref, OLD.child_unit_ref)
    AND EXISTS (
      SELECT 1 FROM public.product_unit_conversions
      WHERE relationship_id = OLD.id AND is_deleted = false
    )
  THEN
    RAISE EXCEPTION 'Used relationship endpoints are immutable' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Custom unit reference is invalid' USING ERRCODE = '22023';
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_product_unit_conversion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_relationship public.unit_relationships%ROWTYPE;
  v_child_dynamic boolean := false;
BEGIN
  SELECT * INTO v_relationship
  FROM public.unit_relationships
  WHERE id = NEW.relationship_id
    AND workspace_id = NEW.workspace_id
    AND is_deleted = false
    AND (
      is_archived = false
      OR (TG_OP = 'UPDATE' AND OLD.relationship_id = NEW.relationship_id)
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unit relationship is unavailable' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = NEW.product_id
      AND workspace_id = NEW.workspace_id
      AND is_deleted = false
      AND lower(btrim(unit)) = lower(btrim(v_relationship.child_unit_code))
  ) THEN
    RAISE EXCEPTION 'Product inventory unit must be the relationship child unit' USING ERRCODE = '23514';
  END IF;

  IF v_relationship.child_unit_ref LIKE 'custom:%' THEN
    SELECT is_dynamic INTO v_child_dynamic
    FROM public.units
    WHERE id = substring(v_relationship.child_unit_ref FROM 8)::uuid
      AND workspace_id = NEW.workspace_id
      AND is_deleted = false;
  ELSE
    v_child_dynamic := lower(btrim(v_relationship.child_unit_code)) IN ('m²', 'kg', 'meter');
  END IF;

  IF NOT COALESCE(v_child_dynamic, false) AND trunc(NEW.factor) <> NEW.factor THEN
    RAISE EXCEPTION 'Static child units require a whole-number conversion factor' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_price_book_unit_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.price_books
    WHERE id = NEW.price_book_id AND workspace_id = NEW.workspace_id AND is_deleted = false
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = NEW.product_id AND workspace_id = NEW.workspace_id AND is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Price Book and product must belong to the same workspace' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.product_unit_conversions conversion
    JOIN public.unit_relationships relationship ON relationship.id = conversion.relationship_id
    WHERE conversion.product_id = NEW.product_id
      AND conversion.workspace_id = NEW.workspace_id
      AND conversion.is_deleted = false
      AND relationship.is_deleted = false
      AND NEW.unit_ref IN (relationship.parent_unit_ref, relationship.child_unit_ref)
  ) THEN
    RAISE EXCEPTION 'Unit price must reference a selling unit configured for the product' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_unit_relationship_on_write ON public.unit_relationships;
CREATE TRIGGER validate_unit_relationship_on_write
BEFORE INSERT OR UPDATE ON public.unit_relationships
FOR EACH ROW EXECUTE FUNCTION public.validate_unit_relationship();

DROP TRIGGER IF EXISTS validate_product_unit_conversion_on_write ON public.product_unit_conversions;
CREATE TRIGGER validate_product_unit_conversion_on_write
BEFORE INSERT OR UPDATE ON public.product_unit_conversions
FOR EACH ROW EXECUTE FUNCTION public.validate_product_unit_conversion();

DROP TRIGGER IF EXISTS validate_price_book_unit_price_on_write ON public.price_book_unit_prices;
CREATE TRIGGER validate_price_book_unit_price_on_write
BEFORE INSERT OR UPDATE ON public.price_book_unit_prices
FOR EACH ROW EXECUTE FUNCTION public.validate_price_book_unit_price();

CREATE OR REPLACE FUNCTION public.maintain_custom_unit_relationship_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_ref text := 'custom:' || OLD.id::text;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.is_deleted = true AND OLD.is_deleted = false) THEN
    IF EXISTS (
      SELECT 1 FROM public.unit_relationships
      WHERE workspace_id = OLD.workspace_id
        AND is_deleted = false
        AND (parent_unit_ref = v_ref OR child_unit_ref = v_ref)
    ) THEN
      RAISE EXCEPTION 'Unit is used by a unit relationship' USING ERRCODE = '23503';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.code IS DISTINCT FROM OLD.code THEN
    UPDATE public.unit_relationships
    SET parent_unit_code = CASE WHEN parent_unit_ref = v_ref THEN NEW.code ELSE parent_unit_code END,
        child_unit_code = CASE WHEN child_unit_ref = v_ref THEN NEW.code ELSE child_unit_code END,
        updated_at = timezone('utc', now()),
        version = version + 1
    WHERE workspace_id = NEW.workspace_id
      AND is_deleted = false
      AND (parent_unit_ref = v_ref OR child_unit_ref = v_ref);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS protect_custom_unit_relationship_references_on_units ON public.units;
CREATE TRIGGER protect_custom_unit_relationship_references_on_units
BEFORE DELETE OR UPDATE OF is_deleted ON public.units
FOR EACH ROW EXECUTE FUNCTION public.maintain_custom_unit_relationship_references();

DROP TRIGGER IF EXISTS rename_custom_unit_relationship_references_on_units ON public.units;
CREATE TRIGGER rename_custom_unit_relationship_references_on_units
AFTER UPDATE OF code ON public.units
FOR EACH ROW EXECUTE FUNCTION public.maintain_custom_unit_relationship_references();

DO $policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'unit_relationships',
    'product_unit_conversions',
    'price_book_unit_prices'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_select', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (workspace_id = public.current_workspace_id())',
      table_name || '_select', table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_insert', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_insert', table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_update', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff'')) WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_update', table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_delete', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_delete', table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated, service_role', table_name);
  END LOOP;
END;
$policies$;

-- Atomic one-time normalization for existing products counted in the parent
-- unit. The RPC is intentionally unavailable offline because every inventory
-- and batch row must move together.
CREATE OR REPLACE FUNCTION public.convert_product_inventory_to_child_unit(
  p_product_id uuid,
  p_factor numeric,
  p_child_unit_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid;
  v_current_unit text;
BEGIN
  IF auth.uid() IS NULL
    OR public.current_user_role() NOT IN ('admin', 'staff')
  THEN
    RAISE EXCEPTION 'You are not allowed to convert product inventory' USING ERRCODE = '42501';
  END IF;

  IF p_factor IS NULL OR p_factor <= 0
    OR p_factor::text IN ('NaN', 'Infinity', '-Infinity')
    OR NULLIF(btrim(p_child_unit_code), '') IS NULL
  THEN
    RAISE EXCEPTION 'A positive finite factor and child unit are required' USING ERRCODE = '22023';
  END IF;

  SELECT workspace_id, unit INTO v_workspace_id, v_current_unit
  FROM public.products
  WHERE id = p_product_id AND is_deleted = false
  FOR UPDATE;

  IF NOT FOUND OR v_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Product is unavailable in the current workspace' USING ERRCODE = '23503';
  END IF;
  IF lower(btrim(v_current_unit)) = lower(btrim(p_child_unit_code)) THEN
    RAISE EXCEPTION 'Product inventory is already stored in the child unit' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.inventory
  WHERE workspace_id = v_workspace_id AND product_id = p_product_id
  ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.stock_batches
  WHERE workspace_id = v_workspace_id AND product_id = p_product_id
  ORDER BY id FOR UPDATE;

  UPDATE public.inventory
  SET quantity = round(quantity * p_factor, 6),
      updated_at = now(),
      version = COALESCE(version, 0) + 1
  WHERE workspace_id = v_workspace_id AND product_id = p_product_id;

  UPDATE public.stock_batches
  SET quantity = round(quantity * p_factor, 6),
      price = CASE WHEN price IS NULL THEN NULL ELSE price / p_factor END,
      cost_price = CASE WHEN cost_price IS NULL THEN NULL ELSE cost_price / p_factor END,
      updated_at = now(),
      version = COALESCE(version, 0) + 1
  WHERE workspace_id = v_workspace_id AND product_id = p_product_id;

  UPDATE public.products
  SET unit = btrim(p_child_unit_code),
      quantity = round(quantity * p_factor, 6),
      min_stock_level = round(min_stock_level * p_factor, 6),
      cost_price = CASE WHEN cost_price IS NULL THEN NULL ELSE cost_price / p_factor END,
      updated_at = now(),
      version = COALESCE(version, 0) + 1
  WHERE id = p_product_id;

  RETURN jsonb_build_object('success', true, 'product_id', p_product_id, 'factor', p_factor);
END;
$function$;

REVOKE ALL ON FUNCTION public.convert_product_inventory_to_child_unit(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_product_inventory_to_child_unit(uuid, numeric, text) TO authenticated, service_role;

-- Immutable selling-unit snapshots on each sale line.
ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS selling_unit_ref text NULL,
  ADD COLUMN IF NOT EXISTS selling_unit_code text NULL,
  ADD COLUMN IF NOT EXISTS base_unit_ref text NULL,
  ADD COLUMN IF NOT EXISTS base_unit_code text NULL,
  ADD COLUMN IF NOT EXISTS unit_factor numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS inventory_quantity numeric NULL;

UPDATE public.sale_items
SET inventory_quantity = quantity
WHERE inventory_quantity IS NULL;

ALTER TABLE public.sale_items
  ALTER COLUMN inventory_quantity SET NOT NULL;

ALTER TABLE public.sale_items DROP CONSTRAINT IF EXISTS sale_items_unit_factor_positive;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_unit_factor_positive CHECK (
  unit_factor > 0 AND unit_factor::text NOT IN ('NaN', 'Infinity', '-Infinity')
);
ALTER TABLE public.sale_items DROP CONSTRAINT IF EXISTS sale_items_inventory_quantity_positive;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_inventory_quantity_positive CHECK (
  inventory_quantity > 0 AND inventory_quantity::text NOT IN ('NaN', 'Infinity', '-Infinity')
);
ALTER TABLE public.sale_items DROP CONSTRAINT IF EXISTS sale_items_inventory_quantity_matches_factor;
ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_inventory_quantity_matches_factor CHECK (
  abs(inventory_quantity - (quantity * unit_factor)) <= 0.000001
);

CREATE OR REPLACE FUNCTION public.fill_sale_item_unit_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  NEW.unit_factor := COALESCE(NEW.unit_factor, 1);
  NEW.inventory_quantity := COALESCE(NEW.inventory_quantity, NEW.quantity * NEW.unit_factor);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS fill_sale_item_unit_snapshot_on_write ON public.sale_items;
CREATE TRIGGER fill_sale_item_unit_snapshot_on_write
BEFORE INSERT OR UPDATE OF quantity, unit_factor, inventory_quantity ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.fill_sale_item_unit_snapshot();

-- Do not trust the checkout client to choose its own conversion factor. The
-- immutable snapshot must exactly match the product's configured relationship
-- at the moment the sale is recorded. Historical rows remain self-contained
-- after a product later changes or removes its relationship.
CREATE OR REPLACE FUNCTION public.validate_sale_item_unit_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_configured_factor numeric;
  v_parent_unit_ref text;
  v_parent_unit_code text;
  v_child_unit_ref text;
  v_child_unit_code text;
  v_product_unit text;
BEGIN
  IF NEW.selling_unit_ref IS NULL THEN
    IF NEW.base_unit_ref IS NOT NULL
      OR NEW.selling_unit_code IS DISTINCT FROM NEW.base_unit_code
      OR NEW.unit_factor <> 1
      OR pg_catalog.abs(NEW.inventory_quantity - NEW.quantity) > 0.000001
    THEN
      RAISE EXCEPTION 'A regular sale item cannot contain a partial unit snapshot'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT conversion.factor,
    relationship.parent_unit_ref,
    relationship.parent_unit_code,
    relationship.child_unit_ref,
    relationship.child_unit_code,
    product.unit
  INTO v_configured_factor,
    v_parent_unit_ref,
    v_parent_unit_code,
    v_child_unit_ref,
    v_child_unit_code,
    v_product_unit
  FROM public.product_unit_conversions conversion
  JOIN public.unit_relationships relationship
    ON relationship.id = conversion.relationship_id
  JOIN public.products product
    ON product.id = conversion.product_id
    AND product.workspace_id = conversion.workspace_id
    AND product.is_deleted = false
  WHERE conversion.product_id = NEW.product_id
    AND conversion.is_deleted = false
    AND relationship.is_deleted = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product does not have an active unit conversion'
      USING ERRCODE = '23503';
  END IF;

  IF lower(btrim(v_product_unit)) <> lower(btrim(v_child_unit_code)) THEN
    RAISE EXCEPTION 'Product inventory unit no longer matches its configured base unit'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.base_unit_ref IS DISTINCT FROM v_child_unit_ref
    OR NEW.base_unit_code IS DISTINCT FROM v_child_unit_code
  THEN
    RAISE EXCEPTION 'Sale item base unit does not match the product conversion'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.selling_unit_ref = v_parent_unit_ref THEN
    IF NEW.selling_unit_code IS DISTINCT FROM v_parent_unit_code
      OR NEW.unit_factor IS DISTINCT FROM v_configured_factor
    THEN
      RAISE EXCEPTION 'Sale item parent unit snapshot does not match the product conversion'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.selling_unit_ref = v_child_unit_ref THEN
    IF NEW.selling_unit_code IS DISTINCT FROM v_child_unit_code
      OR NEW.unit_factor <> 1
    THEN
      RAISE EXCEPTION 'Sale item child unit snapshot does not match the product conversion'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Sale item selling unit is not configured for the product'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_sale_item_unit_snapshot_on_write ON public.sale_items;
CREATE TRIGGER validate_sale_item_unit_snapshot_on_write
BEFORE INSERT OR UPDATE OF product_id, quantity, selling_unit_ref, selling_unit_code,
  base_unit_ref, base_unit_code, unit_factor, inventory_quantity
ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.validate_sale_item_unit_snapshot();

-- Batch allocations are expressed in canonical inventory units. Cost on a
-- sale item is per sold unit, so a parent-unit line divides total allocated
-- batch cost by the sold quantity rather than by the base allocation count.
CREATE OR REPLACE FUNCTION public.apply_sale_item_batch_cost()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_allocation_count integer := 0;
  v_cost_count integer := 0;
  v_allocated_quantity numeric := 0;
  v_total_cost numeric := 0;
  v_distinct_currency_count integer := 0;
  v_allocation_currency text := NULL;
  v_previous_cost numeric := 0;
  v_conversion_factor numeric := 1;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.batch_allocations) <> 'array'
    OR pg_catalog.jsonb_array_length(NEW.batch_allocations) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*),
    COUNT(*) FILTER (WHERE allocation->>'cost_price' IS NOT NULL),
    COALESCE(SUM((allocation->>'quantity')::numeric), 0),
    COALESCE(SUM((allocation->>'quantity')::numeric * (allocation->>'cost_price')::numeric)
      FILTER (WHERE allocation->>'cost_price' IS NOT NULL), 0),
    COUNT(DISTINCT pg_catalog.lower(NULLIF(allocation->>'currency', ''))),
    MIN(pg_catalog.lower(NULLIF(allocation->>'currency', '')))
  INTO v_allocation_count, v_cost_count, v_allocated_quantity, v_total_cost,
    v_distinct_currency_count, v_allocation_currency
  FROM pg_catalog.jsonb_array_elements(NEW.batch_allocations) AS allocation
  WHERE COALESCE((allocation->>'quantity')::numeric, 0) > 0;

  IF v_allocation_count = 0 OR v_cost_count <> v_allocation_count
    OR v_allocated_quantity <= 0
    OR pg_catalog.abs(v_allocated_quantity - NEW.inventory_quantity) > 0.000001
    OR v_distinct_currency_count > 1
    OR (v_allocation_currency IS NOT NULL
      AND v_allocation_currency <> pg_catalog.lower(COALESCE(NEW.original_currency, v_allocation_currency)))
  THEN
    RETURN NEW;
  END IF;

  v_previous_cost := COALESCE(NEW.cost_price, 0);
  IF v_previous_cost > 0 THEN
    v_conversion_factor := COALESCE(NEW.converted_cost_price, v_previous_cost) / v_previous_cost;
  ELSIF pg_catalog.lower(COALESCE(NEW.original_currency, '')) = pg_catalog.lower(COALESCE(NEW.settlement_currency, '')) THEN
    v_conversion_factor := 1;
  ELSE
    RETURN NEW;
  END IF;

  NEW.cost_price := v_total_cost / NEW.quantity;
  NEW.converted_cost_price := NEW.cost_price * v_conversion_factor;
  RETURN NEW;
END;
$function$;

-- Patch the private checkout implementation installed by the inventory
-- deficit migration. Assertions make upstream drift fail loudly.
DO $patch_checkout$
DECLARE
  function_sql text;
BEGIN
  SELECT pg_get_functiondef('private.complete_sale_once(jsonb)'::regprocedure) INTO function_sql;

  IF position('v_batch_remaining := v_quantity;' IN function_sql) = 0
    OR position('quantity = quantity - v_quantity,' IN function_sql) = 0
    OR position('price_book_id' IN function_sql) = 0
  THEN
    RAISE EXCEPTION 'complete_sale_once does not contain the expected inventory implementation';
  END IF;

  function_sql := replace(
    function_sql,
    'IF v_quantity > v_inventory_snapshot THEN',
    'IF COALESCE((item->>''inventory_quantity'')::numeric, v_quantity) > v_inventory_snapshot THEN'
  );
  function_sql := replace(
    function_sql,
    'v_batch_remaining := v_quantity;',
    'v_batch_remaining := COALESCE((item->>''inventory_quantity'')::numeric, v_quantity);'
  );
  function_sql := replace(
    function_sql,
    E'            quantity,\n            unit_price,',
    E'            quantity,\n            selling_unit_ref,\n            selling_unit_code,\n            base_unit_ref,\n            base_unit_code,\n            unit_factor,\n            inventory_quantity,\n            unit_price,'
  );
  function_sql := replace(
    function_sql,
    E'            v_quantity,\n            (item->>''unit_price'')::NUMERIC,',
    E'            v_quantity,\n            NULLIF(item->>''selling_unit_ref'', ''''),\n            NULLIF(item->>''selling_unit_code'', ''''),\n            NULLIF(item->>''base_unit_ref'', ''''),\n            NULLIF(item->>''base_unit_code'', ''''),\n            COALESCE((item->>''unit_factor'')::numeric, 1),\n            COALESCE((item->>''inventory_quantity'')::numeric, v_quantity),\n            (item->>''unit_price'')::NUMERIC,'
  );
  function_sql := replace(
    function_sql,
    'quantity = quantity - v_quantity,',
    'quantity = quantity - COALESCE((item->>''inventory_quantity'')::numeric, v_quantity),'
  );
  function_sql := replace(
    function_sql,
    'is_deleted = (quantity - v_quantity) <= 0',
    'is_deleted = (quantity - COALESCE((item->>''inventory_quantity'')::numeric, v_quantity)) <= 0'
  );
  function_sql := replace(
    function_sql,
    'AND quantity >= v_quantity;',
    'AND quantity >= COALESCE((item->>''inventory_quantity'')::numeric, v_quantity);'
  );

  IF position('selling_unit_ref' IN function_sql) = 0
    OR position('quantity = quantity - COALESCE((item->>''inventory_quantity'')::numeric, v_quantity)' IN function_sql) = 0
  THEN
    RAISE EXCEPTION 'complete_sale_once unit patch failed';
  END IF;
  EXECUTE function_sql;
END;
$patch_checkout$;

-- Returns keep their quantity in the sold unit for audit/refunds, while stock
-- and batch restoration use the immutable base-unit factor from the sale line.
DO $patch_returns$
DECLARE
  function_sql text;
BEGIN
  SELECT pg_get_functiondef('public.process_sale_return(uuid, uuid, jsonb, text, text)'::regprocedure)
  INTO function_sql;

  IF position('v_return_quantity numeric;' IN function_sql) = 0
    OR position('v_remaining_to_restore := v_return_quantity;' IN function_sql) = 0
  THEN
    RAISE EXCEPTION 'process_sale_return does not contain the expected numeric implementation';
  END IF;

  function_sql := replace(
    function_sql,
    'v_return_quantity numeric;',
    E'v_return_quantity numeric;\n  v_inventory_return_quantity numeric := 0;'
  );
  function_sql := replace(
    function_sql,
    'v_return_quantity := v_requested_quantity;',
    E'v_return_quantity := v_requested_quantity;\n    v_inventory_return_quantity := v_return_quantity * COALESCE(v_item_record.unit_factor, 1);'
  );
  function_sql := replace(
    function_sql,
    E'        v_storage_id,\n        v_return_quantity,\n        now(),',
    E'        v_storage_id,\n        v_inventory_return_quantity,\n        now(),'
  );
  function_sql := replace(
    function_sql,
    'v_remaining_to_restore := v_return_quantity;',
    'v_remaining_to_restore := v_inventory_return_quantity;'
  );

  IF position('v_inventory_return_quantity := v_return_quantity * COALESCE(v_item_record.unit_factor, 1);' IN function_sql) = 0
    OR position('v_remaining_to_restore := v_inventory_return_quantity;' IN function_sql) = 0
  THEN
    RAISE EXCEPTION 'process_sale_return unit patch failed';
  END IF;
  EXECUTE function_sql;
END;
$patch_returns$;

COMMENT ON TABLE public.unit_relationships IS
  'Workspace-defined larger-unit to smaller-unit hierarchy types; quantities remain product-specific.';
COMMENT ON TABLE public.product_unit_conversions IS
  'Per-product conversion factor and independent larger-unit selling price; product.unit is the canonical child unit.';
COMMENT ON COLUMN public.sale_items.inventory_quantity IS
  'Immutable quantity deducted/restored in the product canonical child inventory unit.';

NOTIFY pgrst, 'reload schema';
