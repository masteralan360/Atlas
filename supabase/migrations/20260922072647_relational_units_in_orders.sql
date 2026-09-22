-- Persist commercial unit snapshots on order JSON lines while inventory remains
-- canonical in the child/base unit. Existing order JSON remains valid and is
-- interpreted as factor-one data by the client.

SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE public.order_return_items
  ADD COLUMN IF NOT EXISTS selected_unit_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS paid_selected_unit_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS free_selected_unit_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS inventory_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS paid_inventory_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS free_inventory_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS unit_ref text NULL,
  ADD COLUMN IF NOT EXISTS unit text NULL,
  ADD COLUMN IF NOT EXISTS unit_name_snapshot text NULL,
  ADD COLUMN IF NOT EXISTS base_unit_ref text NULL,
  ADD COLUMN IF NOT EXISTS base_unit_code text NULL,
  ADD COLUMN IF NOT EXISTS base_unit_name_snapshot text NULL,
  ADD COLUMN IF NOT EXISTS unit_factor numeric NULL,
  ADD COLUMN IF NOT EXISTS quantity_kind text NULL;

ALTER TABLE public.order_return_items
  DROP CONSTRAINT IF EXISTS order_return_items_selected_unit_quantity_check,
  ADD CONSTRAINT order_return_items_selected_unit_quantity_check CHECK (
    selected_unit_quantity IS NULL
    OR (
      selected_unit_quantity > 0
      AND selected_unit_quantity::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND selected_unit_quantity = round(selected_unit_quantity, 6)
    )
  ),
  DROP CONSTRAINT IF EXISTS order_return_items_selected_quantity_parts_check,
  ADD CONSTRAINT order_return_items_selected_quantity_parts_check CHECK (
    paid_selected_unit_quantity IS NULL OR free_selected_unit_quantity IS NULL OR selected_unit_quantity IS NULL
    OR (
      paid_selected_unit_quantity >= 0
      AND free_selected_unit_quantity >= 0
      AND paid_selected_unit_quantity = round(paid_selected_unit_quantity, 6)
      AND free_selected_unit_quantity = round(free_selected_unit_quantity, 6)
      AND selected_unit_quantity = paid_selected_unit_quantity + free_selected_unit_quantity
    )
  ),
  DROP CONSTRAINT IF EXISTS order_return_items_inventory_quantity_check,
  ADD CONSTRAINT order_return_items_inventory_quantity_check CHECK (
    inventory_quantity IS NULL
    OR (
      inventory_quantity > 0
      AND inventory_quantity::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND inventory_quantity = round(inventory_quantity, 6)
      AND quantity = inventory_quantity
    )
  ),
  DROP CONSTRAINT IF EXISTS order_return_items_inventory_quantity_parts_check,
  ADD CONSTRAINT order_return_items_inventory_quantity_parts_check CHECK (
    paid_inventory_quantity IS NULL OR free_inventory_quantity IS NULL OR inventory_quantity IS NULL
    OR (
      paid_inventory_quantity >= 0
      AND free_inventory_quantity >= 0
      AND paid_inventory_quantity = round(paid_inventory_quantity, 6)
      AND free_inventory_quantity = round(free_inventory_quantity, 6)
      AND inventory_quantity = paid_inventory_quantity + free_inventory_quantity
    )
  ),
  DROP CONSTRAINT IF EXISTS order_return_items_unit_factor_check,
  ADD CONSTRAINT order_return_items_unit_factor_check CHECK (
    unit_factor IS NULL
    OR (unit_factor > 0 AND unit_factor::text NOT IN ('NaN', 'Infinity', '-Infinity'))
  ),
  DROP CONSTRAINT IF EXISTS order_return_items_quantity_kind_check,
  ADD CONSTRAINT order_return_items_quantity_kind_check CHECK (
    quantity_kind IS NULL OR quantity_kind IN ('paid', 'free')
  );

CREATE OR REPLACE FUNCTION private.validate_order_unit_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_item jsonb;
  v_old_item jsonb;
  v_product_id uuid;
  v_conversion public.product_unit_conversions%ROWTYPE;
  v_relationship public.unit_relationships%ROWTYPE;
  v_relationship_id uuid;
  v_unit_ref text;
  v_base_unit_ref text;
  v_factor numeric;
  v_quantity numeric;
  v_free_quantity numeric;
  v_inventory_quantity numeric;
  v_free_inventory_quantity numeric;
  v_received_quantity numeric;
  v_expected_factor numeric;
  v_expected_unit_code text;
BEGIN
  IF NEW.items IS NULL OR pg_catalog.jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' THEN
    RETURN NEW;
  END IF;

  FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(NEW.items)
  LOOP
    IF pg_catalog.jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Each order item must be an object' USING ERRCODE = '22023';
    END IF;

    v_old_item := NULL;
    IF TG_OP = 'UPDATE' AND OLD.items IS NOT NULL AND v_item ? 'id' THEN
      SELECT candidate.value INTO v_old_item
      FROM pg_catalog.jsonb_array_elements(OLD.items) AS candidate(value)
      WHERE candidate.value->>'id' = v_item->>'id'
      LIMIT 1;
    END IF;

    -- Lifecycle updates may add fulfillment/receipt fields. Unit snapshots are
    -- immutable after Draft, but unrelated JSON changes remain allowed.
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'draft' AND v_old_item IS NOT NULL
      AND pg_catalog.jsonb_build_array(
        v_item->'productId', v_item->'quantity', v_item->'freeBonusQuantity', v_item->'freeQuantity',
        v_item->'unitRelationshipId', v_item->'unitRef', v_item->'unit',
        v_item->'unitNameSnapshot', v_item->'baseUnitRef', v_item->'baseUnitCode',
        v_item->'baseUnitNameSnapshot', v_item->'unitFactor',
        v_item->'inventoryQuantity', v_item->'freeBonusInventoryQuantity', v_item->'receivedQuantity'
      ) IS DISTINCT FROM pg_catalog.jsonb_build_array(
        v_old_item->'productId', v_old_item->'quantity', v_old_item->'freeBonusQuantity', v_old_item->'freeQuantity',
        v_old_item->'unitRelationshipId', v_old_item->'unitRef', v_old_item->'unit',
        v_old_item->'unitNameSnapshot', v_old_item->'baseUnitRef', v_old_item->'baseUnitCode',
        v_old_item->'baseUnitNameSnapshot', v_old_item->'unitFactor',
        v_old_item->'inventoryQuantity', v_old_item->'freeBonusInventoryQuantity', v_old_item->'receivedQuantity'
      )
    THEN
      RAISE EXCEPTION 'Order unit selection cannot change after Draft' USING ERRCODE = '55000';
    END IF;

    -- Unchanged historical lines deliberately keep factor-one compatibility.
    IF TG_OP = 'UPDATE' AND v_old_item IS NOT NULL
      AND pg_catalog.jsonb_build_array(
        v_item->'productId', v_item->'quantity', v_item->'freeBonusQuantity', v_item->'freeQuantity',
        v_item->'unitRelationshipId', v_item->'unitRef', v_item->'unit',
        v_item->'unitNameSnapshot', v_item->'baseUnitRef', v_item->'baseUnitCode',
        v_item->'baseUnitNameSnapshot', v_item->'unitFactor',
        v_item->'inventoryQuantity', v_item->'freeBonusInventoryQuantity', v_item->'receivedQuantity'
      ) IS NOT DISTINCT FROM pg_catalog.jsonb_build_array(
        v_old_item->'productId', v_old_item->'quantity', v_old_item->'freeBonusQuantity', v_old_item->'freeQuantity',
        v_old_item->'unitRelationshipId', v_old_item->'unitRef', v_old_item->'unit',
        v_old_item->'unitNameSnapshot', v_old_item->'baseUnitRef', v_old_item->'baseUnitCode',
        v_old_item->'baseUnitNameSnapshot', v_old_item->'unitFactor',
        v_old_item->'inventoryQuantity', v_old_item->'freeBonusInventoryQuantity', v_old_item->'receivedQuantity'
      )
    THEN
      CONTINUE;
    END IF;

    BEGIN
      v_product_id := NULLIF(v_item->>'productId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Order item product is invalid' USING ERRCODE = '22023';
    END;
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'Order item product is required' USING ERRCODE = '22023';
    END IF;

    SELECT conversion.* INTO v_conversion
    FROM public.product_unit_conversions AS conversion
    WHERE conversion.workspace_id = NEW.workspace_id
      AND conversion.product_id = v_product_id
      AND COALESCE(conversion.is_deleted, false) = false
    LIMIT 1;

    IF NOT FOUND THEN
      IF NULLIF(v_item->>'unitRelationshipId', '') IS NOT NULL THEN
        RAISE EXCEPTION 'Order item references a unit relationship not assigned to its product' USING ERRCODE = '23514';
      END IF;
      CONTINUE;
    END IF;

    SELECT relationship.* INTO v_relationship
    FROM public.unit_relationships AS relationship
    WHERE relationship.id = v_conversion.relationship_id
      AND relationship.workspace_id = NEW.workspace_id
      AND COALESCE(relationship.is_deleted, false) = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product unit relationship is unavailable' USING ERRCODE = '23514';
    END IF;

    BEGIN
      v_relationship_id := NULLIF(v_item->>'unitRelationshipId', '')::uuid;
      v_factor := NULLIF(v_item->>'unitFactor', '')::numeric;
      v_quantity := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0);
      v_free_quantity := COALESCE(NULLIF(COALESCE(v_item->>'freeBonusQuantity', v_item->>'freeQuantity'), '')::numeric, 0);
      v_inventory_quantity := NULLIF(v_item->>'inventoryQuantity', '')::numeric;
      v_free_inventory_quantity := COALESCE(NULLIF(v_item->>'freeBonusInventoryQuantity', '')::numeric, 0);
      v_received_quantity := NULLIF(v_item->>'receivedQuantity', '')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Order unit quantities are invalid' USING ERRCODE = '22023';
    END;

    v_unit_ref := NULLIF(v_item->>'unitRef', '');
    v_base_unit_ref := NULLIF(v_item->>'baseUnitRef', '');
    IF v_relationship_id IS DISTINCT FROM v_relationship.id
      OR v_base_unit_ref IS DISTINCT FROM v_relationship.child_unit_ref
      OR v_factor IS NULL OR v_factor <= 0
      OR v_factor::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_free_quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_inventory_quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_free_inventory_quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_quantity < 0 OR v_free_quantity < 0
      OR v_inventory_quantity IS NULL
      OR v_quantity IS DISTINCT FROM pg_catalog.round(v_quantity, 6)
      OR v_free_quantity IS DISTINCT FROM pg_catalog.round(v_free_quantity, 6)
      OR v_inventory_quantity IS DISTINCT FROM pg_catalog.round(v_inventory_quantity, 6)
      OR v_free_inventory_quantity IS DISTINCT FROM pg_catalog.round(v_free_inventory_quantity, 6)
    THEN
      RAISE EXCEPTION 'Order item unit snapshot is incomplete or invalid' USING ERRCODE = '23514';
    END IF;

    IF v_unit_ref = v_relationship.parent_unit_ref THEN
      v_expected_factor := v_conversion.factor;
      v_expected_unit_code := v_relationship.parent_unit_code;
    ELSIF v_unit_ref = v_relationship.child_unit_ref THEN
      v_expected_factor := 1;
      v_expected_unit_code := v_relationship.child_unit_code;
    ELSE
      RAISE EXCEPTION 'Order item selected unit does not belong to its relationship' USING ERRCODE = '23514';
    END IF;

    IF pg_catalog.round(v_factor, 6) IS DISTINCT FROM pg_catalog.round(v_expected_factor, 6)
      OR NULLIF(v_item->>'unit', '') IS DISTINCT FROM v_expected_unit_code
      OR NULLIF(v_item->>'unitNameSnapshot', '') IS DISTINCT FROM v_expected_unit_code
      OR NULLIF(v_item->>'baseUnitCode', '') IS DISTINCT FROM v_relationship.child_unit_code
      OR NULLIF(v_item->>'baseUnitNameSnapshot', '') IS DISTINCT FROM v_relationship.child_unit_code
      OR pg_catalog.round(v_inventory_quantity, 6) IS DISTINCT FROM pg_catalog.round(v_quantity * v_factor, 6)
      OR pg_catalog.round(v_free_inventory_quantity, 6) IS DISTINCT FROM pg_catalog.round(v_free_quantity * v_factor, 6)
      OR (
        TG_TABLE_NAME = 'purchase_orders'
        AND (
          v_received_quantity IS NULL
          OR v_received_quantity::text IN ('NaN', 'Infinity', '-Infinity')
          OR v_received_quantity IS DISTINCT FROM pg_catalog.round(v_received_quantity, 6)
          OR v_received_quantity IS DISTINCT FROM pg_catalog.round(v_inventory_quantity + v_free_inventory_quantity, 6)
        )
      )
    THEN
      RAISE EXCEPTION 'Order item unit conversion does not match the product configuration' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_sales_order_unit_items ON crm.sales_orders;
CREATE TRIGGER validate_sales_order_unit_items
BEFORE INSERT OR UPDATE OF items, status ON crm.sales_orders
FOR EACH ROW EXECUTE FUNCTION private.validate_order_unit_items();

DROP TRIGGER IF EXISTS validate_purchase_order_unit_items ON crm.purchase_orders;
CREATE TRIGGER validate_purchase_order_unit_items
BEFORE INSERT OR UPDATE OF items, status ON crm.purchase_orders
FOR EACH ROW EXECUTE FUNCTION private.validate_order_unit_items();

COMMENT ON FUNCTION private.validate_order_unit_items() IS
  'Validates relational order-unit snapshots while preserving unchanged legacy factor-one order lines.';
