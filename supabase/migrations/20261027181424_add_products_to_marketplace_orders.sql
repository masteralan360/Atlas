-- Let workspace staff add catalog products to an unshipped marketplace order.
-- Product snapshots and prices come from the workspace catalog, while storage
-- access, order currency, status, discounts, and existing item identity remain
-- validated by the order-edit function.
DO $marketplace_order_item_additions$
DECLARE
  v_definition text;
  v_updated text;
  v_old_declaration text := E'  v_found_count integer;\n';
  v_new_declaration text := E'  v_found_count integer;\n  v_new_product public.products%ROWTYPE;\n  v_new_product_id uuid;\n  v_new_storage_id uuid;\n  v_new_line_total numeric;\n';
  v_old_branch text := $old$    IF v_found_count = 0 THEN
      RAISE EXCEPTION 'Product %s is not part of this marketplace order', COALESCE(NULLIF(v_incoming->>'name', ''), v_incoming->>'product_id', 'Item');
    END IF;
$old$;
  v_new_branch text := $new$    IF v_found_count = 0 THEN
      BEGIN
        v_new_product_id := NULLIF(v_incoming->>'product_id', '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'The selected product is invalid';
      END;

      IF v_new_product_id IS NULL THEN
        RAISE EXCEPTION 'A product is required for each added order item';
      END IF;

      SELECT product.*
      INTO v_new_product
      FROM public.products AS product
      WHERE product.id = v_new_product_id
        AND product.workspace_id = v_order.workspace_id
        AND COALESCE(product.is_deleted, false) = false
        AND COALESCE(product.is_service, false) = false
      FOR SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'The selected product is no longer available';
      END IF;

      IF lower(COALESCE(v_new_product.currency, v_order.currency, 'iqd'))
        IS DISTINCT FROM lower(COALESCE(v_order.currency, 'iqd')) THEN
        RAISE EXCEPTION 'Added products must use the marketplace order currency';
      END IF;

      v_new_storage_id := COALESCE(
        NULLIF(v_incoming->>'storage_id', '')::uuid,
        v_new_product.storage_id
      );

      IF v_new_storage_id IS NULL THEN
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(candidate.storage_id::text)::uuid ELSE NULL END
        INTO v_new_storage_id
        FROM (
          SELECT DISTINCT candidate_storage.storage_id
          FROM (
            SELECT assignment.storage_id
            FROM public.product_storage_assignments AS assignment
            WHERE assignment.workspace_id = v_order.workspace_id
              AND assignment.product_id = v_new_product.id
              AND COALESCE(assignment.is_deleted, false) = false

            UNION

            SELECT inventory.storage_id
            FROM public.inventory AS inventory
            WHERE inventory.workspace_id = v_order.workspace_id
              AND inventory.product_id = v_new_product.id
              AND COALESCE(inventory.is_deleted, false) = false
          ) AS candidate_storage
          JOIN public.storages AS storage
            ON storage.id = candidate_storage.storage_id
            AND storage.workspace_id = v_order.workspace_id
            AND COALESCE(storage.is_deleted, false) = false
          WHERE public.current_user_can_access_product_storage(
            v_order.workspace_id,
            v_new_product.id,
            candidate_storage.storage_id
          )
        ) AS candidate;
      END IF;

      IF v_new_storage_id IS NULL THEN
        RAISE EXCEPTION 'A storage is required to add this product to the order';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM public.storages AS storage
        WHERE storage.id = v_new_storage_id
          AND storage.workspace_id = v_order.workspace_id
          AND COALESCE(storage.is_deleted, false) = false
      ) THEN
        RAISE EXCEPTION 'The selected product storage is no longer available';
      END IF;

      IF NOT private.current_user_can_access_product_storage(
        v_order.workspace_id,
        v_new_product.id,
        v_new_storage_id
      ) THEN
        RAISE EXCEPTION 'The selected product storage is not available to this user';
      END IF;

      IF COALESCE(v_new_product.storage_scope, 'unresolved') <> 'workspace'
        AND v_new_product.storage_id IS DISTINCT FROM v_new_storage_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.product_storage_assignments AS assignment
          WHERE assignment.workspace_id = v_order.workspace_id
            AND assignment.product_id = v_new_product.id
            AND assignment.storage_id = v_new_storage_id
            AND COALESCE(assignment.is_deleted, false) = false
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.inventory AS inventory
          WHERE inventory.workspace_id = v_order.workspace_id
            AND inventory.product_id = v_new_product.id
            AND inventory.storage_id = v_new_storage_id
            AND COALESCE(inventory.is_deleted, false) = false
        ) THEN
        RAISE EXCEPTION 'The selected product is not assigned to this storage';
      END IF;

      v_unit_price := COALESCE(v_new_product.price, 0);
      v_new_line_total := round((v_unit_price * v_qty)::numeric, 2);
      v_new_items := v_new_items || jsonb_build_array(jsonb_build_object(
        'product_id', v_new_product.id,
        'name', v_new_product.name,
        'sku', COALESCE(v_new_product.sku, ''),
        'unit_price', v_unit_price,
        'original_unit_price', v_unit_price,
        'currency', lower(COALESCE(v_new_product.currency, v_order.currency, 'iqd')),
        'quantity', v_qty,
        'line_total', v_new_line_total,
        'cost_price', v_new_product.cost_price,
        'image_url', v_new_product.image_url,
        'unit', v_new_product.unit,
        'storage_id', v_new_storage_id,
        'allocation_group_id', v_new_product.id,
        'discount_type', NULL,
        'discount_value', NULL,
        'discount_ends_at', NULL,
        'discount_source', NULL
      ));
      v_new_subtotal := v_new_subtotal + v_new_line_total;
      v_new_product_count := v_new_product_count + 1;
    END IF;
$new$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.edit_marketplace_order_items(uuid,jsonb)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Marketplace item-edit function was not found';
  END IF;

  v_definition := replace(v_definition, chr(13), '');
  v_old_declaration := replace(v_old_declaration, chr(13), '');
  v_new_declaration := replace(v_new_declaration, chr(13), '');
  v_old_branch := replace(v_old_branch, chr(13), '');
  v_new_branch := replace(v_new_branch, chr(13), '');

  IF position('v_new_product public.products%ROWTYPE;' IN v_definition) > 0 THEN
    RETURN;
  END IF;

  IF position('v_new_product_count := v_new_product_count + 1;' IN v_definition) = 0
    OR position('discount_amount' IN v_definition) = 0
    OR position('Shipped, delivered, and cancelled marketplace orders cannot be edited' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Marketplace item-edit function is not in the expected state';
  END IF;

  v_updated := replace(v_definition, v_old_declaration, v_new_declaration);
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Marketplace product-addition variables could not be declared';
  END IF;
  v_definition := v_updated;

  v_updated := replace(v_definition, v_old_branch, v_new_branch);
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Marketplace product-addition validation could not be installed';
  END IF;

  IF position('The selected product is no longer available' IN v_updated) = 0
    OR position('private.current_user_can_access_product_storage' IN v_updated) = 0
    OR position('Added products must use the marketplace order currency' IN v_updated) = 0 THEN
    RAISE EXCEPTION 'Marketplace product-addition checks are incomplete';
  END IF;

  EXECUTE v_updated;
END;
$marketplace_order_item_additions$;

NOTIFY pgrst, 'reload schema';
