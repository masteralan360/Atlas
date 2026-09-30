-- Stage 1 of the product UoM migration.
-- This is additive and repeatable: legacy relationship tables and fields stay
-- in place, existing stock is never rewritten, and old transactions retain
-- their original quantity/factor snapshots.

SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.product_uoms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  unit_ref text NOT NULL,
  unit_code text NOT NULL,
  coefficient numeric NOT NULL,
  is_base boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  is_default_selling boolean NOT NULL DEFAULT false,
  selling_price numeric NOT NULL,
  cost_price numeric NULL,
  minimum_selling_price numeric NULL,
  sku text NULL,
  barcode text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT product_uoms_unit_ref_format CHECK (unit_ref ~ '^(builtin|custom):.+$'),
  CONSTRAINT product_uoms_unit_code_not_blank CHECK (char_length(btrim(unit_code)) > 0),
  CONSTRAINT product_uoms_coefficient_positive CHECK (
    coefficient > 0 AND coefficient::text NOT IN ('NaN', 'Infinity', '-Infinity')
  ),
  CONSTRAINT product_uoms_base_coefficient_one CHECK (NOT is_base OR coefficient = 1),
  CONSTRAINT product_uoms_non_base_coefficient_not_one CHECK (is_base OR coefficient <> 1 OR NOT is_active),
  CONSTRAINT product_uoms_selling_price_nonnegative CHECK (
    selling_price >= 0 AND selling_price::text NOT IN ('NaN', 'Infinity', '-Infinity')
  ),
  CONSTRAINT product_uoms_cost_nonnegative CHECK (
    cost_price IS NULL OR (cost_price >= 0 AND cost_price::text NOT IN ('NaN', 'Infinity', '-Infinity'))
  ),
  CONSTRAINT product_uoms_minimum_nonnegative CHECK (
    minimum_selling_price IS NULL OR (minimum_selling_price >= 0 AND minimum_selling_price::text NOT IN ('NaN', 'Infinity', '-Infinity'))
  ),
  CONSTRAINT product_uoms_product_unit_unique UNIQUE (product_id, unit_ref)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_uoms_one_active_base
  ON public.product_uoms (product_id)
  WHERE is_base AND is_active AND NOT is_deleted;
DROP INDEX IF EXISTS public.idx_product_uoms_active_default;
CREATE UNIQUE INDEX idx_product_uoms_active_default
  ON public.product_uoms (product_id)
  WHERE is_default_selling AND is_active AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_product_uoms_workspace_product
  ON public.product_uoms (workspace_id, product_id, is_active)
  WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_product_uoms_workspace_updated
  ON public.product_uoms (workspace_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_uoms_active_barcode
  ON public.product_uoms (workspace_id, lower(btrim(barcode)))
  WHERE barcode IS NOT NULL AND btrim(barcode) <> '' AND is_active AND NOT is_deleted;
DROP INDEX IF EXISTS public.idx_product_uoms_active_sku;
CREATE INDEX idx_product_uoms_active_sku
  ON public.product_uoms (workspace_id, lower(btrim(sku)))
  WHERE sku IS NOT NULL AND btrim(sku) <> '' AND is_active AND NOT is_deleted;

CREATE OR REPLACE FUNCTION public.validate_product_uom()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_product public.products%ROWTYPE;
  v_custom_unit public.units%ROWTYPE;
BEGIN
  SELECT product.* INTO v_product
  FROM public.products AS product
  WHERE product.id = NEW.product_id
    AND product.workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product UoM must belong to a product in the same workspace' USING ERRCODE = '23503';
  END IF;
  IF v_product.is_service THEN
    RAISE EXCEPTION 'Service catalog items do not use inventory product UoMs' USING ERRCODE = '23514';
  END IF;

  IF NEW.is_base AND NEW.coefficient <> 1 THEN
    RAISE EXCEPTION 'The product base UoM must have coefficient 1' USING ERRCODE = '23514';
  END IF;
  IF NEW.is_base AND NOT v_product.is_deleted AND (NOT NEW.is_active OR NEW.is_deleted) THEN
    RAISE EXCEPTION 'An active product must have an active base UoM' USING ERRCODE = '23514';
  END IF;

  IF NEW.unit_ref LIKE 'custom:%' THEN
    BEGIN
      SELECT unit.* INTO v_custom_unit
      FROM public.units AS unit
      WHERE unit.id = substring(NEW.unit_ref FROM 8)::uuid
        AND unit.workspace_id = NEW.workspace_id
        AND NOT unit.is_deleted;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Product UoM custom unit reference is invalid' USING ERRCODE = '22023';
    END;
    IF NOT FOUND OR lower(btrim(v_custom_unit.code)) <> lower(btrim(NEW.unit_code)) THEN
      RAISE EXCEPTION 'Product UoM custom unit is unavailable in this workspace' USING ERRCODE = '23503';
    END IF;
  ELSIF lower(btrim(NEW.unit_code)) <> substring(NEW.unit_ref FROM 9) THEN
    RAISE EXCEPTION 'Built-in product UoM reference does not match its unit code' USING ERRCODE = '23514';
  END IF;

  IF NEW.is_default_selling AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'An inactive product UoM cannot be the default selling unit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_product_uom_on_write ON public.product_uoms;
CREATE TRIGGER validate_product_uom_on_write
BEFORE INSERT OR UPDATE ON public.product_uoms
FOR EACH ROW EXECUTE FUNCTION public.validate_product_uom();

CREATE OR REPLACE FUNCTION public.assert_product_has_one_base_uom()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_product_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_product_id := OLD.product_id;
  ELSE
    v_product_id := NEW.product_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.products AS product
    WHERE product.id = v_product_id AND NOT product.is_deleted AND NOT product.is_service
  ) AND (
    SELECT count(*) FROM public.product_uoms AS uom
    WHERE uom.product_id = v_product_id
      AND uom.is_base AND uom.is_active AND NOT uom.is_deleted
  ) <> 1 THEN
    RAISE EXCEPTION 'An active product must have exactly one active base UoM' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS assert_product_has_one_base_uom_on_write ON public.product_uoms;
CREATE CONSTRAINT TRIGGER assert_product_has_one_base_uom_on_write
AFTER INSERT OR UPDATE OR DELETE ON public.product_uoms
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_product_has_one_base_uom();

CREATE OR REPLACE FUNCTION public.prevent_product_uom_history_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.products AS product WHERE product.id = OLD.product_id) THEN
    RAISE EXCEPTION 'Product UoM rows must be archived so historical transactions remain linked' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS prevent_product_uom_history_delete_on_write ON public.product_uoms;
CREATE TRIGGER prevent_product_uom_history_delete_on_write
BEFORE DELETE ON public.product_uoms
FOR EACH ROW EXECUTE FUNCTION public.prevent_product_uom_history_delete();

CREATE OR REPLACE FUNCTION public.sync_product_base_uom()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_unit_ref text;
BEGIN
  IF NEW.is_service THEN
    RETURN NEW;
  END IF;
  SELECT 'custom:' || unit.id::text INTO v_unit_ref
  FROM public.units AS unit
  WHERE unit.workspace_id = NEW.workspace_id
    AND lower(btrim(unit.code)) = lower(btrim(NEW.unit))
    AND NOT unit.is_deleted
  LIMIT 1;
  v_unit_ref := COALESCE(v_unit_ref, 'builtin:' || lower(btrim(NEW.unit)));

  IF TG_OP = 'UPDATE' AND lower(btrim(OLD.unit)) IS DISTINCT FROM lower(btrim(NEW.unit)) THEN
    UPDATE public.product_uoms AS old_base
    SET is_base = false,
        is_active = false,
        is_default_selling = false,
        updated_at = timezone('utc', now()),
        version = old_base.version + 1
    WHERE old_base.product_id = NEW.id
      AND old_base.is_base
      AND old_base.unit_ref <> v_unit_ref
      AND NOT old_base.is_deleted;
  END IF;

  INSERT INTO public.product_uoms (
    id, workspace_id, product_id, unit_ref, unit_code, coefficient,
    is_base, is_active, is_default_selling, selling_price, cost_price,
    minimum_selling_price, sku, created_by, created_at, updated_at,
    sync_status, version, is_deleted
  ) VALUES (
    gen_random_uuid(), NEW.workspace_id, NEW.id, v_unit_ref, btrim(NEW.unit), 1,
    true, NOT NEW.is_deleted,
    NOT NEW.is_deleted AND NOT EXISTS (
      SELECT 1 FROM public.product_uoms AS alternate
      WHERE alternate.product_id = NEW.id
        AND alternate.is_active AND NOT alternate.is_deleted
        AND alternate.is_default_selling AND NOT alternate.is_base
    ),
    NEW.price, NEW.cost_price, NEW.minimum_selling_price, NEW.sku,
    NEW.created_by, NEW.created_at, NEW.updated_at, 'synced', 1, false
  )
  ON CONFLICT (product_id, unit_ref) DO UPDATE SET
    workspace_id = EXCLUDED.workspace_id,
    unit_code = EXCLUDED.unit_code,
    coefficient = 1,
    is_base = true,
    is_active = NOT NEW.is_deleted,
    selling_price = NEW.price,
    cost_price = NEW.cost_price,
    minimum_selling_price = NEW.minimum_selling_price,
    sku = NEW.sku,
    is_default_selling = CASE
      WHEN NEW.is_deleted THEN false
      WHEN EXISTS (
        SELECT 1 FROM public.product_uoms AS alternate
        WHERE alternate.product_id = NEW.id
          AND alternate.is_active AND NOT alternate.is_deleted
          AND alternate.is_default_selling AND NOT alternate.is_base
      ) THEN false
      ELSE product_uoms.is_default_selling OR NOT EXISTS (
        SELECT 1 FROM public.product_uoms AS any_default
        WHERE any_default.product_id = NEW.id
          AND any_default.is_active AND NOT any_default.is_deleted
          AND any_default.is_default_selling
      )
    END,
    updated_at = NEW.updated_at,
    version = product_uoms.version + 1,
    is_deleted = false;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_product_base_uom_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF OLD.is_service OR NEW.is_service THEN
    RETURN NEW;
  END IF;
  IF lower(btrim(OLD.unit)) IS NOT DISTINCT FROM lower(btrim(NEW.unit)) THEN
    RETURN NEW;
  END IF;
  -- Renaming a custom unit changes its display code, not its identity or
  -- inventory meaning. The stable custom unit reference makes that safe even
  -- when the product already has stock or transaction history.
  IF EXISTS (
    SELECT 1
    FROM public.product_uoms AS base_uom
    JOIN public.units AS base_unit
      ON base_uom.unit_ref = 'custom:' || base_unit.id::text
    WHERE base_uom.workspace_id = OLD.workspace_id
      AND base_uom.product_id = OLD.id
      AND base_uom.is_base AND base_uom.is_active AND NOT base_uom.is_deleted
      AND base_unit.workspace_id = OLD.workspace_id
      AND lower(btrim(base_unit.code)) = lower(btrim(NEW.unit))
      AND NOT base_unit.is_deleted
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inventory AS inventory
    WHERE inventory.workspace_id = OLD.workspace_id
      AND inventory.product_id = OLD.id
      AND abs(inventory.quantity) > 0.000001
  ) OR EXISTS (
    SELECT 1 FROM public.sale_items AS item
    WHERE item.product_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM public.inventory_transactions AS movement
    WHERE movement.product_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM crm.sales_orders AS order_row
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(order_row.items, '[]'::jsonb)) AS item(value)
    WHERE order_row.workspace_id = OLD.workspace_id
      AND item.value->>'productId' = OLD.id::text
  ) OR EXISTS (
    SELECT 1 FROM crm.purchase_orders AS order_row
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(order_row.items, '[]'::jsonb)) AS item(value)
    WHERE order_row.workspace_id = OLD.workspace_id
      AND item.value->>'productId' = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'product_uom_base_change_has_history' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_product_base_uom_change_on_write ON public.products;
CREATE TRIGGER guard_product_base_uom_change_on_write
BEFORE UPDATE OF unit ON public.products
FOR EACH ROW EXECUTE FUNCTION public.guard_product_base_uom_change();

DROP TRIGGER IF EXISTS sync_product_base_uom_on_write ON public.products;
CREATE TRIGGER sync_product_base_uom_on_write
AFTER INSERT OR UPDATE OF unit, price, cost_price, minimum_selling_price, sku, is_deleted
ON public.products
FOR EACH ROW EXECUTE FUNCTION public.sync_product_base_uom();

-- Preserve all legacy relationship rows. Base values mirror products and the
-- larger-unit selling price is retained exactly. Legacy packaging had no
-- separate cost or floor, so NULL lets the app derive those for future sales
-- without inventing data or altering old transaction records.
INSERT INTO public.product_uoms (
  id, workspace_id, product_id, unit_ref, unit_code, coefficient, is_base,
  is_active, is_default_selling, selling_price, cost_price,
  minimum_selling_price, sku, created_by, created_at, updated_at,
  sync_status, version, is_deleted
)
SELECT gen_random_uuid(), product.workspace_id, product.id,
  COALESCE('custom:' || custom_unit.id::text, 'builtin:' || lower(btrim(product.unit))),
  btrim(product.unit), 1, true, NOT product.is_deleted, NOT product.is_deleted,
  product.price, product.cost_price, product.minimum_selling_price,
  product.sku, product.created_by,
  product.created_at, product.updated_at, 'synced', 1, false
FROM public.products AS product
LEFT JOIN public.units AS custom_unit
  ON custom_unit.workspace_id = product.workspace_id
 AND lower(btrim(custom_unit.code)) = lower(btrim(product.unit))
 AND NOT custom_unit.is_deleted
WHERE NOT product.is_service
ON CONFLICT (product_id, unit_ref) DO NOTHING;

INSERT INTO public.product_uoms (
  id, workspace_id, product_id, unit_ref, unit_code, coefficient, is_base,
  is_active, is_default_selling, selling_price, cost_price,
  minimum_selling_price, created_by, created_at, updated_at,
  sync_status, version, is_deleted
)
SELECT gen_random_uuid(), conversion.workspace_id, product.id,
  relationship.parent_unit_ref, relationship.parent_unit_code,
  conversion.factor, false,
  conversion.factor <> 1
    AND NOT conversion.is_deleted AND NOT relationship.is_deleted AND NOT relationship.is_archived AND NOT product.is_deleted,
  false, conversion.parent_price,
  NULL,
  NULL,
  conversion.created_by, conversion.created_at, conversion.updated_at,
  'synced', 1, false
FROM public.product_unit_conversions AS conversion
JOIN public.products AS product
  ON product.id = conversion.product_id AND product.workspace_id = conversion.workspace_id
 AND NOT product.is_service
JOIN public.unit_relationships AS relationship
  ON relationship.id = conversion.relationship_id AND relationship.workspace_id = conversion.workspace_id
ON CONFLICT (product_id, unit_ref) DO NOTHING;

-- Existing POS rows already carry immutable selling/base-unit and coefficient
-- snapshots. Link them to the matching new UoM when that unit is reconstructible.
ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS selling_uom_id uuid NULL REFERENCES public.product_uoms(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS selling_unit_name_snapshot text NULL,
  ADD COLUMN IF NOT EXISTS uom_cost_price numeric NULL,
  ADD COLUMN IF NOT EXISTS minimum_selling_price_snapshot numeric NULL;

UPDATE public.sale_items AS item
SET selling_uom_id = uom.id,
    selling_unit_name_snapshot = COALESCE(item.selling_unit_name_snapshot, item.selling_unit_code, uom.unit_code)
FROM public.product_uoms AS uom
WHERE uom.product_id = item.product_id
  AND NOT uom.is_deleted
  AND (
    (item.selling_unit_ref IS NOT NULL AND item.selling_unit_ref = uom.unit_ref)
    OR (
      item.selling_unit_ref IS NULL
      AND item.selling_unit_code IS NOT NULL
      AND lower(btrim(item.selling_unit_code)) = lower(btrim(uom.unit_code))
      AND round(COALESCE(item.unit_factor, 1), 6) = round(uom.coefficient, 6)
    )
    OR (
      item.selling_unit_ref IS NULL AND item.selling_unit_code IS NULL
      AND COALESCE(item.unit_factor, 1) = 1 AND uom.is_base
    )
  )
  AND item.selling_uom_id IS NULL;

ALTER TABLE public.order_return_items
  ADD COLUMN IF NOT EXISTS uom_id uuid NULL REFERENCES public.product_uoms(id) ON DELETE SET NULL;

UPDATE public.order_return_items AS return_item
SET uom_id = uom.id
FROM crm.sales_orders AS order_row
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(order_row.items, '[]'::jsonb)) AS order_item(value)
JOIN public.product_uoms AS uom
  ON uom.product_id = NULLIF(order_item.value->>'productId', '')::uuid
 AND uom.workspace_id = order_row.workspace_id
 AND NOT uom.is_deleted
 AND (
   uom.id::text = NULLIF(order_item.value->>'uomId', '')
   OR (NULLIF(order_item.value->>'uomId', '') IS NULL
       AND uom.unit_ref = NULLIF(order_item.value->>'unitRef', ''))
    OR (NULLIF(order_item.value->>'uomId', '') IS NULL
       AND NULLIF(order_item.value->>'unitRef', '') IS NULL
        AND round(COALESCE(
         CASE
           WHEN NULLIF(order_item.value->>'unitFactor', '') IS NULL THEN 1
           WHEN order_item.value->>'unitFactor' ~ '^[+]?[0-9]*[.]?[0-9]+([eE][+-]?[0-9]+)?$'
             THEN (order_item.value->>'unitFactor')::numeric
           ELSE 0
         END,
         1
       ), 6) = round(uom.coefficient, 6)
       AND (
         (NULLIF(order_item.value->>'unit', '') IS NOT NULL
          AND lower(btrim(order_item.value->>'unit')) = lower(btrim(uom.unit_code)))
         OR (NULLIF(order_item.value->>'unit', '') IS NULL AND uom.is_base)
       ))
 )
WHERE order_row.id = return_item.order_id
  AND order_row.workspace_id = return_item.workspace_id
  AND order_item.value->>'id' = return_item.order_item_id
  AND return_item.uom_id IS NULL;

-- Do not rewrite historical sales/purchase order JSON during this migration.
-- The order tables validate every items update against current product availability,
-- so even a label-only backfill can reject legacy orders that reference archived
-- products. Existing unit refs, labels and factors already preserve the historical
-- selection; the application can resolve them from the snapshot when opening an
-- order, while all new orders persist the product_uoms ID directly.

-- Flush deferred base-UoM integrity checks before changing table security; Postgres
-- rejects ALTER TABLE while product_uoms has pending deferred trigger events.
SET CONSTRAINTS assert_product_has_one_base_uom_on_write IMMEDIATE;

ALTER TABLE public.product_uoms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_uoms_select ON public.product_uoms;
CREATE POLICY product_uoms_select ON public.product_uoms
  FOR SELECT TO authenticated USING (workspace_id = public.current_workspace_id());
DROP POLICY IF EXISTS product_uoms_insert ON public.product_uoms;
CREATE POLICY product_uoms_insert ON public.product_uoms
  FOR INSERT TO authenticated WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );
DROP POLICY IF EXISTS product_uoms_update ON public.product_uoms;
CREATE POLICY product_uoms_update ON public.product_uoms
  FOR UPDATE TO authenticated USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  ) WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );
DROP POLICY IF EXISTS product_uoms_delete ON public.product_uoms;
CREATE POLICY product_uoms_delete ON public.product_uoms
  FOR DELETE TO authenticated USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );
REVOKE ALL ON TABLE public.product_uoms FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_uoms TO authenticated, service_role;

DO $migration_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.products AS product
    WHERE NOT product.is_deleted AND NOT product.is_service
      AND NOT EXISTS (
        SELECT 1 FROM public.product_uoms AS uom
        WHERE uom.product_id = product.id AND uom.workspace_id = product.workspace_id
          AND uom.is_base AND uom.coefficient = 1 AND uom.is_active AND NOT uom.is_deleted
      )
  ) THEN
    RAISE EXCEPTION 'Product UoM migration validation failed: an active product has no valid base UoM';
  END IF;
END;
$migration_validation$;

COMMENT ON TABLE public.product_uoms IS
  'Product-owned units of measure. Coefficient converts entered quantity to the product base inventory unit; historical transaction rows keep immutable snapshots.';
COMMENT ON COLUMN public.product_uoms.cost_price IS
  'Optional independent cost per selected UoM. Null means use the product base cost multiplied by coefficient.';
COMMENT ON COLUMN public.product_uoms.minimum_selling_price IS
  'Optional independent staff selling floor per selected UoM. Null means use the product base floor multiplied by coefficient.';

NOTIFY pgrst, 'reload schema';
