CREATE INDEX IF NOT EXISTS inventory_transactions_workspace_created_page_idx
  ON public.inventory_transactions (workspace_id, created_at DESC, id DESC)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS inventory_transactions_workspace_product_created_page_idx
  ON public.inventory_transactions (workspace_id, product_id, created_at DESC, id DESC)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS inventory_transactions_workspace_storage_created_page_idx
  ON public.inventory_transactions (workspace_id, storage_id, created_at DESC, id DESC)
  WHERE is_deleted = false;

CREATE OR REPLACE FUNCTION public.inventory_transaction_movement_source(
  p_transaction_type text,
  p_reference_type text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE p_reference_type
    WHEN 'pos_sale' THEN 'pos-sale'
    WHEN 'pos_return' THEN 'pos-return'
    WHEN 'sales_order' THEN 'sales-order'
    WHEN 'sales_order_return' THEN 'sales-order-return'
    WHEN 'purchase_order' THEN 'purchase-order'
    WHEN 'purchase_order_repair' THEN 'purchase-order'
    WHEN 'inventory_transfer' THEN 'transfer'
    WHEN 'inventory_transfer_rollback' THEN 'transfer'
    WHEN 'reorder_transfer' THEN 'transfer'
    WHEN 'sale_product_exchange' THEN 'sale-product-exchange'
    WHEN 'sale_product_exchange_return' THEN 'sale-product-exchange-return'
    ELSE CASE p_transaction_type
      WHEN 'stock_adjustment' THEN 'stock-adjustment'
      WHEN 'transfer_in' THEN 'transfer'
      WHEN 'transfer_out' THEN 'transfer'
      WHEN 'purchase' THEN 'purchase-order'
      WHEN 'initial_stock' THEN 'initial-stock'
      ELSE 'inventory-change'
    END
  END
$function$;

CREATE OR REPLACE FUNCTION public.get_inventory_transactions_list_page(
  p_workspace_id uuid,
  p_page integer,
  p_page_size integer,
  p_start_at timestamptz,
  p_end_before timestamptz,
  p_product_id uuid,
  p_direction text,
  p_source text,
  p_storage_id uuid,
  p_excluded_storage_ids uuid[],
  p_snapshot text
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
    LEFT JOIN public.products AS product
      ON product.id = transaction_row.product_id
      AND product.workspace_id = transaction_row.workspace_id
    WHERE transaction_row.workspace_id = p_workspace_id
      AND transaction_row.is_deleted = false
      AND COALESCE(product.is_service, false) = false
      AND (p_start_at IS NULL OR transaction_row.created_at >= p_start_at)
      AND (p_end_before IS NULL OR transaction_row.created_at < p_end_before)
      AND (p_product_id IS NULL OR transaction_row.product_id = p_product_id)
      AND (p_storage_id IS NULL OR transaction_row.storage_id = p_storage_id)
      AND (
        COALESCE(cardinality(p_excluded_storage_ids), 0) = 0
        OR NOT (transaction_row.storage_id = ANY(p_excluded_storage_ids))
      )
      AND (
        p_direction = 'all'
        OR (p_direction = 'incoming' AND transaction_row.quantity_delta > 0)
        OR (p_direction = 'outgoing' AND transaction_row.quantity_delta < 0)
      )
      AND (
        p_source = 'all'
        OR public.inventory_transaction_movement_source(
          transaction_row.transaction_type,
          transaction_row.reference_type
        ) = p_source
      )
      AND (
        p_snapshot = 'all'
        OR (p_snapshot = 'recorded'
          AND transaction_row.previous_quantity IS NOT NULL
          AND transaction_row.new_quantity IS NOT NULL)
        OR (p_snapshot = 'not-recorded'
          AND (transaction_row.previous_quantity IS NULL OR transaction_row.new_quantity IS NULL))
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

CREATE OR REPLACE FUNCTION public.get_inventory_transaction_product_summary_page(
  p_workspace_id uuid,
  p_page integer,
  p_page_size integer,
  p_start_at timestamptz,
  p_end_before timestamptz,
  p_product_id uuid,
  p_direction text,
  p_source text,
  p_storage_id uuid,
  p_excluded_storage_ids uuid[],
  p_snapshot text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH filtered AS MATERIALIZED (
    SELECT
      transaction_row.product_id,
      transaction_row.quantity_delta
    FROM public.inventory_transactions AS transaction_row
    LEFT JOIN public.products AS product
      ON product.id = transaction_row.product_id
      AND product.workspace_id = transaction_row.workspace_id
    WHERE transaction_row.workspace_id = p_workspace_id
      AND transaction_row.is_deleted = false
      AND COALESCE(product.is_service, false) = false
      AND (p_start_at IS NULL OR transaction_row.created_at >= p_start_at)
      AND (p_end_before IS NULL OR transaction_row.created_at < p_end_before)
      AND (p_product_id IS NULL OR transaction_row.product_id = p_product_id)
      AND (p_storage_id IS NULL OR transaction_row.storage_id = p_storage_id)
      AND (
        COALESCE(cardinality(p_excluded_storage_ids), 0) = 0
        OR NOT (transaction_row.storage_id = ANY(p_excluded_storage_ids))
      )
      AND (
        p_direction = 'all'
        OR (p_direction = 'incoming' AND transaction_row.quantity_delta > 0)
        OR (p_direction = 'outgoing' AND transaction_row.quantity_delta < 0)
      )
      AND (
        p_source = 'all'
        OR public.inventory_transaction_movement_source(
          transaction_row.transaction_type,
          transaction_row.reference_type
        ) = p_source
      )
      AND (
        p_snapshot = 'all'
        OR (p_snapshot = 'recorded'
          AND transaction_row.previous_quantity IS NOT NULL
          AND transaction_row.new_quantity IS NOT NULL)
        OR (p_snapshot = 'not-recorded'
          AND (transaction_row.previous_quantity IS NULL OR transaction_row.new_quantity IS NULL))
      )
  ), grouped AS MATERIALIZED (
    SELECT
      filtered.product_id,
      COALESCE(SUM(GREATEST(filtered.quantity_delta, 0)), 0) AS incoming,
      COALESCE(SUM(ABS(LEAST(filtered.quantity_delta, 0))), 0) AS outgoing
    FROM filtered
    GROUP BY filtered.product_id
  ), page_rows AS (
    SELECT
      grouped.product_id,
      product.name AS product_name,
      product.sku,
      product.unit,
      grouped.incoming,
      grouped.outgoing,
      grouped.incoming - grouped.outgoing AS balance
    FROM grouped
    LEFT JOIN public.products AS product
      ON product.id = grouped.product_id
      AND product.workspace_id = p_workspace_id
    ORDER BY grouped.product_id ASC
    OFFSET GREATEST(p_page - 1, 0) * GREATEST(p_page_size, 1)
    LIMIT GREATEST(p_page_size, 1)
  )
  SELECT pg_catalog.jsonb_build_object(
    'rows', COALESCE(
      (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page_rows) ORDER BY product_id ASC)
       FROM page_rows),
      '[]'::jsonb
    ),
    'total_count', (SELECT pg_catalog.count(*) FROM grouped)
  )
$function$;

REVOKE ALL ON FUNCTION public.inventory_transaction_movement_source(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_transaction_movement_source(text, text)
  TO authenticated;
REVOKE ALL ON FUNCTION public.get_inventory_transactions_list_page(
  uuid, integer, integer, timestamptz, timestamptz, uuid, text, text, uuid, uuid[], text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_inventory_transaction_product_summary_page(
  uuid, integer, integer, timestamptz, timestamptz, uuid, text, text, uuid, uuid[], text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_inventory_transactions_list_page(
  uuid, integer, integer, timestamptz, timestamptz, uuid, text, text, uuid, uuid[], text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_inventory_transaction_product_summary_page(
  uuid, integer, integer, timestamptz, timestamptz, uuid, text, text, uuid, uuid[], text
) TO authenticated;

NOTIFY pgrst, 'reload schema';
