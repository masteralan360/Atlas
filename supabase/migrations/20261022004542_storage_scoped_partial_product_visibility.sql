-- A product assigned to several storages is visible through the locations a
-- member can access. Keep the products table policy conservative because raw
-- table rows contain a workspace-wide quantity snapshot.
CREATE OR REPLACE FUNCTION private.current_user_can_access_any_product_storage(
  p_workspace_id uuid,
  p_product_id uuid,
  p_storage_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p_workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.id = p_product_id
        AND product.workspace_id = p_workspace_id
        AND COALESCE(product.is_deleted, false) = false
        AND (
          public.current_user_role() = 'admin'
          OR CASE product.storage_scope
            WHEN 'workspace' THEN
              EXISTS (
                SELECT 1
                FROM public.inventory AS inventory_row
                WHERE inventory_row.workspace_id = p_workspace_id
                  AND inventory_row.product_id = p_product_id
                  AND COALESCE(inventory_row.is_deleted, false) = false
                  AND public.current_user_can_access_storage(p_workspace_id, inventory_row.storage_id)
              )
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM public.inventory AS inventory_row
                  WHERE inventory_row.workspace_id = p_workspace_id
                    AND inventory_row.product_id = p_product_id
                    AND COALESCE(inventory_row.is_deleted, false) = false
                )
                AND (
                  p_storage_id IS NULL
                  OR public.current_user_can_access_storage(p_workspace_id, p_storage_id)
                )
              )
            WHEN 'storage' THEN
              CASE WHEN EXISTS (
                SELECT 1
                FROM public.product_storage_assignments AS assignment
                WHERE assignment.workspace_id = p_workspace_id
                  AND assignment.product_id = p_product_id
                  AND assignment.is_deleted = false
              ) THEN
                EXISTS (
                  SELECT 1
                  FROM public.product_storage_assignments AS assignment
                  WHERE assignment.workspace_id = p_workspace_id
                    AND assignment.product_id = p_product_id
                    AND assignment.is_deleted = false
                    AND public.current_user_can_access_storage(p_workspace_id, assignment.storage_id)
                )
                OR EXISTS (
                  SELECT 1
                  FROM public.inventory AS inventory_row
                  WHERE inventory_row.workspace_id = p_workspace_id
                    AND inventory_row.product_id = p_product_id
                    AND COALESCE(inventory_row.is_deleted, false) = false
                    AND public.current_user_can_access_storage(p_workspace_id, inventory_row.storage_id)
                )
              ELSE
                (
                  EXISTS (
                    SELECT 1
                    FROM public.inventory AS inventory_row
                    WHERE inventory_row.workspace_id = p_workspace_id
                      AND inventory_row.product_id = p_product_id
                      AND COALESCE(inventory_row.is_deleted, false) = false
                      AND public.current_user_can_access_storage(p_workspace_id, inventory_row.storage_id)
                  )
                  OR (
                    NOT EXISTS (
                      SELECT 1
                      FROM public.inventory AS inventory_row
                      WHERE inventory_row.workspace_id = p_workspace_id
                        AND inventory_row.product_id = p_product_id
                        AND COALESCE(inventory_row.is_deleted, false) = false
                    )
                    AND p_storage_id IS NOT NULL
                    AND public.current_user_can_access_storage(p_workspace_id, p_storage_id)
                  )
                )
              END
            WHEN 'unresolved' THEN false
            ELSE
              (
                p_storage_id IS NOT NULL
                AND public.current_user_can_access_storage(p_workspace_id, p_storage_id)
              )
              OR EXISTS (
                SELECT 1
                FROM public.inventory AS inventory_row
                WHERE inventory_row.workspace_id = p_workspace_id
                  AND inventory_row.product_id = p_product_id
                  AND COALESCE(inventory_row.is_deleted, false) = false
                  AND public.current_user_can_access_storage(p_workspace_id, inventory_row.storage_id)
              )
          END
        )
    );
$function$;

REVOKE ALL ON FUNCTION private.current_user_can_access_any_product_storage(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Safe product snapshots are used by generic Cloud/Hybrid hydration and by
-- inventory reads. They preserve the Product shape while returning only
-- accessible stock and never returning a restricted primary storage ID.
CREATE OR REPLACE FUNCTION public.get_visible_products_for_current_user(
  p_workspace_id uuid,
  p_product_ids uuid[] DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(id uuid, product jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH visible_products AS (
    SELECT
      product.*,
      COALESCE(stock.visible_quantity, 0) AS visible_quantity
    FROM public.products AS product
    LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(inventory_row.quantity, 0)) AS visible_quantity
      FROM public.inventory AS inventory_row
      WHERE inventory_row.workspace_id = product.workspace_id
        AND inventory_row.product_id = product.id
        AND COALESCE(inventory_row.is_deleted, false) = false
        AND (
          public.current_user_role() = 'admin'
          OR public.current_user_can_access_storage(product.workspace_id, inventory_row.storage_id)
        )
    ) AS stock ON true
    WHERE p_workspace_id = public.current_workspace_id()
      AND product.workspace_id = p_workspace_id
      AND COALESCE(product.is_deleted, false) = false
      AND (p_product_ids IS NULL OR product.id = ANY(p_product_ids))
      AND (
        NOT COALESCE(product.is_service, false)
        OR public.services_module_allowed(product.workspace_id)
      )
      AND (
        COALESCE(product.is_service, false)
        OR private.current_user_can_access_any_product_storage(
          product.workspace_id,
          product.id,
          product.storage_id
        )
      )
  )
  SELECT
    visible_products.id,
    (TO_JSONB(visible_products) - 'visible_quantity' - 'quantity' - 'storage_id')
      || JSONB_BUILD_OBJECT(
        'quantity', CASE
          WHEN public.current_user_role() = 'admin' THEN visible_products.quantity
          ELSE visible_products.visible_quantity
        END,
        'storage_id', CASE
          WHEN visible_products.storage_id IS NULL
            OR public.current_user_can_access_storage(p_workspace_id, visible_products.storage_id)
          THEN visible_products.storage_id
          ELSE NULL
        END,
        'storage_name', NULL
      ) AS product
  FROM visible_products
  ORDER BY visible_products.id
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  LIMIT GREATEST(LEAST(COALESCE(p_limit, 500), 1000), 1);
$function$;

REVOKE ALL ON FUNCTION public.get_visible_products_for_current_user(uuid, uuid[], integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_visible_products_for_current_user(uuid, uuid[], integer, integer) TO authenticated;

-- The server-paged Products list runs with an explicit per-storage boundary;
-- its product, inventory, and assignment payloads are all redacted together.
DO $catalog_page$
DECLARE
  v_definition text;
  v_expected_assignment_filter constant text := 'product_storage_assignments';
BEGIN
  SELECT pg_get_functiondef(
    'public.get_products_catalog_page(text,text,uuid[],uuid[],uuid[],text[],numeric,numeric,numeric,numeric,text,integer,integer)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Product catalog page function was not found';
  END IF;

  IF position(v_expected_assignment_filter IN v_definition) = 0
    OR strpos(v_definition, ' STABLE' || E'\n SET search_path TO') = 0 THEN
    RAISE EXCEPTION 'Product catalog page function no longer matches the expected safe source';
  END IF;

  v_definition := replace(
    v_definition,
    ' STABLE' || E'\n SET search_path TO',
    ' STABLE SECURITY DEFINER' || E'\n SET search_path TO'
  );
  v_definition := replace(
    v_definition,
    '      AND COALESCE(product.is_deleted, false) = false',
    '      AND COALESCE(product.is_deleted, false) = false' || E'\n'
      || '      AND (NOT COALESCE(product.is_service, false) OR public.services_module_allowed(product.workspace_id))' || E'\n'
      || '      AND (COALESCE(product.is_service, false) OR private.current_user_can_access_any_product_storage(product.workspace_id, product.id, product.storage_id))'
  );
  v_definition := replace(
    v_definition,
    '        AND COALESCE(inventory_row.is_deleted, false) = false',
    '        AND COALESCE(inventory_row.is_deleted, false) = false' || E'\n'
      || '        AND (public.current_user_role() = ''admin'' OR public.current_user_can_access_storage(inventory_row.workspace_id, inventory_row.storage_id))'
  );
  v_definition := replace(
    v_definition,
    '            AND COALESCE(stock_position.is_deleted, false) = false',
    '            AND COALESCE(stock_position.is_deleted, false) = false' || E'\n'
      || '            AND (public.current_user_role() = ''admin'' OR public.current_user_can_access_storage(stock_position.workspace_id, stock_position.storage_id))'
  );
  v_definition := replace(
    v_definition,
    '      AND COALESCE(parent_product.is_deleted, false) = false',
    '      AND COALESCE(parent_product.is_deleted, false) = false' || E'\n'
      || '      AND (NOT COALESCE(parent_product.is_service, false) OR public.services_module_allowed(parent_product.workspace_id))' || E'\n'
      || '      AND (COALESCE(parent_product.is_service, false) OR private.current_user_can_access_any_product_storage(parent_product.workspace_id, parent_product.id, parent_product.storage_id))'
  );
  v_definition := replace(
    v_definition,
    '            AND COALESCE(category.is_deleted, false) = false',
    '            AND COALESCE(category.is_deleted, false) = false'
  );
  v_definition := replace(
    v_definition,
    '            AND COALESCE(storage.is_deleted, false) = false',
    '            AND COALESCE(storage.is_deleted, false) = false' || E'\n'
      || '            AND (public.current_user_role() = ''admin'' OR public.current_user_can_access_storage(storage.workspace_id, storage.id))'
  );
  v_definition := replace(
    v_definition,
    '          AND COALESCE(stock_position.quantity, 0) > 0',
    '          AND COALESCE(stock_position.quantity, 0) > 0' || E'\n'
      || '          AND (public.current_user_role() = ''admin'' OR public.current_user_can_access_storage(stock_position.workspace_id, stock_position.storage_id))'
  );
  v_definition := replace(
    v_definition,
    '          ''quantity'', page_products.visible_quantity,',
    '          ''quantity'', page_products.visible_quantity,' || E'\n'
      || '          ''storage_id'', CASE WHEN page_products.storage_id IS NULL OR public.current_user_role() = ''admin'' OR public.current_user_can_access_storage(page_products.workspace_id, page_products.storage_id) THEN page_products.storage_id ELSE NULL END,' || E'\n'
      || '          ''storage_name'', NULL,'
  );
  v_definition := replace(
    v_definition,
    '          ''quantity'', support_products.visible_quantity,',
    '          ''quantity'', support_products.visible_quantity,' || E'\n'
      || '          ''storage_id'', CASE WHEN support_products.storage_id IS NULL OR public.current_user_role() = ''admin'' OR public.current_user_can_access_storage(support_products.workspace_id, support_products.storage_id) THEN support_products.storage_id ELSE NULL END,' || E'\n'
      || '          ''storage_name'', NULL,'
  );
  v_definition := replace(
    v_definition,
    '        AND assignment.is_deleted = false',
    '        AND assignment.is_deleted = false' || E'\n'
      || '        AND (public.current_user_role() = ''admin'' OR public.current_user_can_access_storage(assignment.workspace_id, assignment.storage_id))'
  );
  IF position('SECURITY DEFINER' IN v_definition) = 0
    OR position('private.current_user_can_access_any_product_storage' IN v_definition) = 0
    OR position('storage_name' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Product catalog visibility rewrite was incomplete';
  END IF;

  EXECUTE v_definition;
END;
$catalog_page$;

REVOKE ALL ON FUNCTION public.get_products_catalog_page(text,text,uuid[],uuid[],uuid[],text[],numeric,numeric,numeric,numeric,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_products_catalog_page(text,text,uuid[],uuid[],uuid[],text[],numeric,numeric,numeric,numeric,text,integer,integer) TO authenticated;

-- Autocomplete functions already run as SECURITY DEFINER. Let a product pass
-- when it has an accessible assignment or stock position, then redact its
-- workspace quantity and primary storage in the returned product JSON.
DO $autocomplete$
DECLARE
  v_definition text;
  v_quantity_anchor constant text := $quantity_anchor$
          'autocomplete_is_support', NOT product.is_search_match,
  $quantity_anchor$;
  v_quantity_replacement constant text := $quantity_replacement$
          'autocomplete_is_support', NOT product.is_search_match,
          'quantity', CASE
            WHEN public.current_user_role() = 'admin' THEN product.quantity
            ELSE COALESCE((
              SELECT SUM(COALESCE(inventory_row.quantity, 0))
              FROM public.inventory AS inventory_row
              WHERE inventory_row.workspace_id = product.workspace_id
                AND inventory_row.product_id = product.id
                AND COALESCE(inventory_row.is_deleted, false) = false
                AND public.current_user_can_access_storage(inventory_row.workspace_id, inventory_row.storage_id)
            ), 0)
          END,
          'storage_id', CASE
            WHEN product.storage_id IS NULL
              OR public.current_user_role() = 'admin'
              OR public.current_user_can_access_storage(product.workspace_id, product.storage_id)
            THEN product.storage_id
            ELSE NULL
          END,
          'storage_name', NULL,
  $quantity_replacement$;
  v_autocomplete_functions constant text[] := ARRAY[
    'public.search_products_for_autocomplete(uuid,text,uuid[],uuid[],integer)',
    'public.search_products_for_autocomplete_in_storage(uuid,text,text,boolean,uuid[],uuid[],integer)'
  ];
  v_function text;
BEGIN
  FOREACH v_function IN ARRAY v_autocomplete_functions LOOP
    EXECUTE format('SELECT pg_get_functiondef(%L::regprocedure)', v_function) INTO v_definition;
    IF v_definition IS NULL
      OR position('public.current_user_can_access_product_storage(' IN v_definition) = 0
      OR position(v_quantity_anchor IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Expected autocomplete source was not found: %', v_function;
    END IF;

    v_definition := replace(
      v_definition,
      'public.current_user_can_access_product_storage(',
      'private.current_user_can_access_any_product_storage('
    );
    v_definition := replace(v_definition, v_quantity_anchor, v_quantity_replacement);

    IF position('private.current_user_can_access_any_product_storage(' IN v_definition) = 0
      OR position('storage_name' IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Autocomplete visibility rewrite was incomplete: %', v_function;
    END IF;
    EXECUTE v_definition;
  END LOOP;
END;
$autocomplete$;
