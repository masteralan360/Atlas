-- Restrict visibility checks to matches and use a bounded family lookup for product autocomplete.
CREATE INDEX IF NOT EXISTS products_workspace_active_family_name_idx
  ON public.products (
    workspace_id,
    parent_product_id,
    lower(COALESCE(name, '')),
    id
  )
  WHERE parent_product_id IS NOT NULL
    AND COALESCE(is_deleted, false) = false;

CREATE OR REPLACE FUNCTION public.search_products_for_autocomplete(
  p_workspace_id uuid,
  p_search text,
  p_excluded_category_ids uuid[] DEFAULT NULL,
  p_excluded_storage_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH normalized AS (
    SELECT
      NULLIF(BTRIM(COALESCE(p_search, '')), '') AS search_term,
      REPLACE(REPLACE(REPLACE(NULLIF(BTRIM(COALESCE(p_search, '')), ''), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') AS escaped_search,
      GREATEST(1, LEAST(COALESCE(p_limit, 8), 8)) AS result_limit,
      COALESCE(p_excluded_category_ids, ARRAY[]::uuid[]) AS excluded_categories,
      COALESCE(p_excluded_storage_ids, ARRAY[]::uuid[]) AS excluded_storages
  ),
  search_candidates AS MATERIALIZED (
    SELECT product.*
    FROM public.products AS product
    CROSS JOIN normalized
    WHERE p_workspace_id = public.current_workspace_id()
      AND product.workspace_id = p_workspace_id
      AND COALESCE(product.is_deleted, false) = false
      AND normalized.search_term IS NOT NULL
      AND CHAR_LENGTH(normalized.search_term) >= 2
      AND (
        LOWER(product.name) LIKE LOWER(normalized.escaped_search) || '%' ESCAPE E'\\'
        OR LOWER(COALESCE(product.sku, '')) LIKE LOWER(normalized.escaped_search) || '%' ESCAPE E'\\'
        OR (
          CHAR_LENGTH(normalized.search_term) >= 3
          AND (
            product.name ILIKE '%' || normalized.escaped_search || '%' ESCAPE E'\\'
            OR COALESCE(product.sku, '') ILIKE '%' || normalized.escaped_search || '%' ESCAPE E'\\'
          )
        )
      )
  ),
  eligible_matches AS MATERIALIZED (
    SELECT search_candidates.*
    FROM search_candidates
    CROSS JOIN normalized
    WHERE (
      search_candidates.created_by = auth.uid()
      OR (
        (NOT COALESCE(search_candidates.is_service, false)
          OR public.services_module_allowed(search_candidates.workspace_id))
        AND (
          COALESCE(search_candidates.is_service, false)
          OR search_candidates.storage_id IS NULL
          OR public.current_user_can_access_storage(
            search_candidates.workspace_id,
            search_candidates.storage_id
          )
          OR EXISTS (
            SELECT 1
            FROM public.inventory AS visible_inventory
            WHERE visible_inventory.workspace_id = search_candidates.workspace_id
              AND visible_inventory.product_id = search_candidates.id
              AND COALESCE(visible_inventory.is_deleted, false) = false
              AND public.current_user_can_access_storage(
                visible_inventory.workspace_id,
                visible_inventory.storage_id
              )
          )
        )
      )
    )
      AND (
        COALESCE(cardinality(normalized.excluded_categories), 0) = 0
        OR search_candidates.category_id IS NULL
        OR NOT (search_candidates.category_id = ANY(normalized.excluded_categories))
      )
      AND (
        COALESCE(cardinality(normalized.excluded_storages), 0) = 0
        OR COALESCE(search_candidates.is_service, false)
        OR search_candidates.storage_id IS NULL
        OR NOT (search_candidates.storage_id = ANY(normalized.excluded_storages))
        OR EXISTS (
          SELECT 1
          FROM public.inventory AS accessible_inventory
          WHERE accessible_inventory.workspace_id = search_candidates.workspace_id
            AND accessible_inventory.product_id = search_candidates.id
            AND COALESCE(accessible_inventory.is_deleted, false) = false
            AND public.current_user_can_access_storage(
              accessible_inventory.workspace_id,
              accessible_inventory.storage_id
            )
            AND NOT (accessible_inventory.storage_id = ANY(normalized.excluded_storages))
        )
      )
    ORDER BY LOWER(COALESCE(search_candidates.name, '')) ASC, search_candidates.id ASC
    LIMIT (SELECT result_limit FROM normalized)
  ),
  matching AS MATERIALIZED (
    SELECT
      eligible_matches.*,
      ROW_NUMBER() OVER (
        ORDER BY LOWER(COALESCE(eligible_matches.name, '')) ASC, eligible_matches.id ASC
      ) AS sort_rank
    FROM eligible_matches
  ),
  family_keys AS MATERIALIZED (
    SELECT
      matching.id,
      matching.parent_product_id,
      matching.sort_rank,
      COALESCE(matching.parent_product_id, matching.id) AS family_id
    FROM matching
  ),
  family_rows AS (
    SELECT
      matching.*,
      COALESCE(matching.parent_product_id, matching.id) AS family_id,
      matching.sort_rank AS family_rank,
      true AS is_search_match
    FROM matching
    UNION ALL
    SELECT
      family_parent.*,
      family_keys.sort_rank,
      family_keys.family_id,
      family_keys.sort_rank,
      false
    FROM family_keys
    CROSS JOIN normalized
    CROSS JOIN LATERAL (
      SELECT product.*
      FROM public.products AS product
      WHERE product.workspace_id = p_workspace_id
        AND product.id = family_keys.family_id
        AND COALESCE(product.is_deleted, false) = false
        AND (
          product.created_by = auth.uid()
          OR (
            (NOT COALESCE(product.is_service, false)
              OR public.services_module_allowed(product.workspace_id))
            AND (
              COALESCE(product.is_service, false)
              OR product.storage_id IS NULL
              OR public.current_user_can_access_storage(product.workspace_id, product.storage_id)
              OR EXISTS (
                SELECT 1
                FROM public.inventory AS visible_inventory
                WHERE visible_inventory.workspace_id = product.workspace_id
                  AND visible_inventory.product_id = product.id
                  AND COALESCE(visible_inventory.is_deleted, false) = false
                  AND public.current_user_can_access_storage(
                    visible_inventory.workspace_id,
                    visible_inventory.storage_id
                  )
              )
            )
          )
        )
        AND (
          COALESCE(cardinality(normalized.excluded_categories), 0) = 0
          OR product.category_id IS NULL
          OR NOT (product.category_id = ANY(normalized.excluded_categories))
        )
        AND (
          COALESCE(cardinality(normalized.excluded_storages), 0) = 0
          OR COALESCE(product.is_service, false)
          OR product.storage_id IS NULL
          OR NOT (product.storage_id = ANY(normalized.excluded_storages))
          OR EXISTS (
            SELECT 1
            FROM public.inventory AS accessible_inventory
            WHERE accessible_inventory.workspace_id = product.workspace_id
              AND accessible_inventory.product_id = product.id
              AND COALESCE(accessible_inventory.is_deleted, false) = false
              AND public.current_user_can_access_storage(
                accessible_inventory.workspace_id,
                accessible_inventory.storage_id
              )
              AND NOT (accessible_inventory.storage_id = ANY(normalized.excluded_storages))
          )
        )
      LIMIT 1
    ) AS family_parent
    UNION ALL
    SELECT
      family_member.*,
      family_keys.sort_rank,
      family_keys.family_id,
      family_keys.sort_rank,
      false
    FROM family_keys
    CROSS JOIN normalized
    CROSS JOIN LATERAL (
      SELECT product.*
      FROM public.products AS product
      WHERE product.workspace_id = p_workspace_id
        AND product.parent_product_id = family_keys.family_id
        AND COALESCE(product.is_deleted, false) = false
        AND (
          product.created_by = auth.uid()
          OR (
            (NOT COALESCE(product.is_service, false)
              OR public.services_module_allowed(product.workspace_id))
            AND (
              COALESCE(product.is_service, false)
              OR product.storage_id IS NULL
              OR public.current_user_can_access_storage(product.workspace_id, product.storage_id)
              OR EXISTS (
                SELECT 1
                FROM public.inventory AS visible_inventory
                WHERE visible_inventory.workspace_id = product.workspace_id
                  AND visible_inventory.product_id = product.id
                  AND COALESCE(visible_inventory.is_deleted, false) = false
                  AND public.current_user_can_access_storage(
                    visible_inventory.workspace_id,
                    visible_inventory.storage_id
                  )
              )
            )
          )
        )
        AND (
          COALESCE(cardinality(normalized.excluded_categories), 0) = 0
          OR product.category_id IS NULL
          OR NOT (product.category_id = ANY(normalized.excluded_categories))
        )
        AND (
          COALESCE(cardinality(normalized.excluded_storages), 0) = 0
          OR COALESCE(product.is_service, false)
          OR product.storage_id IS NULL
          OR NOT (product.storage_id = ANY(normalized.excluded_storages))
          OR EXISTS (
            SELECT 1
            FROM public.inventory AS accessible_inventory
            WHERE accessible_inventory.workspace_id = product.workspace_id
              AND accessible_inventory.product_id = product.id
              AND COALESCE(accessible_inventory.is_deleted, false) = false
              AND public.current_user_can_access_storage(
                accessible_inventory.workspace_id,
                accessible_inventory.storage_id
              )
              AND NOT (accessible_inventory.storage_id = ANY(normalized.excluded_storages))
          )
        )
      ORDER BY LOWER(COALESCE(product.name, '')), product.id
      LIMIT (SELECT result_limit FROM normalized)
    ) AS family_member
  ),
  response_rows AS (
    SELECT DISTINCT ON (family_rows.id)
      family_rows.*
    FROM family_rows
    ORDER BY family_rows.id, family_rows.is_search_match DESC, family_rows.family_rank ASC
  ),
  limited_response_rows AS (
    SELECT response_rows.*
    FROM response_rows
    CROSS JOIN normalized
    ORDER BY
      response_rows.family_rank,
      (response_rows.id = response_rows.family_id) DESC,
      response_rows.is_search_match DESC,
      LOWER(COALESCE(response_rows.name, '')),
      response_rows.id
    LIMIT (SELECT result_limit FROM normalized)
  ),
  response_products AS (
    SELECT
      product.id,
      product.family_id,
      product.family_rank,
      product.is_search_match,
      (TO_JSONB(product) - 'sort_rank' - 'family_id' - 'family_rank' - 'is_search_match')
        || JSONB_BUILD_OBJECT(
          'autocomplete_is_support', NOT product.is_search_match,
          'barcode', barcode_data.primary_barcode,
          'barcodes', COALESCE(barcode_data.barcode_values, '[]'::jsonb)
        ) AS value
    FROM limited_response_rows AS product
    LEFT JOIN LATERAL (
      SELECT
        (ARRAY_AGG(product_barcode.barcode ORDER BY product_barcode.is_primary DESC, product_barcode.created_at, product_barcode.barcode))[1] AS primary_barcode,
        JSONB_AGG(product_barcode.barcode ORDER BY product_barcode.is_primary DESC, product_barcode.created_at, product_barcode.barcode) AS barcode_values
      FROM public.product_barcodes AS product_barcode
      WHERE product_barcode.workspace_id = product.workspace_id
        AND product_barcode.product_id = product.id
        AND product_barcode.is_deleted = false
    ) AS barcode_data ON true
  ),
  visible_inventory AS (
    SELECT DISTINCT ON (inventory_row.product_id) TO_JSONB(inventory_row) AS value
    FROM public.inventory AS inventory_row
    CROSS JOIN normalized
    WHERE inventory_row.workspace_id = p_workspace_id
      AND COALESCE(inventory_row.is_deleted, false) = false
      AND EXISTS (SELECT 1 FROM limited_response_rows WHERE limited_response_rows.id = inventory_row.product_id)
      AND public.current_user_can_access_storage(inventory_row.workspace_id, inventory_row.storage_id)
      AND (
        COALESCE(cardinality(normalized.excluded_storages), 0) = 0
        OR NOT (inventory_row.storage_id = ANY(normalized.excluded_storages))
      )
    ORDER BY inventory_row.product_id, inventory_row.storage_id
  )
  SELECT JSONB_BUILD_OBJECT(
    'products', COALESCE((SELECT JSONB_AGG(value ORDER BY family_rank, (id = family_id) DESC, is_search_match DESC, id) FROM response_products), '[]'::jsonb),
    'inventory', COALESCE((SELECT JSONB_AGG(value) FROM visible_inventory), '[]'::jsonb)
  );
$function$;

