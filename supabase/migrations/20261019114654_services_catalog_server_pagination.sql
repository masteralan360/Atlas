CREATE INDEX IF NOT EXISTS idx_products_workspace_active_service_name
  ON public.products (workspace_id, lower(name), id)
  WHERE COALESCE(is_deleted, false) = false
    AND COALESCE(is_service, false) = true;

CREATE INDEX IF NOT EXISTS products_service_description_search_trgm_idx
  ON public.products USING gin (description extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false
    AND COALESCE(is_service, false) = true;

CREATE OR REPLACE FUNCTION public.get_services_catalog_page(
  p_search text,
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
      REPLACE(
        REPLACE(
          REPLACE(LOWER(BTRIM(COALESCE(p_search, ''))), E'\\', E'\\\\'),
          '%', E'\\%'
        ),
        '_', E'\\_'
      ) AS search_pattern
  ),
  filtered AS (
    SELECT product.*
    FROM public.products AS product
    CROSS JOIN normalized
    WHERE product.workspace_id = public.current_workspace_id()
      AND COALESCE(product.is_deleted, false) = false
      AND COALESCE(product.is_service, false) = true
      AND (
        normalized.search_term = ''
        OR product.name ILIKE '%' || normalized.search_pattern || '%' ESCAPE E'\\'
        OR product.sku ILIKE '%' || normalized.search_pattern || '%' ESCAPE E'\\'
        OR product.description ILIKE '%' || normalized.search_pattern || '%' ESCAPE E'\\'
        OR EXISTS (
          SELECT 1
          FROM public.categories AS category
          WHERE category.id = product.category_id
            AND category.workspace_id = product.workspace_id
            AND COALESCE(category.is_deleted, false) = false
            AND POSITION(normalized.search_term IN LOWER(COALESCE(category.name, ''))) > 0
        )
      )
  ),
  stats AS (
    SELECT COUNT(*)::bigint AS total_count
    FROM filtered
  ),
  page_rows AS (
    SELECT filtered.*
    FROM filtered
    CROSS JOIN normalized
    ORDER BY LOWER(COALESCE(filtered.name, '')) ASC, filtered.id ASC
    OFFSET (SELECT (page_number - 1) * page_size FROM normalized)
    LIMIT (SELECT page_size FROM normalized)
  )
  SELECT jsonb_build_object(
    'services', COALESCE(
      (SELECT jsonb_agg(to_jsonb(page_rows) ORDER BY LOWER(COALESCE(page_rows.name, '')) ASC, page_rows.id ASC)
       FROM page_rows),
      '[]'::jsonb
    ),
    'total_count', stats.total_count,
    'page_count', GREATEST(1, CEIL(stats.total_count::numeric / normalized.page_size)::integer)
  )
  FROM normalized
  CROSS JOIN stats;
$function$;

REVOKE ALL ON FUNCTION public.get_services_catalog_page(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_services_catalog_page(text, integer, integer) TO authenticated;
