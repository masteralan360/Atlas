CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS business_partners_name_search_trgm_idx
  ON crm.business_partners USING gin (partner_name extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS business_partners_phone_search_trgm_idx
  ON crm.business_partners USING gin (phone extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS business_partners_city_search_trgm_idx
  ON crm.business_partners USING gin (city extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS agents_zone_search_trgm_idx
  ON crm.agents USING gin (zone extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS agents_type_search_trgm_idx
  ON crm.agents USING gin (agent_type extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS agents_status_search_trgm_idx
  ON crm.agents USING gin (status extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;

CREATE INDEX IF NOT EXISTS products_name_search_trgm_idx
  ON public.products USING gin (name extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS products_sku_search_trgm_idx
  ON public.products USING gin (sku extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS products_workspace_name_prefix_idx
  ON public.products (workspace_id, lower(name) text_pattern_ops, id)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS products_workspace_sku_prefix_idx
  ON public.products (workspace_id, lower(sku) text_pattern_ops, id)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS rental_vehicles_make_search_trgm_idx
  ON car_rental.rental_vehicles USING gin (make extensions.gin_trgm_ops)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS rental_vehicles_model_search_trgm_idx
  ON car_rental.rental_vehicles USING gin (model extensions.gin_trgm_ops)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS rental_vehicles_plate_search_trgm_idx
  ON car_rental.rental_vehicles USING gin (plate_number extensions.gin_trgm_ops)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS rental_vehicles_category_search_trgm_idx
  ON car_rental.rental_vehicles USING gin (category extensions.gin_trgm_ops)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS rental_vehicles_workspace_plate_prefix_idx
  ON car_rental.rental_vehicles (workspace_id, lower(plate_number) text_pattern_ops, id)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS rental_vehicles_workspace_make_prefix_idx
  ON car_rental.rental_vehicles (workspace_id, lower(COALESCE(make, '')) text_pattern_ops, id)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS rental_vehicles_workspace_model_prefix_idx
  ON car_rental.rental_vehicles (workspace_id, lower(model) text_pattern_ops, id)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS rental_vehicles_workspace_category_prefix_idx
  ON car_rental.rental_vehicles (workspace_id, lower(COALESCE(category, '')) text_pattern_ops, id)
  WHERE is_deleted = false;

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
SECURITY INVOKER
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
  eligible AS NOT MATERIALIZED (
    SELECT product.*
    FROM public.products AS product
    CROSS JOIN normalized
    WHERE p_workspace_id = public.current_workspace_id()
      AND product.workspace_id = p_workspace_id
      AND COALESCE(product.is_deleted, false) = false
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
            AND NOT (accessible_inventory.storage_id = ANY(normalized.excluded_storages))
        )
      )
  ),
  matching AS MATERIALIZED (
    SELECT
      eligible.*,
      ROW_NUMBER() OVER (ORDER BY LOWER(COALESCE(eligible.name, '')) ASC, eligible.id ASC) AS sort_rank
    FROM eligible
    CROSS JOIN normalized
    WHERE normalized.search_term IS NOT NULL
      AND CHAR_LENGTH(normalized.search_term) >= 2
      AND (
      LOWER(eligible.name) LIKE LOWER(normalized.escaped_search) || '%' ESCAPE E'\\'
      OR LOWER(COALESCE(eligible.sku, '')) LIKE LOWER(normalized.escaped_search) || '%' ESCAPE E'\\'
      OR (
        CHAR_LENGTH(normalized.search_term) >= 3
        AND (
          eligible.name ILIKE '%' || normalized.escaped_search || '%' ESCAPE E'\\'
          OR COALESCE(eligible.sku, '') ILIKE '%' || normalized.escaped_search || '%' ESCAPE E'\\'
        )
      )
      )
    ORDER BY LOWER(COALESCE(eligible.name, '')) ASC, eligible.id ASC
    LIMIT (SELECT result_limit FROM normalized)
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
      family_member.*,
      matching.sort_rank,
      COALESCE(matching.parent_product_id, matching.id),
      matching.sort_rank,
      false
    FROM matching
    INNER JOIN eligible AS family_member
      ON family_member.id = COALESCE(matching.parent_product_id, matching.id)
      OR family_member.parent_product_id = COALESCE(matching.parent_product_id, matching.id)
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

REVOKE ALL ON FUNCTION public.search_products_for_autocomplete(uuid, text, uuid[], uuid[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_products_for_autocomplete(uuid, text, uuid[], uuid[], integer) TO authenticated;

CREATE OR REPLACE FUNCTION car_rental.search_vehicle_autocomplete(
  p_workspace_id uuid,
  p_search text,
  p_statuses text[] DEFAULT NULL,
  p_excluded_vehicle_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 8
)
RETURNS SETOF car_rental.rental_vehicles
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH normalized AS (
    SELECT
      NULLIF(BTRIM(COALESCE(p_search, '')), '') AS search_term,
      REPLACE(REPLACE(REPLACE(NULLIF(BTRIM(COALESCE(p_search, '')), ''), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') AS escaped_search,
      GREATEST(1, LEAST(COALESCE(p_limit, 8), 8)) AS result_limit,
      COALESCE(p_statuses, ARRAY[]::text[]) AS selected_statuses,
      COALESCE(p_excluded_vehicle_ids, ARRAY[]::uuid[]) AS excluded_ids
  )
  SELECT vehicle.*
  FROM car_rental.rental_vehicles AS vehicle
  CROSS JOIN normalized
  WHERE p_workspace_id = public.current_workspace_id()
    AND vehicle.workspace_id = p_workspace_id
    AND vehicle.is_deleted = false
    AND (
      cardinality(normalized.selected_statuses) = 0
      OR vehicle.status = ANY(normalized.selected_statuses)
    )
    AND NOT (vehicle.id = ANY(normalized.excluded_ids))
    AND normalized.search_term IS NOT NULL
    AND CHAR_LENGTH(normalized.search_term) >= 2
    AND (
      LOWER(COALESCE(vehicle.make, '')) LIKE LOWER(normalized.escaped_search) || '%' ESCAPE E'\\'
      OR LOWER(vehicle.model) LIKE LOWER(normalized.escaped_search) || '%' ESCAPE E'\\'
      OR LOWER(vehicle.plate_number) LIKE LOWER(normalized.escaped_search) || '%' ESCAPE E'\\'
      OR LOWER(COALESCE(vehicle.category, '')) LIKE LOWER(normalized.escaped_search) || '%' ESCAPE E'\\'
      OR (
        CHAR_LENGTH(normalized.search_term) >= 3
        AND (
          COALESCE(vehicle.make, '') ILIKE '%' || normalized.escaped_search || '%' ESCAPE E'\\'
          OR vehicle.model ILIKE '%' || normalized.escaped_search || '%' ESCAPE E'\\'
          OR vehicle.plate_number ILIKE '%' || normalized.escaped_search || '%' ESCAPE E'\\'
          OR COALESCE(vehicle.category, '') ILIKE '%' || normalized.escaped_search || '%' ESCAPE E'\\'
        )
      )
    )
  ORDER BY LOWER(vehicle.plate_number) ASC, vehicle.id ASC
  LIMIT (SELECT result_limit FROM normalized);
$function$;

REVOKE ALL ON FUNCTION car_rental.search_vehicle_autocomplete(uuid, text, text[], uuid[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION car_rental.search_vehicle_autocomplete(uuid, text, text[], uuid[], integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
