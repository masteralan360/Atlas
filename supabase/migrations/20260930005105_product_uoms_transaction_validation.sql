-- Stage 2 of product UoM migration.
-- The previous relational-unit schema remains present for rollback and for the
-- staged historical backfill. All new transactions now validate against and
-- snapshot product_uoms. No migration is destructive to stock or old sales.

SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.validate_staff_minimum_selling_prices(
  p_workspace_id uuid,
  p_items jsonb
)
RETURNS TABLE (
  line_index integer,
  product_id uuid,
  product_name text,
  minimum_selling_price numeric,
  validation_error text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'minimum_selling_price_authentication_required';
  END IF;

  IF p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'minimum_selling_price_workspace_mismatch';
  END IF;

  IF public.current_user_role() <> 'staff' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    (item.ordinality - 1)::integer,
    product.id,
    product.name::text,
    floor.minimum_price,
    CASE
      WHEN lower(COALESCE(item.value->>'currency', product.currency::text))
        IS DISTINCT FROM lower(product.currency::text)
        THEN 'currency_unavailable'
      ELSE NULL
    END
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
  JOIN public.products AS product
    ON product.id = (item.value->>'product_id')::uuid
   AND product.workspace_id = p_workspace_id
  LEFT JOIN LATERAL (
    SELECT uom.minimum_selling_price, uom.coefficient
    FROM public.product_uoms AS uom
    WHERE uom.id::text = NULLIF(item.value->>'selling_uom_id', '')
      AND uom.product_id = product.id
      AND uom.workspace_id = p_workspace_id
      AND uom.is_active AND NOT uom.is_deleted
    LIMIT 1
  ) AS selected_uom ON true
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      selected_uom.minimum_selling_price,
      product.minimum_selling_price * CASE
        WHEN COALESCE(NULLIF(item.value->>'unit_factor', '')::numeric, selected_uom.coefficient, 1) > 0
          THEN COALESCE(NULLIF(item.value->>'unit_factor', '')::numeric, selected_uom.coefficient, 1)
        ELSE 1
      END
    ) AS minimum_price
  ) AS floor
  WHERE floor.minimum_price IS NOT NULL
    AND (
      lower(COALESCE(item.value->>'currency', product.currency::text))
        IS DISTINCT FROM lower(product.currency::text)
      OR NULLIF(item.value->>'effective_selling_price', '')::numeric < floor.minimum_price
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_staff_minimum_selling_prices(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_staff_minimum_selling_prices(uuid, jsonb) TO authenticated;

-- Pass the selected UoM id through the existing security wrappers. The
-- underlying atomic sale implementation continues to own inventory and ledger
-- effects; its existing inventory_quantity conversion remains authoritative.
DO $patch_sale_wrappers$
DECLARE
  function_sql text;
  old_expr text := E'      ''unit_factor'', COALESCE(item.value->>''unit_factor'', ''1''),';
  new_expr text := E'      ''unit_factor'', COALESCE(item.value->>''unit_factor'', ''1''),\n      ''selling_uom_id'', item.value->>''selling_uom_id'',';
BEGIN
  SELECT pg_get_functiondef('public.complete_sale(jsonb)'::regprocedure) INTO function_sql;
  IF position(old_expr IN function_sql) = 0 THEN
    RAISE EXCEPTION 'complete_sale wrapper is missing the expected minimum-price item projection';
  END IF;
  function_sql := replace(function_sql, old_expr, new_expr);
  IF position('selling_uom_id' IN function_sql) = 0 THEN
    RAISE EXCEPTION 'complete_sale UoM projection patch failed';
  END IF;
  EXECUTE function_sql;

  SELECT pg_get_functiondef('public.complete_quick_sales_order(jsonb)'::regprocedure) INTO function_sql;
  old_expr := E'      ''unit_factor'', COALESCE(item.value->>''unitFactor'', ''1''),';
  new_expr := E'      ''unit_factor'', COALESCE(item.value->>''unitFactor'', ''1''),\n      ''selling_uom_id'', item.value->>''uomId'',';
  IF position(old_expr IN function_sql) = 0 THEN
    RAISE EXCEPTION 'complete_quick_sales_order wrapper is missing the expected minimum-price item projection';
  END IF;
  function_sql := replace(function_sql, old_expr, new_expr);
  IF position('selling_uom_id' IN function_sql) = 0 THEN
    RAISE EXCEPTION 'Quick Order UoM projection patch failed';
  END IF;
  EXECUTE function_sql;
END;
$patch_sale_wrappers$;

-- Replace the old sale-item relational conversion validator with a product
-- UoM validator. Existing rows are untouched. Update operations that preserve
-- their original unit snapshot continue to use that historical coefficient.
CREATE OR REPLACE FUNCTION public.validate_sale_item_unit_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_uom public.product_uoms%ROWTYPE;
  v_base public.product_uoms%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_was_snapshotted boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
    AND NEW.selling_uom_id IS NOT DISTINCT FROM OLD.selling_uom_id
    AND NEW.selling_unit_ref IS NOT DISTINCT FROM OLD.selling_unit_ref
    AND NEW.selling_unit_code IS NOT DISTINCT FROM OLD.selling_unit_code
    AND NEW.base_unit_ref IS NOT DISTINCT FROM OLD.base_unit_ref
    AND NEW.base_unit_code IS NOT DISTINCT FROM OLD.base_unit_code
    AND NEW.unit_factor IS NOT DISTINCT FROM OLD.unit_factor
  THEN
    v_was_snapshotted := true;
  END IF;

  IF v_was_snapshotted THEN
    IF NEW.unit_factor IS NULL OR NEW.unit_factor <= 0
      OR NEW.inventory_quantity IS DISTINCT FROM round(NEW.quantity * NEW.unit_factor, 6)
    THEN
      RAISE EXCEPTION 'Sale item historical UoM quantity snapshot is invalid' USING ERRCODE = '23514';
    END IF;
    NEW.selling_unit_name_snapshot := COALESCE(NEW.selling_unit_name_snapshot, OLD.selling_unit_name_snapshot, NEW.selling_unit_code);
    NEW.minimum_selling_price_snapshot := COALESCE(NEW.minimum_selling_price_snapshot, OLD.minimum_selling_price_snapshot);
    RETURN NEW;
  END IF;

  SELECT product.* INTO v_product
  FROM public.products AS product
  WHERE product.id = NEW.product_id AND NOT product.is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale item product is unavailable' USING ERRCODE = '23503';
  END IF;

  IF v_product.is_service THEN
    IF (NEW.unit_factor IS NOT NULL AND NEW.unit_factor IS DISTINCT FROM 1)
      OR (NEW.inventory_quantity IS NOT NULL
          AND NEW.inventory_quantity IS DISTINCT FROM round(NEW.quantity, 6))
    THEN
      RAISE EXCEPTION 'Service sale quantities must remain in service units' USING ERRCODE = '23514';
    END IF;
    NEW.selling_uom_id := NULL;
    NEW.unit_factor := 1;
    NEW.inventory_quantity := round(NEW.quantity, 6);
    NEW.selling_unit_name_snapshot := COALESCE(NULLIF(NEW.selling_unit_name_snapshot, ''), NULLIF(NEW.selling_unit_code, ''), 'service');
    NEW.uom_cost_price := COALESCE(NEW.uom_cost_price, NEW.cost_price);
    NEW.minimum_selling_price_snapshot := COALESCE(NEW.minimum_selling_price_snapshot, v_product.minimum_selling_price);
    RETURN NEW;
  END IF;

  IF NEW.selling_uom_id IS NOT NULL THEN
    SELECT uom.* INTO v_uom
    FROM public.product_uoms AS uom
    WHERE uom.id = NEW.selling_uom_id AND uom.product_id = NEW.product_id;
  ELSIF NEW.selling_unit_ref IS NOT NULL THEN
    SELECT uom.* INTO v_uom
    FROM public.product_uoms AS uom
    WHERE uom.product_id = NEW.product_id AND uom.unit_ref = NEW.selling_unit_ref;
  ELSE
    SELECT uom.* INTO v_uom
    FROM public.product_uoms AS uom
    WHERE uom.product_id = NEW.product_id AND uom.is_base;
  END IF;

  IF NOT FOUND OR NOT v_uom.is_active OR v_uom.is_deleted THEN
    RAISE EXCEPTION 'Sale item selected UoM is unavailable for new sales' USING ERRCODE = '23503';
  END IF;

  SELECT uom.* INTO v_base
  FROM public.product_uoms AS uom
  WHERE uom.product_id = NEW.product_id AND uom.is_base AND uom.is_active AND NOT uom.is_deleted;
  IF NOT FOUND OR v_base.coefficient <> 1 THEN
    RAISE EXCEPTION 'Product must have exactly one active base UoM with coefficient 1' USING ERRCODE = '23514';
  END IF;

  IF (NEW.selling_unit_ref IS NOT NULL AND NEW.selling_unit_ref IS DISTINCT FROM v_uom.unit_ref)
    OR (NEW.selling_unit_code IS NOT NULL AND lower(btrim(NEW.selling_unit_code)) IS DISTINCT FROM lower(btrim(v_uom.unit_code)))
    OR (NEW.base_unit_ref IS NOT NULL AND NEW.base_unit_ref IS DISTINCT FROM v_base.unit_ref)
    OR (NEW.base_unit_code IS NOT NULL AND lower(btrim(NEW.base_unit_code)) IS DISTINCT FROM lower(btrim(v_base.unit_code)))
    OR NEW.unit_factor IS DISTINCT FROM v_uom.coefficient
  THEN
    RAISE EXCEPTION 'Sale item UoM snapshot does not match the selected product UoM' USING ERRCODE = '23514';
  END IF;

  NEW.selling_uom_id := v_uom.id;
  NEW.selling_unit_ref := v_uom.unit_ref;
  NEW.selling_unit_code := v_uom.unit_code;
  NEW.selling_unit_name_snapshot := COALESCE(NULLIF(NEW.selling_unit_name_snapshot, ''), v_uom.unit_code);
  NEW.base_unit_ref := v_base.unit_ref;
  NEW.base_unit_code := v_base.unit_code;
  NEW.unit_factor := v_uom.coefficient;
  NEW.inventory_quantity := round(NEW.quantity * v_uom.coefficient, 6);
  NEW.uom_cost_price := COALESCE(v_uom.cost_price, v_product.cost_price * v_uom.coefficient, NEW.cost_price);
  NEW.minimum_selling_price_snapshot := COALESCE(
    v_uom.minimum_selling_price,
    v_product.minimum_selling_price * v_uom.coefficient
  );
  RETURN NEW;
END;
$function$;

-- The order JSON shape remains the existing one; UoM identifiers and factors
-- are validated against current configuration only when the line is created
-- or its UoM snapshot changes. Fulfillment updates preserve the old snapshot.
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
  v_product public.products%ROWTYPE;
  v_uom_id text;
  v_unit_ref text;
  v_factor numeric;
  v_quantity numeric;
  v_free_quantity numeric;
  v_inventory_quantity numeric;
  v_free_inventory_quantity numeric;
  v_received_quantity numeric;
  v_uom public.product_uoms%ROWTYPE;
  v_base public.product_uoms%ROWTYPE;
  v_old_snapshot jsonb;
  v_new_snapshot jsonb;
  v_result jsonb;
BEGIN
  IF NEW.items IS NULL OR jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' THEN
    RETURN NEW;
  END IF;

  v_result := '[]'::jsonb;
  FOR v_item IN SELECT value FROM jsonb_array_elements(NEW.items)
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Each order item must be an object' USING ERRCODE = '22023';
    END IF;
    v_old_item := NULL;
    IF TG_OP = 'UPDATE' AND OLD.items IS NOT NULL AND v_item ? 'id' THEN
      SELECT candidate.value INTO v_old_item
      FROM jsonb_array_elements(OLD.items) AS candidate(value)
      WHERE candidate.value->>'id' = v_item->>'id'
      LIMIT 1;
    END IF;

    v_old_snapshot := jsonb_build_array(
      v_old_item->'productId', v_old_item->'quantity', v_old_item->'freeBonusQuantity', v_old_item->'freeQuantity',
      v_old_item->'uomId', v_old_item->'unitRef', v_old_item->'unit', v_old_item->'unitFactor',
      v_old_item->'baseUnitRef', v_old_item->'baseUnitCode', v_old_item->'inventoryQuantity',
      v_old_item->'freeBonusInventoryQuantity', v_old_item->'receivedQuantity'
    );
    v_new_snapshot := jsonb_build_array(
      v_item->'productId', v_item->'quantity', v_item->'freeBonusQuantity', v_item->'freeQuantity',
      v_item->'uomId', v_item->'unitRef', v_item->'unit', v_item->'unitFactor',
      v_item->'baseUnitRef', v_item->'baseUnitCode', v_item->'inventoryQuantity',
      v_item->'freeBonusInventoryQuantity', v_item->'receivedQuantity'
    );

    IF TG_OP = 'UPDATE' AND v_old_item IS NOT NULL AND v_new_snapshot IS NOT DISTINCT FROM v_old_snapshot THEN
      v_result := v_result || jsonb_build_array(v_item);
      CONTINUE;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'draft' AND v_old_item IS NOT NULL THEN
      RAISE EXCEPTION 'Order item UoM snapshot cannot change after Draft' USING ERRCODE = '55000';
    END IF;

    BEGIN
      v_product_id := NULLIF(v_item->>'productId', '')::uuid;
      v_factor := COALESCE(NULLIF(v_item->>'unitFactor', '')::numeric, 1);
      v_quantity := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0);
      v_free_quantity := COALESCE(NULLIF(COALESCE(v_item->>'freeBonusQuantity', v_item->>'freeQuantity'), '')::numeric, 0);
      v_inventory_quantity := NULLIF(v_item->>'inventoryQuantity', '')::numeric;
      v_free_inventory_quantity := COALESCE(
        NULLIF(v_item->>'freeBonusInventoryQuantity', '')::numeric,
        round(v_free_quantity * v_factor, 6)
      );
      v_received_quantity := NULLIF(v_item->>'receivedQuantity', '')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Order item UoM quantities are invalid' USING ERRCODE = '22023';
    END;
    IF v_product_id IS NULL OR v_factor <= 0 OR v_factor::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_quantity < 0 OR v_free_quantity < 0
      OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_free_quantity::text IN ('NaN', 'Infinity', '-Infinity')
    THEN
      RAISE EXCEPTION 'Order item UoM snapshot is incomplete or invalid' USING ERRCODE = '23514';
    END IF;

    SELECT product.* INTO v_product
    FROM public.products AS product
    WHERE product.id = v_product_id AND product.workspace_id = NEW.workspace_id AND NOT product.is_deleted;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order item product is unavailable' USING ERRCODE = '23503';
    END IF;
    IF v_product.is_service THEN
      IF v_factor <> 1
        OR (v_inventory_quantity IS NOT NULL AND round(v_inventory_quantity, 6) IS DISTINCT FROM round(v_quantity, 6))
        OR round(v_free_inventory_quantity, 6) IS DISTINCT FROM round(v_free_quantity, 6)
      THEN
        RAISE EXCEPTION 'Service order quantities must remain in service units' USING ERRCODE = '23514';
      END IF;
      v_item := v_item || jsonb_build_object(
        'uomId', NULL,
        'uomNameSnapshot', COALESCE(NULLIF(v_item->>'uomNameSnapshot', ''), 'service'),
        'unitRef', 'builtin:service',
        'unit', COALESCE(NULLIF(v_item->>'unit', ''), 'service'),
        'unitNameSnapshot', COALESCE(NULLIF(v_item->>'unitNameSnapshot', ''), 'service'),
        'baseUnitRef', 'builtin:service',
        'baseUnitCode', 'service',
        'baseUnitNameSnapshot', COALESCE(NULLIF(v_item->>'baseUnitNameSnapshot', ''), 'service'),
        'unitFactor', 1,
        'inventoryQuantity', round(v_quantity, 6),
        'freeBonusInventoryQuantity', round(v_free_quantity, 6)
      );
      v_result := v_result || jsonb_build_array(v_item);
      CONTINUE;
    END IF;

    v_uom_id := NULLIF(v_item->>'uomId', '');
    v_unit_ref := NULLIF(v_item->>'unitRef', '');
    IF v_uom_id IS NOT NULL THEN
      SELECT uom.* INTO v_uom FROM public.product_uoms AS uom
      WHERE uom.id::text = v_uom_id AND uom.product_id = v_product_id AND uom.workspace_id = NEW.workspace_id;
    ELSIF v_unit_ref IS NOT NULL THEN
      SELECT uom.* INTO v_uom FROM public.product_uoms AS uom
      WHERE uom.unit_ref = v_unit_ref AND uom.product_id = v_product_id AND uom.workspace_id = NEW.workspace_id;
    ELSE
      SELECT uom.* INTO v_uom FROM public.product_uoms AS uom
      WHERE uom.product_id = v_product_id AND uom.workspace_id = NEW.workspace_id AND uom.is_base;
    END IF;
    IF NOT FOUND OR NOT v_uom.is_active OR v_uom.is_deleted THEN
      RAISE EXCEPTION 'Order item UoM is unavailable for new orders' USING ERRCODE = '23503';
    END IF;
    SELECT uom.* INTO v_base FROM public.product_uoms AS uom
    WHERE uom.product_id = v_product_id AND uom.workspace_id = NEW.workspace_id
      AND uom.is_base AND uom.is_active AND NOT uom.is_deleted;
    IF NOT FOUND OR v_base.coefficient <> 1 THEN
      RAISE EXCEPTION 'Product must have one active base UoM' USING ERRCODE = '23514';
    END IF;

    IF round(v_factor, 6) IS DISTINCT FROM round(v_uom.coefficient, 6)
      OR (v_unit_ref IS NOT NULL AND v_unit_ref IS DISTINCT FROM v_uom.unit_ref)
      OR (NULLIF(v_item->>'unit', '') IS NOT NULL AND lower(btrim(v_item->>'unit')) IS DISTINCT FROM lower(btrim(v_uom.unit_code)))
      OR (NULLIF(v_item->>'baseUnitRef', '') IS NOT NULL AND v_item->>'baseUnitRef' IS DISTINCT FROM v_base.unit_ref)
      OR (NULLIF(v_item->>'baseUnitCode', '') IS NOT NULL AND lower(btrim(v_item->>'baseUnitCode')) IS DISTINCT FROM lower(btrim(v_base.unit_code)))
    THEN
      RAISE EXCEPTION 'Order item UoM conversion does not match product configuration' USING ERRCODE = '23514';
    END IF;

    IF v_inventory_quantity IS NOT NULL AND round(v_inventory_quantity, 6) IS DISTINCT FROM round(v_quantity * v_factor, 6) THEN
      RAISE EXCEPTION 'Order item inventory quantity must equal quantity times UoM coefficient' USING ERRCODE = '23514';
    END IF;
    IF round(v_free_inventory_quantity, 6) IS DISTINCT FROM round(v_free_quantity * v_factor, 6) THEN
      RAISE EXCEPTION 'Order item free inventory quantity must equal free quantity times UoM coefficient' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'purchase_orders' AND (
      v_received_quantity IS NULL
      OR round(v_received_quantity, 6) IS DISTINCT FROM round(v_quantity * v_factor + v_free_quantity * v_factor, 6)
    ) THEN
      RAISE EXCEPTION 'Purchase received quantity must be stored in the base UoM' USING ERRCODE = '23514';
    END IF;

    v_item := v_item || jsonb_build_object(
      'uomId', v_uom.id,
      'uomNameSnapshot', COALESCE(NULLIF(v_item->>'uomNameSnapshot', ''), NULLIF(v_item->>'unitNameSnapshot', ''), v_uom.unit_code),
      'unitRef', v_uom.unit_ref,
      'unit', v_uom.unit_code,
      'unitNameSnapshot', COALESCE(NULLIF(v_item->>'unitNameSnapshot', ''), v_uom.unit_code),
      'baseUnitRef', v_base.unit_ref,
      'baseUnitCode', v_base.unit_code,
      'baseUnitNameSnapshot', COALESCE(NULLIF(v_item->>'baseUnitNameSnapshot', ''), v_base.unit_code),
      'unitFactor', v_uom.coefficient,
      'inventoryQuantity', COALESCE(v_inventory_quantity, round(v_quantity * v_uom.coefficient, 6)),
      'freeBonusInventoryQuantity', round(v_free_quantity * v_uom.coefficient, 6)
    );
    v_result := v_result || jsonb_build_array(v_item);
  END LOOP;
  NEW.items := v_result;
  RETURN NEW;
END;
$function$;

-- Quick Order is now compatible with the same base-unit stock model. Keep its
-- existing atomic payment, batch, and inventory behavior and remove the old
-- explicit rejection of relational-unit metadata.
DO $patch_atomic_quick_order$
DECLARE
  function_sql text;
  marker_start text := '  -- Related selling units';
  marker_end text := E'  IF COALESCE(v_order_payload->>''payment_method'', '''')';
  start_pos integer;
  end_pos integer;
  expression_start integer;
  expression_end integer;
BEGIN
  SELECT pg_get_functiondef('private.complete_quick_sales_order_once(jsonb)'::regprocedure) INTO function_sql;
  start_pos := strpos(function_sql, marker_start);
  end_pos := strpos(function_sql, marker_end);
  IF start_pos = 0 OR end_pos <= start_pos THEN
    RAISE EXCEPTION 'Quick Order relational-unit guard markers were not found';
  END IF;
  function_sql := left(function_sql, start_pos - 1)
    || '  -- UoM snapshots are validated by private.validate_order_unit_items().' || E'\n\n'
    || substring(function_sql FROM end_pos);

  IF position('v_unit_factor numeric;' IN function_sql) = 0 THEN
    IF position('v_required_quantity numeric;' IN function_sql) = 0 THEN
      RAISE EXCEPTION 'Quick Order required-quantity declaration was not found';
    END IF;
    function_sql := replace(function_sql, 'v_required_quantity numeric;', E'v_required_quantity numeric;\n  v_unit_factor numeric;');
  END IF;

  expression_start := strpos(function_sql, '    v_required_quantity := round(');
  expression_end := expression_start + strpos(
    substring(function_sql FROM expression_start),
    '    IF v_product_id IS NULL OR v_required_quantity <= 0 THEN'
  ) - 1;
  IF expression_start = 0 OR expression_end <= expression_start THEN
    RAISE EXCEPTION 'Quick Order quantity conversion block was not found';
  END IF;
  function_sql := left(function_sql, expression_start - 1)
    || E'    v_unit_factor := COALESCE(NULLIF(v_item->>''unitFactor'', '''')::numeric, 1);\n'
    || E'    IF v_unit_factor <= 0 OR v_unit_factor::text IN (''NaN'', ''Infinity'', ''-Infinity'') THEN\n'
    || E'      RAISE EXCEPTION ''Invalid Quick Order UoM coefficient'' USING ERRCODE = ''23514'';\n'
    || E'    END IF;\n'
    || E'    v_required_quantity := round((\n'
    || E'      COALESCE(NULLIF(v_item->>''quantity'', '''')::numeric, 0)\n'
    || E'      + COALESCE(NULLIF(v_item->>''freeBonusQuantity'', '''')::numeric, NULLIF(v_item->>''freeQuantity'', '''')::numeric, 0)\n'
    || E'    ) * v_unit_factor, 6);\n\n'
    || substring(function_sql FROM expression_end);

  function_sql := replace(
    function_sql,
    E'        COALESCE(NULLIF(pending_item->>''quantity'', '''')::numeric, 0)\n        + COALESCE(\n            NULLIF(pending_item->>''freeBonusQuantity'', '''')::numeric,\n            NULLIF(pending_item->>''freeQuantity'', '''')::numeric,\n            0\n          )',
    E'        (COALESCE(NULLIF(pending_item->>''quantity'', '''')::numeric, 0)\n        + COALESCE(NULLIF(pending_item->>''freeBonusQuantity'', '''')::numeric, NULLIF(pending_item->>''freeQuantity'', '''')::numeric, 0))\n        * COALESCE(NULLIF(pending_item->>''unitFactor'', '''')::numeric, 1)'
  );
  function_sql := replace(
    function_sql,
    E'v_fallback_original_cost := COALESCE(NULLIF(v_item->>''costPrice'', '''')::numeric, 0);',
    E'v_fallback_original_cost := COALESCE(NULLIF(v_item->>''costPrice'', '''')::numeric / NULLIF(v_unit_factor, 0), v_product.cost_price, 0);'
  );
  function_sql := replace(
    function_sql,
    E'NULLIF(v_item->>''convertedCostPrice'', '''')::numeric,\n        v_fallback_original_cost',
    E'NULLIF(v_item->>''convertedCostPrice'', '''')::numeric / NULLIF(v_unit_factor, 0),\n        v_fallback_original_cost'
  );
  function_sql := replace(function_sql, E'''costPrice'', v_original_cost_total / v_required_quantity,', E'''costPrice'', v_original_cost_total / (v_required_quantity / v_unit_factor),');
  function_sql := replace(function_sql, E'''convertedCostPrice'', v_converted_cost_total / v_required_quantity,', E'''convertedCostPrice'', v_converted_cost_total / (v_required_quantity / v_unit_factor),');

  IF position('v_required_quantity := round((' IN function_sql) = 0
    OR position('v_unit_factor' IN function_sql) = 0
    OR position('pending_item->>''unitFactor''' IN function_sql) = 0
    OR position('v_original_cost_total / (v_required_quantity / v_unit_factor)' IN function_sql) = 0
    OR position('quick_order_related_units_unsupported' IN function_sql) > 0
  THEN
    RAISE EXCEPTION 'Quick Order UoM patch failed';
  END IF;
  EXECUTE function_sql;
END;
$patch_atomic_quick_order$;

DO $migration_validation$
BEGIN
  IF EXISTS (
    SELECT product.id
    FROM public.products AS product
    LEFT JOIN public.product_uoms AS uom ON uom.product_id = product.id AND uom.workspace_id = product.workspace_id
    WHERE NOT product.is_deleted
      AND NOT product.is_service
    GROUP BY product.id
    HAVING count(*) FILTER (WHERE uom.is_base AND uom.is_active AND NOT uom.is_deleted AND uom.coefficient = 1) <> 1
  ) THEN
    RAISE EXCEPTION 'Product UoM validation failed: every active product must have one coefficient-one base unit';
  END IF;
END;
$migration_validation$;

NOTIFY pgrst, 'reload schema';
