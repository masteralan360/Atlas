CREATE INDEX IF NOT EXISTS inventory_transactions_stock_adjustment_page_idx
  ON public.inventory_transactions (workspace_id, created_at DESC, id DESC)
  WHERE is_deleted = false AND transaction_type = 'stock_adjustment';

CREATE INDEX IF NOT EXISTS inventory_transactions_stock_adjustment_product_page_idx
  ON public.inventory_transactions (workspace_id, product_id, created_at DESC, id DESC)
  WHERE is_deleted = false AND transaction_type = 'stock_adjustment';

CREATE INDEX IF NOT EXISTS inventory_transactions_stock_adjustment_storage_page_idx
  ON public.inventory_transactions (workspace_id, storage_id, created_at DESC, id DESC)
  WHERE is_deleted = false AND transaction_type = 'stock_adjustment';

CREATE INDEX IF NOT EXISTS inventory_transactions_stock_adjustment_reason_page_idx
  ON public.inventory_transactions (workspace_id, adjustment_reason, created_at DESC, id DESC)
  WHERE is_deleted = false AND transaction_type = 'stock_adjustment';

CREATE INDEX IF NOT EXISTS stock_batches_workspace_product_storage_page_idx
  ON public.stock_batches (workspace_id, product_id, storage_id, lower(batch_number), id)
  WHERE is_deleted = false;

CREATE OR REPLACE FUNCTION public.get_stock_adjustments_list_page(
  p_workspace_id uuid,
  p_page integer,
  p_page_size integer,
  p_start_at timestamptz,
  p_end_before timestamptz,
  p_product_id uuid,
  p_storage_id uuid,
  p_adjustment_type text,
  p_reason text,
  p_excluded_storage_ids uuid[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH filtered AS MATERIALIZED (
    SELECT transaction_row.*
    FROM public.inventory_transactions AS transaction_row
    WHERE transaction_row.workspace_id = p_workspace_id
      AND transaction_row.is_deleted = false
      AND transaction_row.transaction_type = 'stock_adjustment'
      AND (p_start_at IS NULL OR transaction_row.created_at >= p_start_at)
      AND (p_end_before IS NULL OR transaction_row.created_at < p_end_before)
      AND (p_product_id IS NULL OR transaction_row.product_id = p_product_id)
      AND (p_storage_id IS NULL OR transaction_row.storage_id = p_storage_id)
      AND (
        COALESCE(cardinality(p_excluded_storage_ids), 0) = 0
        OR NOT (transaction_row.storage_id = ANY(p_excluded_storage_ids))
      )
      AND (
        p_adjustment_type IS NULL
        OR (p_adjustment_type = 'increase' AND transaction_row.quantity_delta > 0)
        OR (p_adjustment_type = 'decrease' AND transaction_row.quantity_delta < 0)
      )
      AND (
        p_reason IS NULL
        OR COALESCE(transaction_row.adjustment_reason, 'correction') = p_reason
      )
  ), page_rows AS (
    SELECT *
    FROM filtered
    ORDER BY created_at DESC, id DESC
    OFFSET GREATEST(p_page - 1, 0) * GREATEST(p_page_size, 1)
    LIMIT GREATEST(p_page_size, 1)
  )
  SELECT pg_catalog.jsonb_build_object(
    'rows', COALESCE(
      (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page_rows) ORDER BY created_at DESC, id DESC)
       FROM page_rows),
      '[]'::jsonb
    ),
    'total_count', (SELECT pg_catalog.count(*) FROM filtered)
  )
$function$;

CREATE OR REPLACE FUNCTION public.get_stock_batch_groups_page(
  p_workspace_id uuid,
  p_page integer,
  p_page_size integer,
  p_search text,
  p_excluded_storage_ids uuid[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH filtered AS MATERIALIZED (
    SELECT batch_row.*
    FROM public.stock_batches AS batch_row
    LEFT JOIN public.products AS product
      ON product.id = batch_row.product_id
      AND product.workspace_id = batch_row.workspace_id
    LEFT JOIN public.storages AS storage
      ON storage.id = batch_row.storage_id
      AND storage.workspace_id = batch_row.workspace_id
    WHERE batch_row.workspace_id = p_workspace_id
      AND batch_row.is_deleted = false
      AND (
        COALESCE(cardinality(p_excluded_storage_ids), 0) = 0
        OR NOT (batch_row.storage_id = ANY(p_excluded_storage_ids))
      )
      AND (
        NULLIF(pg_catalog.btrim(p_search), '') IS NULL
        OR batch_row.batch_number ILIKE '%' || pg_catalog.btrim(p_search) || '%'
        OR COALESCE(batch_row.notes, '') ILIKE '%' || pg_catalog.btrim(p_search) || '%'
        OR COALESCE(product.name, '') ILIKE '%' || pg_catalog.btrim(p_search) || '%'
        OR COALESCE(product.sku, '') ILIKE '%' || pg_catalog.btrim(p_search) || '%'
        OR COALESCE(storage.name, '') ILIKE '%' || pg_catalog.btrim(p_search) || '%'
      )
  ), grouped AS MATERIALIZED (
    SELECT
      product_id,
      storage_id,
      COALESCE(SUM(quantity), 0) AS batch_quantity,
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(filtered)
        ORDER BY lower(batch_number), id
      ) AS batch_rows
    FROM filtered
    GROUP BY product_id, storage_id
  ), page_groups AS (
    SELECT *
    FROM grouped
    ORDER BY product_id ASC, storage_id ASC
    OFFSET GREATEST(p_page - 1, 0) * GREATEST(p_page_size, 1)
    LIMIT GREATEST(p_page_size, 1)
  )
  SELECT pg_catalog.jsonb_build_object(
    'rows', COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'product_id', product_id,
            'storage_id', storage_id,
            'batch_quantity', batch_quantity,
            'rows', batch_rows
          )
          ORDER BY product_id ASC, storage_id ASC
        )
        FROM page_groups
      ),
      '[]'::jsonb
    ),
    'total_count', (SELECT pg_catalog.count(*) FROM grouped)
  )
$function$;

REVOKE ALL ON FUNCTION public.get_stock_adjustments_list_page(
  uuid, integer, integer, timestamptz, timestamptz, uuid, uuid, text, text, uuid[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_stock_batch_groups_page(
  uuid, integer, integer, text, uuid[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_adjustments_list_page(
  uuid, integer, integer, timestamptz, timestamptz, uuid, uuid, text, text, uuid[]
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_stock_batch_groups_page(
  uuid, integer, integer, text, uuid[]
) TO authenticated;

NOTIFY pgrst, 'reload schema';
