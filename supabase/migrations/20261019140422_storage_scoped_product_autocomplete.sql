-- Reuse the production autocomplete plan while requiring candidates and family
-- support rows to belong to the storage selected on the order line.
DO $migration$
DECLARE
  v_definition text;
  v_search_scope_filter constant text := $scope$
      AND (
        (
          normalized.required_storage_id = '__atlas_services__'
          AND COALESCE(product.is_service, false)
        )
        OR (
          normalized.required_storage_id <> '__atlas_services__'
          AND NOT COALESCE(product.is_service, false)
          AND (
            (
              NOT normalized.require_positive_stock
              AND product.storage_id::text = normalized.required_storage_id
              AND public.current_user_can_access_storage(product.workspace_id, product.storage_id)
            )
            OR EXISTS (
              SELECT 1
              FROM public.inventory AS scoped_inventory
              WHERE scoped_inventory.workspace_id = product.workspace_id
                AND scoped_inventory.product_id = product.id
                AND scoped_inventory.storage_id::text = normalized.required_storage_id
                AND COALESCE(scoped_inventory.is_deleted, false) = false
                AND (
                  NOT normalized.require_positive_stock
                  OR COALESCE(scoped_inventory.quantity, 0) > 0
                )
                AND public.current_user_can_access_storage(
                  scoped_inventory.workspace_id,
                  scoped_inventory.storage_id
                )
            )
          )
        )
      )
  $scope$;
  v_response_scope_filter constant text := regexp_replace(
    replace(v_search_scope_filter, 'product.', 'response_rows.'),
    '^\s*AND\s+',
    ''
  );
  v_replacement text;
BEGIN
  SELECT pg_get_functiondef(
    'public.search_products_for_autocomplete(uuid,text,uuid[],uuid[],integer)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Expected product autocomplete function was not found';
  END IF;

  v_replacement := $signature$
CREATE OR REPLACE FUNCTION public.search_products_for_autocomplete_in_storage(
  p_workspace_id uuid,
  p_search text,
  p_storage_id text,
  p_require_positive_stock boolean DEFAULT false,
  p_excluded_category_ids uuid[] DEFAULT NULL,
  p_excluded_storage_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 8
)$signature$;
  v_definition := regexp_replace(
    v_definition,
    'CREATE OR REPLACE FUNCTION public\.search_products_for_autocomplete\([^)]*\)',
    v_replacement
  );

  v_definition := replace(
    v_definition,
    'COALESCE(p_excluded_storage_ids, ARRAY[]::uuid[]) AS excluded_storages',
    'COALESCE(p_excluded_storage_ids, ARRAY[]::uuid[]) AS excluded_storages,' || E'\n      p_storage_id AS required_storage_id,' || E'\n      COALESCE(p_require_positive_stock, false) AS require_positive_stock'
  );

  v_definition := replace(
    v_definition,
    'AND normalized.search_term IS NOT NULL',
    v_search_scope_filter || E'\n      AND normalized.search_term IS NOT NULL'
  );

  v_definition := replace(
    v_definition,
    'FROM response_rows' || E'\n    CROSS JOIN normalized' || E'\n    ORDER BY',
    'FROM response_rows' || E'\n    CROSS JOIN normalized' || E'\n    WHERE ' || ltrim(v_response_scope_filter) || E'\n    ORDER BY'
  );

  v_definition := replace(
    v_definition,
    'AND COALESCE(inventory_row.is_deleted, false) = false',
    'AND COALESCE(inventory_row.is_deleted, false) = false' || E'\n      AND normalized.required_storage_id <> ''__atlas_services__''' || E'\n      AND inventory_row.storage_id::text = normalized.required_storage_id'
  );

  IF position('search_products_for_autocomplete_in_storage' IN v_definition) = 0
    OR position('p_storage_id text' IN v_definition) = 0
    OR position('normalized.required_storage_id' IN v_definition) = 0
    OR position(v_search_scope_filter IN v_definition) = 0
    OR position('p_storage_id AS required_storage_id' IN v_definition) = 0
    OR position('inventory_row.storage_id::text = normalized.required_storage_id' IN v_definition) = 0
    OR position('FROM response_rows' || E'\n    CROSS JOIN normalized' || E'\n    WHERE' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Could not safely create storage-scoped product autocomplete';
  END IF;

  EXECUTE v_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION public.search_products_for_autocomplete_in_storage(
  uuid, text, text, boolean, uuid[], uuid[], integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_products_for_autocomplete_in_storage(
  uuid, text, text, boolean, uuid[], uuid[], integer
) TO authenticated;
