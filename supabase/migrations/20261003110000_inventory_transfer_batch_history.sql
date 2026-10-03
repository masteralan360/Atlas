CREATE OR REPLACE FUNCTION public.search_inventory_transfer_batches(
  p_workspace_id uuid,
  p_search text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_search text := NULLIF(pg_catalog.btrim(p_search), '');
  v_pattern text;
  v_page integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100);
  v_total_count bigint;
  v_rows jsonb;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Workspace is required' USING ERRCODE = '22023';
  END IF;

  IF v_search IS NOT NULL THEN
    v_pattern := '%' || pg_catalog.replace(
      pg_catalog.replace(pg_catalog.replace(v_search, '!', '!!'), '%', '!%'),
      '_', '!_'
    ) || '%';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_total_count
  FROM public.inventory_transfer_batches AS batch
  WHERE batch.workspace_id = p_workspace_id
    AND batch.is_deleted IS FALSE
    AND (p_from IS NULL OR batch.transferred_at >= p_from)
    AND (p_to IS NULL OR batch.transferred_at < p_to)
    AND (
      v_search IS NULL
      OR batch.transfer_number ILIKE v_pattern ESCAPE '!'
      OR COALESCE(batch.source_workspace_name, '') ILIKE v_pattern ESCAPE '!'
      OR COALESCE(batch.source_storage_name, '') ILIKE v_pattern ESCAPE '!'
      OR COALESCE(batch.destination_workspace_name, '') ILIKE v_pattern ESCAPE '!'
      OR COALESCE(batch.destination_storage_name, '') ILIKE v_pattern ESCAPE '!'
      OR COALESCE(batch.notes, '') ILIKE v_pattern ESCAPE '!'
      OR batch.performed_by::text ILIKE v_pattern ESCAPE '!'
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS actor
        WHERE actor.id = batch.performed_by
          AND COALESCE(actor.name, '') ILIKE v_pattern ESCAPE '!'
      )
      OR EXISTS (
        SELECT 1
        FROM public.inventory_transactions AS movement
        JOIN public.products AS product ON product.id = movement.product_id
        WHERE movement.transfer_batch_id = batch.id
          AND movement.transaction_type IN ('transfer_in', 'transfer_out')
          AND movement.is_deleted IS FALSE
          AND (
            product.name ILIKE v_pattern ESCAPE '!'
            OR product.sku ILIKE v_pattern ESCAPE '!'
            OR EXISTS (
              SELECT 1
              FROM public.product_barcodes AS barcode
              WHERE barcode.workspace_id = product.workspace_id
                AND barcode.product_id = product.id
                AND barcode.is_deleted IS FALSE
                AND barcode.barcode ILIKE v_pattern ESCAPE '!'
            )
          )
      )
    );

  SELECT COALESCE(pg_catalog.jsonb_agg(page_row.row_data ORDER BY page_row.transferred_at DESC, page_row.id DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      batch.transferred_at,
      batch.id,
      pg_catalog.jsonb_build_object(
        'batch', pg_catalog.to_jsonb(batch),
        'product_count', (
          SELECT pg_catalog.count(DISTINCT movement.product_id)
          FROM public.inventory_transactions AS movement
          WHERE movement.transfer_batch_id = batch.id
            AND movement.transaction_type IN ('transfer_in', 'transfer_out')
            AND movement.is_deleted IS FALSE
        ),
        'performed_by_name', actor.name,
        'source_is_branch', EXISTS (
          SELECT 1 FROM public.workspace_branches AS source_branch
          WHERE source_branch.branch_workspace_id = batch.source_workspace_id
        ),
        'destination_is_branch', EXISTS (
          SELECT 1 FROM public.workspace_branches AS destination_branch
          WHERE destination_branch.branch_workspace_id = batch.destination_workspace_id
        )
      ) AS row_data
    FROM public.inventory_transfer_batches AS batch
    LEFT JOIN public.profiles AS actor ON actor.id = batch.performed_by
    WHERE batch.workspace_id = p_workspace_id
      AND batch.is_deleted IS FALSE
      AND (p_from IS NULL OR batch.transferred_at >= p_from)
      AND (p_to IS NULL OR batch.transferred_at < p_to)
      AND (
        v_search IS NULL
        OR batch.transfer_number ILIKE v_pattern ESCAPE '!'
        OR COALESCE(batch.source_workspace_name, '') ILIKE v_pattern ESCAPE '!'
        OR COALESCE(batch.source_storage_name, '') ILIKE v_pattern ESCAPE '!'
        OR COALESCE(batch.destination_workspace_name, '') ILIKE v_pattern ESCAPE '!'
        OR COALESCE(batch.destination_storage_name, '') ILIKE v_pattern ESCAPE '!'
        OR COALESCE(batch.notes, '') ILIKE v_pattern ESCAPE '!'
        OR batch.performed_by::text ILIKE v_pattern ESCAPE '!'
        OR COALESCE(actor.name, '') ILIKE v_pattern ESCAPE '!'
        OR EXISTS (
          SELECT 1
          FROM public.inventory_transactions AS movement
          JOIN public.products AS product ON product.id = movement.product_id
          WHERE movement.transfer_batch_id = batch.id
            AND movement.transaction_type IN ('transfer_in', 'transfer_out')
            AND movement.is_deleted IS FALSE
            AND (
              product.name ILIKE v_pattern ESCAPE '!'
              OR product.sku ILIKE v_pattern ESCAPE '!'
              OR EXISTS (
                SELECT 1
                FROM public.product_barcodes AS barcode
                WHERE barcode.workspace_id = product.workspace_id
                  AND barcode.product_id = product.id
                  AND barcode.is_deleted IS FALSE
                  AND barcode.barcode ILIKE v_pattern ESCAPE '!'
              )
            )
        )
      )
    ORDER BY batch.transferred_at DESC, batch.id DESC
    LIMIT v_page_size
    OFFSET ((v_page - 1) * v_page_size)
  ) AS page_row;

  RETURN pg_catalog.jsonb_build_object(
    'rows', COALESCE(v_rows, '[]'::jsonb),
    'total_count', COALESCE(v_total_count, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.search_inventory_transfer_batches(uuid, text, timestamptz, timestamptz, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_inventory_transfer_batches(uuid, text, timestamptz, timestamptz, integer, integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_inventory_transfer_batch_details(
  p_workspace_id uuid,
  p_batch_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH selected_batch AS (
    SELECT batch.*
    FROM public.inventory_transfer_batches AS batch
    WHERE batch.workspace_id = p_workspace_id
      AND batch.id = p_batch_id
      AND batch.is_deleted IS FALSE
  ), product_lines AS (
    SELECT DISTINCT ON (movement.product_id)
      movement.id AS transaction_id,
      movement.product_id,
      COALESCE(product.name, '') AS product_name,
      COALESCE(product.sku, '') AS sku,
      pg_catalog.abs(movement.quantity_delta) AS quantity,
      COALESCE(product.unit, '') AS unit,
      COALESCE(activity.batch_allocations, '[]'::jsonb) AS batch_allocations,
      movement.created_at
    FROM selected_batch AS batch
    JOIN public.inventory_transactions AS movement
      ON movement.transfer_batch_id = batch.id
      AND movement.workspace_id = p_workspace_id
      AND movement.transaction_type IN ('transfer_in', 'transfer_out')
      AND movement.is_deleted IS FALSE
    LEFT JOIN public.products AS product ON product.id = movement.product_id
    LEFT JOIN LATERAL (
      SELECT transfer_activity.batch_allocations
      FROM public.inventory_transfer_transactions AS transfer_activity
      WHERE transfer_activity.workspace_id = movement.workspace_id
        AND transfer_activity.product_id = movement.product_id
        AND transfer_activity.created_at = movement.created_at
        AND transfer_activity.is_deleted IS FALSE
      ORDER BY transfer_activity.id
      LIMIT 1
    ) AS activity ON TRUE
    ORDER BY movement.product_id,
      CASE movement.transaction_type WHEN 'transfer_out' THEN 0 ELSE 1 END,
      movement.created_at,
      movement.id
  )
  SELECT CASE WHEN selected_batch.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
    'batch', pg_catalog.to_jsonb(selected_batch),
    'performed_by_name', actor.name,
    'source_is_branch', EXISTS (
      SELECT 1 FROM public.workspace_branches AS source_branch
      WHERE source_branch.branch_workspace_id = selected_batch.source_workspace_id
    ),
    'destination_is_branch', EXISTS (
      SELECT 1 FROM public.workspace_branches AS destination_branch
      WHERE destination_branch.branch_workspace_id = selected_batch.destination_workspace_id
    ),
    'products', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'transaction_id', product_lines.transaction_id,
        'product_id', product_lines.product_id,
        'product_name', product_lines.product_name,
        'sku', product_lines.sku,
        'quantity', product_lines.quantity,
        'unit', product_lines.unit,
        'batch_allocations', product_lines.batch_allocations
      ) ORDER BY product_lines.product_name, product_lines.sku, product_lines.product_id)
      FROM product_lines
    ), '[]'::jsonb)
  ) END
  FROM selected_batch
  LEFT JOIN public.profiles AS actor ON actor.id = selected_batch.performed_by;
$function$;

REVOKE ALL ON FUNCTION public.get_inventory_transfer_batch_details(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_transfer_batch_details(uuid, uuid) TO authenticated, service_role;
