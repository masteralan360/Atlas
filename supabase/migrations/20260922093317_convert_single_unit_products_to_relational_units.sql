-- Convert a saved single-unit product into a related-unit product without ever
-- exposing an intermediate product, inventory, batch, conversion, or Price
-- Book state. The private implementation is required because a staff member
-- may be allowed to edit the product while being excluded from one of its old
-- storage allocations; the function explicitly rejects that case before it
-- performs any privileged writes.

SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE OR REPLACE FUNCTION private.convert_single_unit_product_to_relationship(
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_workspace_id uuid := public.current_workspace_id();
  v_role text := public.current_user_role();
  v_product_id uuid;
  v_relationship_id uuid;
  v_storage_id uuid;
  v_factor numeric;
  v_parent_price numeric;
  v_initial_stock numeric;
  v_product_payload jsonb;
  v_price_rows jsonb;
  v_price_row jsonb;
  v_product public.products%ROWTYPE;
  v_relationship public.unit_relationships%ROWTYPE;
  v_child_dynamic boolean := false;
  v_now timestamptz := timezone('utc', now());
  v_inventory jsonb;
  v_batches jsonb;
  v_price_book_items jsonb;
  v_unit_prices jsonb;
  v_conversion jsonb;
BEGIN
  IF v_actor_id IS NULL OR v_workspace_id IS NULL OR v_role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'single_unit_conversion_storage_access' USING ERRCODE = '42501';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '22023';
  END IF;

  v_product_id := NULLIF(p_payload->>'product_id', '')::uuid;
  v_relationship_id := NULLIF(p_payload->>'relationship_id', '')::uuid;
  v_storage_id := NULLIF(p_payload->>'storage_id', '')::uuid;
  v_factor := NULLIF(p_payload->>'factor', '')::numeric;
  v_parent_price := NULLIF(p_payload->>'parent_price', '')::numeric;
  v_initial_stock := NULLIF(p_payload->>'initial_stock', '')::numeric;
  v_product_payload := p_payload->'product';
  v_price_rows := COALESCE(p_payload->'price_book_items', '[]'::jsonb);

  IF v_product_id IS NULL
    OR v_relationship_id IS NULL
    OR v_storage_id IS NULL
    OR v_factor IS NULL
    OR v_factor <= 0
    OR v_factor::text IN ('NaN', 'Infinity', '-Infinity')
    OR v_parent_price IS NULL
    OR v_parent_price < 0
    OR v_parent_price::text IN ('NaN', 'Infinity', '-Infinity')
    OR v_initial_stock IS NULL
    OR v_initial_stock < 0
    OR v_initial_stock::text IN ('NaN', 'Infinity', '-Infinity')
    OR jsonb_typeof(v_product_payload) <> 'object'
    OR jsonb_typeof(v_price_rows) <> 'array'
  THEN
    RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_product
  FROM public.products AS product
  WHERE product.id = v_product_id
    AND product.workspace_id = v_workspace_id
    AND COALESCE(product.is_deleted, false) = false
    AND NOT COALESCE(product.is_service, false)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_unit_conversions AS conversion
    WHERE conversion.workspace_id = v_workspace_id
      AND conversion.product_id = v_product_id
      AND COALESCE(conversion.is_deleted, false) = false
  ) THEN
    RAISE EXCEPTION 'single_unit_conversion_already_relational' USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_relationship
  FROM public.unit_relationships AS relationship
  WHERE relationship.id = v_relationship_id
    AND relationship.workspace_id = v_workspace_id
    AND COALESCE(relationship.is_deleted, false) = false
    AND COALESCE(relationship.is_archived, false) = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '23503';
  END IF;

  IF v_relationship.child_unit_ref LIKE 'custom:%' THEN
    SELECT unit.is_dynamic
    INTO v_child_dynamic
    FROM public.units AS unit
    WHERE unit.id = substring(v_relationship.child_unit_ref FROM 8)::uuid
      AND unit.workspace_id = v_workspace_id
      AND COALESCE(unit.is_deleted, false) = false;
  ELSE
    v_child_dynamic := lower(btrim(v_relationship.child_unit_code)) IN ('m²', 'kg', 'meter');
  END IF;

  IF (NOT COALESCE(v_child_dynamic, false))
    AND (trunc(v_factor) <> v_factor OR trunc(v_initial_stock) <> v_initial_stock) THEN
    RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '23514';
  END IF;

  IF public.current_user_hides_costs(v_workspace_id) THEN
    RAISE EXCEPTION 'single_unit_conversion_hidden_costs' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.storages AS storage
    WHERE storage.id = v_storage_id
      AND storage.workspace_id = v_workspace_id
      AND COALESCE(storage.is_deleted, false) = false
  ) OR NOT public.current_user_can_access_storage(v_workspace_id, v_storage_id) THEN
    RAISE EXCEPTION 'single_unit_conversion_storage_access' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inventory AS inventory_row
    WHERE inventory_row.workspace_id = v_workspace_id
      AND inventory_row.product_id = v_product_id
      AND NOT public.current_user_can_access_storage(v_workspace_id, inventory_row.storage_id)
  ) OR EXISTS (
    SELECT 1
    FROM public.stock_batches AS batch_row
    WHERE batch_row.workspace_id = v_workspace_id
      AND batch_row.product_id = v_product_id
      AND NOT public.current_user_can_access_storage(v_workspace_id, batch_row.storage_id)
  ) THEN
    RAISE EXCEPTION 'single_unit_conversion_storage_access' USING ERRCODE = '42501';
  END IF;

  IF btrim(COALESCE(v_product_payload->>'sku', '')) = ''
    OR btrim(COALESCE(v_product_payload->>'name', '')) = ''
    OR NULLIF(v_product_payload->>'price', '')::numeric < 0
    OR NULLIF(v_product_payload->>'cost_price', '')::numeric < 0
    OR NULLIF(v_product_payload->>'min_stock_level', '')::numeric < 0
    OR lower(COALESCE(v_product_payload->>'currency', '')) NOT IN ('usd', 'eur', 'iqd', 'try')
  THEN
    RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT COUNT(*) <> COUNT(DISTINCT NULLIF(price_row->>'price_book_id', '')::uuid)
    FROM jsonb_array_elements(v_price_rows) AS price_row
  ) THEN
    RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '22023';
  END IF;

  FOR v_price_row IN SELECT value FROM jsonb_array_elements(v_price_rows)
  LOOP
    IF NULLIF(v_price_row->>'price_book_id', '')::uuid IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.price_books AS price_book
        WHERE price_book.id = NULLIF(v_price_row->>'price_book_id', '')::uuid
          AND price_book.workspace_id = v_workspace_id
          AND COALESCE(price_book.is_deleted, false) = false
      )
      OR NULLIF(v_price_row->>'price', '')::numeric < 0
      OR NULLIF(v_price_row->>'cost_price', '')::numeric < 0
      OR NULLIF(v_price_row->>'parent_price', '')::numeric < 0
      OR lower(COALESCE(v_price_row->>'currency', '')) NOT IN ('usd', 'eur', 'iqd', 'try')
    THEN
      RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  UPDATE public.products
  SET
    sku = btrim(v_product_payload->>'sku'),
    name = btrim(v_product_payload->>'name'),
    description = COALESCE(v_product_payload->>'description', ''),
    category_id = NULLIF(v_product_payload->>'category_id', '')::uuid,
    category = NULLIF(v_product_payload->>'category', ''),
    price = (v_product_payload->>'price')::numeric,
    cost_price = (v_product_payload->>'cost_price')::numeric,
    min_stock_level = (v_product_payload->>'min_stock_level')::numeric,
    unit = v_relationship.child_unit_code,
    currency = lower(v_product_payload->>'currency'),
    image_url = COALESCE(v_product_payload->>'image_url', ''),
    can_be_returned = COALESCE((v_product_payload->>'can_be_returned')::boolean, true),
    return_rules = COALESCE(v_product_payload->>'return_rules', ''),
    updated_at = v_now,
    version = COALESCE(version, 0) + 1
  WHERE id = v_product_id;

  INSERT INTO public.product_unit_conversions (
    workspace_id, product_id, relationship_id, factor, parent_price,
    created_by, created_at, updated_at, sync_status, version, is_deleted
  )
  VALUES (
    v_workspace_id, v_product_id, v_relationship_id, v_factor, v_parent_price,
    v_actor_id, v_now, v_now, 'synced', 1, false
  )
  ON CONFLICT (product_id) DO UPDATE
  SET
    relationship_id = EXCLUDED.relationship_id,
    factor = EXCLUDED.factor,
    parent_price = EXCLUDED.parent_price,
    updated_at = EXCLUDED.updated_at,
    sync_status = 'synced',
    version = COALESCE(public.product_unit_conversions.version, 0) + 1,
    is_deleted = false;

  UPDATE public.stock_batches
  SET
    quantity = 0,
    updated_at = v_now,
    version = COALESCE(version, 0) + 1
  WHERE workspace_id = v_workspace_id
    AND product_id = v_product_id
    AND quantity IS DISTINCT FROM 0;

  UPDATE public.inventory
  SET
    quantity = 0,
    is_deleted = true,
    updated_at = v_now,
    version = COALESCE(version, 0) + 1
  WHERE workspace_id = v_workspace_id
    AND product_id = v_product_id
    AND (quantity IS DISTINCT FROM 0 OR COALESCE(is_deleted, false) = false);

  IF v_initial_stock > 0 THEN
    INSERT INTO public.inventory (
      workspace_id, product_id, storage_id, quantity,
      created_at, updated_at, version, is_deleted
    )
    VALUES (
      v_workspace_id, v_product_id, v_storage_id, v_initial_stock,
      v_now, v_now, 1, false
    )
    ON CONFLICT (workspace_id, product_id, storage_id) DO UPDATE
    SET
      quantity = EXCLUDED.quantity,
      is_deleted = false,
      updated_at = EXCLUDED.updated_at,
      version = COALESCE(public.inventory.version, 0) + 1;
  END IF;

  PERFORM public.refresh_product_inventory_snapshot(v_product_id);

  UPDATE public.price_book_items AS existing
  SET
    is_deleted = true,
    updated_at = v_now,
    sync_status = 'synced',
    version = COALESCE(existing.version, 0) + 1
  WHERE existing.workspace_id = v_workspace_id
    AND existing.product_id = v_product_id
    AND COALESCE(existing.is_deleted, false) = false
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_price_rows) AS selected
      WHERE NULLIF(selected->>'price_book_id', '')::uuid = existing.price_book_id
    );

  FOR v_price_row IN SELECT value FROM jsonb_array_elements(v_price_rows)
  LOOP
    INSERT INTO public.price_book_items (
      workspace_id, price_book_id, product_id, cost_price, price, currency,
      created_by, created_at, updated_at, sync_status, version, is_deleted
    )
    VALUES (
      v_workspace_id,
      (v_price_row->>'price_book_id')::uuid,
      v_product_id,
      (v_price_row->>'cost_price')::numeric,
      (v_price_row->>'price')::numeric,
      lower(v_price_row->>'currency'),
      v_actor_id,
      v_now,
      v_now,
      'synced',
      1,
      false
    )
    ON CONFLICT (price_book_id, product_id) DO UPDATE
    SET
      cost_price = EXCLUDED.cost_price,
      price = EXCLUDED.price,
      currency = EXCLUDED.currency,
      updated_at = EXCLUDED.updated_at,
      sync_status = 'synced',
      version = COALESCE(public.price_book_items.version, 0) + 1,
      is_deleted = false;
  END LOOP;

  DELETE FROM public.price_book_unit_prices
  WHERE workspace_id = v_workspace_id
    AND product_id = v_product_id;

  FOR v_price_row IN SELECT value FROM jsonb_array_elements(v_price_rows)
  LOOP
    INSERT INTO public.price_book_unit_prices (
      workspace_id, price_book_id, product_id, unit_ref, price, currency,
      created_by, created_at, updated_at, sync_status, version, is_deleted
    )
    VALUES (
      v_workspace_id,
      (v_price_row->>'price_book_id')::uuid,
      v_product_id,
      v_relationship.parent_unit_ref,
      (v_price_row->>'parent_price')::numeric,
      lower(v_price_row->>'currency'),
      v_actor_id,
      v_now,
      v_now,
      'synced',
      1,
      false
    );
  END LOOP;

  SELECT to_jsonb(product_row)
  INTO v_product_payload
  FROM public.products AS product_row
  WHERE product_row.id = v_product_id;

  SELECT to_jsonb(conversion_row)
  INTO v_conversion
  FROM public.product_unit_conversions AS conversion_row
  WHERE conversion_row.product_id = v_product_id
    AND COALESCE(conversion_row.is_deleted, false) = false;

  SELECT COALESCE(jsonb_agg(to_jsonb(inventory_row) ORDER BY inventory_row.created_at, inventory_row.id), '[]'::jsonb)
  INTO v_inventory
  FROM public.inventory AS inventory_row
  WHERE inventory_row.workspace_id = v_workspace_id
    AND inventory_row.product_id = v_product_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(batch_row) ORDER BY batch_row.created_at, batch_row.id), '[]'::jsonb)
  INTO v_batches
  FROM public.stock_batches AS batch_row
  WHERE batch_row.workspace_id = v_workspace_id
    AND batch_row.product_id = v_product_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(price_row) ORDER BY price_row.created_at, price_row.id), '[]'::jsonb)
  INTO v_price_book_items
  FROM public.price_book_items AS price_row
  WHERE price_row.workspace_id = v_workspace_id
    AND price_row.product_id = v_product_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(unit_price_row) ORDER BY unit_price_row.created_at, unit_price_row.id), '[]'::jsonb)
  INTO v_unit_prices
  FROM public.price_book_unit_prices AS unit_price_row
  WHERE unit_price_row.workspace_id = v_workspace_id
    AND unit_price_row.product_id = v_product_id;

  RETURN jsonb_build_object(
    'product', v_product_payload,
    'conversion', v_conversion,
    'inventory', v_inventory,
    'stock_batches', v_batches,
    'price_book_items', v_price_book_items,
    'price_book_unit_prices', v_unit_prices
  );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range OR null_value_not_allowed THEN
    RAISE EXCEPTION 'single_unit_conversion_invalid' USING ERRCODE = '22023';
END;
$function$;

CREATE OR REPLACE FUNCTION public.convert_single_unit_product_to_relationship(
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.convert_single_unit_product_to_relationship(p_payload);
$function$;

REVOKE ALL ON FUNCTION private.convert_single_unit_product_to_relationship(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.convert_single_unit_product_to_relationship(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.convert_single_unit_product_to_relationship(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.convert_single_unit_product_to_relationship(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.convert_single_unit_product_to_relationship(jsonb) IS
  'Atomically converts one existing single-unit product to a related-unit product, replaces its stock allocation, retires old batch quantities, and replaces its main and Price Book prices.';

NOTIFY pgrst, 'reload schema';
