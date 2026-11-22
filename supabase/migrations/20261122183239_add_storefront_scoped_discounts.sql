-- Return active discounts that apply to the configured price source for a
-- website storefront mode. Marketplace catalog calls keep their native-price
-- behavior through get_active_discounts_for_marketplace_storage.
CREATE OR REPLACE FUNCTION public.get_active_discounts_for_storefront_storage(
  p_workspace_id uuid,
  p_storage_id uuid,
  p_price_book_id uuid
)
RETURNS TABLE (
  product_id uuid,
  discount_type text,
  discount_value numeric,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  min_stock_threshold integer,
  source text,
  is_stock_ok boolean
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  WITH stock_totals AS (
    SELECT inventory.product_id, COALESCE(SUM(inventory.quantity), 0)::integer AS total_stock
    FROM public.inventory AS inventory
    WHERE inventory.workspace_id = p_workspace_id
      AND inventory.storage_id = p_storage_id
      AND COALESCE(inventory.is_deleted, false) = false
    GROUP BY inventory.product_id
  ),
  active_product_discounts AS (
    SELECT
      pd.product_id,
      pd.discount_type,
      pd.discount_value,
      pd.starts_at,
      pd.ends_at,
      pd.min_stock_threshold,
      'product'::text AS source,
      ROW_NUMBER() OVER (
        PARTITION BY pd.product_id
        ORDER BY pd.starts_at DESC, pd.created_at DESC, pd.id DESC
      ) AS rn
    FROM public.product_discounts AS pd
    JOIN public.products AS product
      ON product.id = pd.product_id
     AND product.workspace_id = p_workspace_id
     AND COALESCE(product.is_deleted, false) = false
    WHERE p_workspace_id IS NOT NULL
      AND p_storage_id IS NOT NULL
      AND pd.workspace_id = p_workspace_id
      AND COALESCE(pd.is_deleted, false) = false
      AND pd.is_active = true
      AND (
        (
          p_price_book_id IS NULL
          AND pd.price_scope IN ('all', 'native_only')
        )
        OR (
          p_price_book_id IS NOT NULL
          AND (
            pd.price_scope = 'all'
            OR (
              pd.price_scope = 'specific_price_books'
              AND p_price_book_id = ANY(pd.price_book_ids)
            )
          )
        )
      )
      AND pd.starts_at <= now()
      AND pd.ends_at >= now()
  ),
  active_category_discounts AS (
    SELECT
      product.id AS product_id,
      cd.discount_type,
      cd.discount_value,
      cd.starts_at,
      cd.ends_at,
      cd.min_stock_threshold,
      'category'::text AS source,
      ROW_NUMBER() OVER (
        PARTITION BY product.id
        ORDER BY cd.starts_at DESC, cd.created_at DESC, cd.id DESC
      ) AS rn
    FROM public.category_discounts AS cd
    JOIN public.products AS product
      ON product.category_id = cd.category_id
     AND product.workspace_id = p_workspace_id
     AND COALESCE(product.is_deleted, false) = false
    WHERE p_workspace_id IS NOT NULL
      AND p_storage_id IS NOT NULL
      AND cd.workspace_id = p_workspace_id
      AND COALESCE(cd.is_deleted, false) = false
      AND cd.is_active = true
      AND cd.starts_at <= now()
      AND cd.ends_at >= now()
  ),
  resolved_discounts AS (
    SELECT
      product_discount.product_id,
      product_discount.discount_type,
      product_discount.discount_value,
      product_discount.starts_at,
      product_discount.ends_at,
      product_discount.min_stock_threshold,
      product_discount.source
    FROM active_product_discounts AS product_discount
    WHERE product_discount.rn = 1

    UNION ALL

    SELECT
      category_discount.product_id,
      category_discount.discount_type,
      category_discount.discount_value,
      category_discount.starts_at,
      category_discount.ends_at,
      category_discount.min_stock_threshold,
      category_discount.source
    FROM active_category_discounts AS category_discount
    WHERE category_discount.rn = 1
      AND NOT EXISTS (
        SELECT 1
        FROM active_product_discounts AS product_discount
        WHERE product_discount.product_id = category_discount.product_id
          AND product_discount.rn = 1
      )
  )
  SELECT
    resolved.product_id,
    resolved.discount_type,
    resolved.discount_value,
    resolved.starts_at,
    resolved.ends_at,
    resolved.min_stock_threshold,
    resolved.source,
    CASE
      WHEN resolved.min_stock_threshold IS NULL THEN true
      ELSE COALESCE(stock_totals.total_stock, 0) >= resolved.min_stock_threshold
    END AS is_stock_ok
  FROM resolved_discounts AS resolved
  LEFT JOIN stock_totals ON stock_totals.product_id = resolved.product_id;
$function$;

REVOKE ALL ON FUNCTION public.get_active_discounts_for_storefront_storage(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_active_discounts_for_storefront_storage(uuid, uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_discounts_for_storefront_storage(uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
