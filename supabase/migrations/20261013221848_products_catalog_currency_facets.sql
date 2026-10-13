CREATE OR REPLACE FUNCTION public.get_products_catalog_page(
  p_search text,
  p_catalog_type text,
  p_category_ids uuid[],
  p_storage_ids uuid[],
  p_currencies text[],
  p_min_price numeric,
  p_max_price numeric,
  p_min_stock numeric,
  p_max_stock numeric,
  p_sort text,
  p_page integer,
  p_page_size integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH normalized AS (
    SELECT
      GREATEST(COALESCE(p_page, 1), 1) AS page_number,
      LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100) AS page_size,
      LOWER(BTRIM(COALESCE(p_search, ''))) AS search_term,
      COALESCE(p_catalog_type, 'all') AS catalog_type,
      COALESCE(p_sort, 'name_asc') AS sort_order
  ),
  base_filtered AS (
    SELECT
      product.id,
      COALESCE(product.parent_product_id, product.id) AS family_id,
      LOWER(BTRIM(COALESCE(product.currency, ''))) AS currency,
      LOWER(COALESCE(product.name, '')) AS sort_name,
      LOWER(COALESCE(product.sku, '')) AS sort_sku,
      product.price,
      product.quantity,
      product.created_at
    FROM public.products AS product
    CROSS JOIN normalized
    WHERE product.workspace_id = public.current_workspace_id()
      AND COALESCE(product.is_deleted, false) = false
      AND (
        normalized.catalog_type = 'all'
        OR (normalized.catalog_type = 'products' AND COALESCE(product.is_service, false) = false)
        OR (normalized.catalog_type = 'services' AND COALESCE(product.is_service, false) = true)
      )
      AND (COALESCE(cardinality(p_category_ids), 0) = 0 OR product.category_id = ANY(p_category_ids))
      AND (COALESCE(cardinality(p_storage_ids), 0) = 0 OR product.storage_id = ANY(p_storage_ids))
      AND (p_min_price IS NULL OR product.price >= p_min_price)
      AND (p_max_price IS NULL OR product.price <= p_max_price)
      AND (p_min_stock IS NULL OR product.quantity >= p_min_stock)
      AND (p_max_stock IS NULL OR product.quantity <= p_max_stock)
      AND (
        normalized.search_term = ''
        OR POSITION(normalized.search_term IN LOWER(COALESCE(product.name, ''))) > 0
        OR POSITION(normalized.search_term IN LOWER(COALESCE(product.sku, ''))) > 0
        OR EXISTS (
          SELECT 1
          FROM public.categories AS category
          WHERE category.id = product.category_id
            AND category.workspace_id = product.workspace_id
            AND COALESCE(category.is_deleted, false) = false
            AND POSITION(normalized.search_term IN LOWER(COALESCE(category.name, ''))) > 0
        )
        OR EXISTS (
          SELECT 1
          FROM public.storages AS storage
          WHERE storage.id = product.storage_id
            AND storage.workspace_id = product.workspace_id
            AND COALESCE(storage.is_deleted, false) = false
            AND POSITION(normalized.search_term IN LOWER(COALESCE(storage.name, ''))) > 0
        )
        OR EXISTS (
          SELECT 1
          FROM public.product_barcodes AS product_barcode
          WHERE product_barcode.workspace_id = product.workspace_id
            AND product_barcode.product_id = product.id
            AND product_barcode.is_deleted = false
            AND POSITION(normalized.search_term IN LOWER(product_barcode.barcode)) > 0
        )
      )
  ),
  currency_options AS (
    SELECT COALESCE(JSONB_AGG(available.currency ORDER BY available.currency), '[]'::jsonb) AS currencies
    FROM (
      SELECT DISTINCT base_filtered.currency
      FROM base_filtered
      WHERE base_filtered.currency <> ''
    ) AS available
  ),
  filtered AS (
    SELECT
      base_filtered.id,
      base_filtered.family_id,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN normalized.sort_order = 'name_asc' THEN base_filtered.sort_name END ASC,
          CASE WHEN normalized.sort_order = 'name_desc' THEN base_filtered.sort_name END DESC,
          CASE WHEN normalized.sort_order = 'sku_asc' THEN base_filtered.sort_sku END ASC,
          CASE WHEN normalized.sort_order = 'sku_desc' THEN base_filtered.sort_sku END DESC,
          CASE WHEN normalized.sort_order = 'price_asc' THEN base_filtered.price END ASC,
          CASE WHEN normalized.sort_order = 'price_desc' THEN base_filtered.price END DESC,
          CASE WHEN normalized.sort_order = 'stock_asc' THEN base_filtered.quantity END ASC,
          CASE WHEN normalized.sort_order = 'stock_desc' THEN base_filtered.quantity END DESC,
          CASE WHEN normalized.sort_order = 'date_asc' THEN base_filtered.created_at END ASC,
          CASE WHEN normalized.sort_order = 'date_desc' THEN base_filtered.created_at END DESC,
          base_filtered.id ASC
      ) AS sort_rank
    FROM base_filtered
    CROSS JOIN normalized
    WHERE (
      COALESCE(cardinality(p_currencies), 0) = 0
      OR base_filtered.currency = ANY(p_currencies)
    )
  ),
  family_order AS (
    SELECT family_id, MIN(sort_rank) AS family_rank
    FROM filtered
    GROUP BY family_id
  ),
  page_families AS (
    SELECT family_order.family_id, family_order.family_rank
    FROM family_order
    ORDER BY family_order.family_rank
    OFFSET (SELECT (page_number - 1) * page_size FROM normalized)
    LIMIT (SELECT page_size FROM normalized)
  ),
  page_match_ids AS (
    SELECT filtered.id, filtered.family_id, filtered.sort_rank
    FROM filtered
    INNER JOIN page_families ON page_families.family_id = filtered.family_id
  ),
  page_products AS (
    SELECT
      product.*,
      page_match_ids.family_id,
      page_match_ids.sort_rank
    FROM page_match_ids
    INNER JOIN public.products AS product ON product.id = page_match_ids.id
  ),
  support_products AS (
    SELECT DISTINCT ON (page_families.family_id)
      parent_product.*,
      page_families.family_id,
      page_families.family_rank AS sort_rank
    FROM page_families
    INNER JOIN public.products AS parent_product ON parent_product.id = page_families.family_id
    WHERE parent_product.workspace_id = public.current_workspace_id()
      AND COALESCE(parent_product.is_deleted, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM page_match_ids WHERE page_match_ids.id = parent_product.id
      )
  ),
  response_products AS (
    SELECT
      page_products.id,
      page_products.family_id,
      page_products.sort_rank,
      to_jsonb(page_products) - 'family_id' - 'sort_rank'
        || jsonb_build_object(
          'barcode', barcodes.primary_barcode,
          'barcodes', COALESCE(barcodes.barcode_values, '[]'::jsonb)
        ) AS product_json,
      true AS is_match
    FROM page_products
    LEFT JOIN LATERAL (
      SELECT
        (ARRAY_AGG(product_barcode.barcode ORDER BY product_barcode.is_primary DESC, product_barcode.created_at, product_barcode.barcode))[1] AS primary_barcode,
        JSONB_AGG(product_barcode.barcode ORDER BY product_barcode.is_primary DESC, product_barcode.created_at, product_barcode.barcode) AS barcode_values
      FROM public.product_barcodes AS product_barcode
      WHERE product_barcode.workspace_id = page_products.workspace_id
        AND product_barcode.product_id = page_products.id
        AND product_barcode.is_deleted = false
    ) AS barcodes ON true
    UNION ALL
    SELECT
      support_products.id,
      support_products.family_id,
      support_products.sort_rank,
      to_jsonb(support_products) - 'family_id' - 'sort_rank'
        || jsonb_build_object(
          'barcode', barcodes.primary_barcode,
          'barcodes', COALESCE(barcodes.barcode_values, '[]'::jsonb)
        ) AS product_json,
      false AS is_match
    FROM support_products
    LEFT JOIN LATERAL (
      SELECT
        (ARRAY_AGG(product_barcode.barcode ORDER BY product_barcode.is_primary DESC, product_barcode.created_at, product_barcode.barcode))[1] AS primary_barcode,
        JSONB_AGG(product_barcode.barcode ORDER BY product_barcode.is_primary DESC, product_barcode.created_at, product_barcode.barcode) AS barcode_values
      FROM public.product_barcodes AS product_barcode
      WHERE product_barcode.workspace_id = support_products.workspace_id
        AND product_barcode.product_id = support_products.id
        AND product_barcode.is_deleted = false
    ) AS barcodes ON true
  ),
  counts AS (
    SELECT
      (SELECT COUNT(*) FROM filtered) AS total_count,
      (SELECT COUNT(*) FROM family_order) AS family_count,
      (SELECT page_size FROM normalized) AS page_size
  )
  SELECT JSONB_BUILD_OBJECT(
    'products', COALESCE((
      SELECT JSONB_AGG(response_products.product_json ORDER BY response_products.sort_rank, response_products.is_match ASC, response_products.id)
      FROM response_products
    ), '[]'::jsonb),
    'matched_product_ids', COALESCE((
      SELECT JSONB_AGG(page_match_ids.id ORDER BY page_match_ids.sort_rank)
      FROM page_match_ids
    ), '[]'::jsonb),
    'inventory', COALESCE((
      SELECT JSONB_AGG(TO_JSONB(inventory_row) ORDER BY inventory_row.storage_id, inventory_row.product_id)
      FROM public.inventory AS inventory_row
      WHERE inventory_row.workspace_id = public.current_workspace_id()
        AND COALESCE(inventory_row.is_deleted, false) = false
        AND EXISTS (
          SELECT 1 FROM response_products
          WHERE response_products.id = inventory_row.product_id
        )
    ), '[]'::jsonb),
    'available_currencies', currency_options.currencies,
    'total_count', counts.total_count,
    'family_count', counts.family_count,
    'page_count', GREATEST(1, CEIL(counts.family_count::numeric / counts.page_size)::integer)
  )
  FROM counts
  CROSS JOIN currency_options;
$function$;

REVOKE ALL ON FUNCTION public.get_products_catalog_page(text, text, uuid[], uuid[], text[], numeric, numeric, numeric, numeric, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_products_catalog_page(text, text, uuid[], uuid[], text[], numeric, numeric, numeric, numeric, text, integer, integer) TO authenticated;
