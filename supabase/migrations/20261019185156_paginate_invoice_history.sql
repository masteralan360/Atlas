-- Stable, workspace-scoped ordering for invoice history pages.
CREATE INDEX IF NOT EXISTS idx_invoices_workspace_created_id_active
  ON public.invoices (workspace_id, created_at DESC, id DESC)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_invoices_workspace_origin_created_id_active
  ON public.invoices (workspace_id, origin, created_at DESC, id DESC)
  WHERE is_deleted = false;

CREATE OR REPLACE FUNCTION public.get_invoice_history_page(
  p_workspace_id uuid,
  p_created_from timestamptz DEFAULT NULL,
  p_created_to timestamptz DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20,
  p_sort_direction text DEFAULT 'desc',
  p_origin text DEFAULT 'history'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_search text := lower(btrim(COALESCE(p_search, '')));
  v_page integer := LEAST(GREATEST(COALESCE(p_page, 1), 1), 100000);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100);
  v_offset bigint;
  v_sort_ascending boolean := lower(COALESCE(p_sort_direction, 'desc')) = 'asc';
  v_total_count bigint;
  v_min_created_at timestamptz;
  v_max_created_at timestamptz;
  v_invoices jsonb;
BEGIN
  v_offset := (v_page - 1)::bigint * v_page_size;

  SELECT count(*), min(invoice.created_at), max(invoice.created_at)
  INTO v_total_count, v_min_created_at, v_max_created_at
  FROM public.invoices AS invoice
  WHERE invoice.workspace_id = p_workspace_id
    AND invoice.is_deleted = false
    AND (
      (lower(COALESCE(p_origin, 'history')) = 'upload' AND invoice.origin = 'upload')
      OR (lower(COALESCE(p_origin, 'history')) <> 'upload' AND invoice.origin IS DISTINCT FROM 'upload')
    )
    AND (p_created_from IS NULL OR invoice.created_at >= p_created_from)
    AND (p_created_to IS NULL OR invoice.created_at < p_created_to)
    AND (
      v_search = ''
      OR strpos(
        lower(concat_ws(
          ' ',
          invoice.invoiceid,
          invoice.source_id::text,
          invoice.origin,
          invoice.created_by_name
        )),
        v_search
      ) > 0
    );

  IF v_sort_ascending THEN
    SELECT COALESCE(
      jsonb_agg(to_jsonb(page_rows) ORDER BY page_rows.created_at ASC, page_rows.id ASC),
      '[]'::jsonb
    )
    INTO v_invoices
    FROM (
      SELECT
        invoice.id,
        invoice.user_id,
        invoice.invoiceid,
        invoice.order_id,
        invoice.total,
        invoice.created_at,
        invoice.updated_at,
        invoice.version,
        invoice.is_deleted,
        invoice.workspace_id,
        invoice.is_snapshot,
        invoice.origin,
        invoice.created_by,
        invoice.created_by_name,
        invoice.cashier_name,
        invoice.sequence_id,
        invoice.print_format,
        invoice.total_amount,
        invoice.settlement_currency,
        invoice.r2_path_a4,
        invoice.r2_path_receipt,
        invoice.file_size,
        invoice.file_mime_type,
        invoice.source_id,
        invoice.latest_version_id,
        invoice.latest_version_number
      FROM public.invoices AS invoice
      WHERE invoice.workspace_id = p_workspace_id
        AND invoice.is_deleted = false
        AND (
          (lower(COALESCE(p_origin, 'history')) = 'upload' AND invoice.origin = 'upload')
          OR (lower(COALESCE(p_origin, 'history')) <> 'upload' AND invoice.origin IS DISTINCT FROM 'upload')
        )
        AND (p_created_from IS NULL OR invoice.created_at >= p_created_from)
        AND (p_created_to IS NULL OR invoice.created_at < p_created_to)
        AND (
          v_search = ''
          OR strpos(
            lower(concat_ws(
              ' ',
              invoice.invoiceid,
              invoice.source_id::text,
              invoice.origin,
              invoice.created_by_name
            )),
            v_search
          ) > 0
        )
      ORDER BY invoice.created_at ASC, invoice.id ASC
      LIMIT v_page_size OFFSET v_offset
    ) AS page_rows;
  ELSE
    SELECT COALESCE(
      jsonb_agg(to_jsonb(page_rows) ORDER BY page_rows.created_at DESC, page_rows.id DESC),
      '[]'::jsonb
    )
    INTO v_invoices
    FROM (
      SELECT
        invoice.id,
        invoice.user_id,
        invoice.invoiceid,
        invoice.order_id,
        invoice.total,
        invoice.created_at,
        invoice.updated_at,
        invoice.version,
        invoice.is_deleted,
        invoice.workspace_id,
        invoice.is_snapshot,
        invoice.origin,
        invoice.created_by,
        invoice.created_by_name,
        invoice.cashier_name,
        invoice.sequence_id,
        invoice.print_format,
        invoice.total_amount,
        invoice.settlement_currency,
        invoice.r2_path_a4,
        invoice.r2_path_receipt,
        invoice.file_size,
        invoice.file_mime_type,
        invoice.source_id,
        invoice.latest_version_id,
        invoice.latest_version_number
      FROM public.invoices AS invoice
      WHERE invoice.workspace_id = p_workspace_id
        AND invoice.is_deleted = false
        AND (
          (lower(COALESCE(p_origin, 'history')) = 'upload' AND invoice.origin = 'upload')
          OR (lower(COALESCE(p_origin, 'history')) <> 'upload' AND invoice.origin IS DISTINCT FROM 'upload')
        )
        AND (p_created_from IS NULL OR invoice.created_at >= p_created_from)
        AND (p_created_to IS NULL OR invoice.created_at < p_created_to)
        AND (
          v_search = ''
          OR strpos(
            lower(concat_ws(
              ' ',
              invoice.invoiceid,
              invoice.source_id::text,
              invoice.origin,
              invoice.created_by_name
            )),
            v_search
          ) > 0
        )
      ORDER BY invoice.created_at DESC, invoice.id DESC
      LIMIT v_page_size OFFSET v_offset
    ) AS page_rows;
  END IF;

  RETURN jsonb_build_object(
    'invoices', COALESCE(v_invoices, '[]'::jsonb),
    'total_count', COALESCE(v_total_count, 0),
    'min_created_at', v_min_created_at,
    'max_created_at', v_max_created_at,
    'total_upload_count', (
      SELECT count(*)
      FROM public.invoices AS upload
      WHERE upload.workspace_id = p_workspace_id
        AND upload.is_deleted = false
        AND upload.origin = 'upload'
    ),
    'total_upload_size', (
      SELECT COALESCE(sum(upload.file_size), 0)
      FROM public.invoices AS upload
      WHERE upload.workspace_id = p_workspace_id
        AND upload.is_deleted = false
        AND upload.origin = 'upload'
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_invoice_history_page(uuid, timestamptz, timestamptz, text, integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invoice_history_page(uuid, timestamptz, timestamptz, text, integer, integer, text, text)
  TO authenticated, service_role;
