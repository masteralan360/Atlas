-- A single scoped query powers the Post Service COD activity view. Totals use
-- the date/search scope, while the event selector only narrows the page rows.
CREATE FUNCTION public.postal_cod_activity_page(
  p_workspace_id uuid,
  p_page integer,
  p_page_size integer,
  p_search text DEFAULT '',
  p_kind text DEFAULT 'all',
  p_start timestamptz DEFAULT NULL,
  p_end timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_role text := postal_private.access_role(p_workspace_id);
  v_search text := replace(replace(btrim(COALESCE(p_search, '')), '%', ''), '_', '');
  v_kind text := COALESCE(p_kind, 'all');
  v_result jsonb;
BEGIN
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_page IS NULL OR p_page < 1 OR p_page > 1000000
    OR p_page_size IS NULL OR p_page_size NOT IN (20, 50, 100)
    OR v_kind NOT IN ('all', 'collection', 'settlement')
    OR (p_start IS NOT NULL AND p_end IS NOT NULL AND p_start >= p_end) THEN
    RAISE EXCEPTION 'postal_invalid_filter' USING ERRCODE = '22023';
  END IF;

  WITH matched AS MATERIALIZED (
    SELECT
      c.id,
      c.shipment_id,
      c.organization_id,
      c.kind,
      c.signed_amount,
      c.payment_transaction_id,
      c.actor_id,
      c.notes,
      c.created_at,
      jsonb_build_object(
        'shipment_number', s.shipment_number,
        'created_at', s.created_at,
        'recipient_name', s.recipient_name,
        'primary_phone', s.primary_phone
      ) AS postal_shipments,
      o.name AS organization_name,
      pt.direction AS payment_direction,
      pt.payment_method,
      pt.account_name_snapshot,
      pt.reference_label
    FROM public.postal_cod_records c
    JOIN public.postal_shipments s
      ON s.workspace_id = c.workspace_id AND s.id = c.shipment_id
    JOIN public.postal_organizations o
      ON o.workspace_id = c.workspace_id AND o.id = c.organization_id
    LEFT JOIN public.payment_transactions pt
      ON pt.workspace_id = c.workspace_id AND pt.id = c.payment_transaction_id
    WHERE c.workspace_id = p_workspace_id
      AND s.deleted_at IS NULL
      AND (p_start IS NULL OR c.created_at >= p_start)
      AND (p_end IS NULL OR c.created_at < p_end)
      AND (
        v_search = ''
        OR s.recipient_name ILIKE '%' || v_search || '%'
        OR s.primary_phone ILIKE '%' || v_search || '%'
        OR o.name ILIKE '%' || v_search || '%'
        OR (
          ('PS-' || EXTRACT(YEAR FROM s.created_at AT TIME ZONE 'UTC')::integer::text
            || '-' || lpad(s.shipment_number::text, 6, '0'))
          ILIKE '%' || v_search || '%'
        )
        OR s.shipment_number::text ILIKE '%' || v_search || '%'
        OR (
          v_search ~* '^PS-[0-9]{4}-[0-9]{6,}$'
          AND EXTRACT(YEAR FROM s.created_at AT TIME ZONE 'UTC')::integer = substring(upper(v_search) FROM '^PS-([0-9]{4})-')::integer
          AND s.shipment_number::text = NULLIF(ltrim(substring(upper(v_search) FROM '^PS-[0-9]{4}-([0-9]{6,})$'), '0'), '')
        )
        OR (
          v_search ~ '^[0-9]+$'
          AND s.shipment_number::text = NULLIF(ltrim(v_search, '0'), '')
        )
      )
  ), filtered AS MATERIALIZED (
    SELECT * FROM matched WHERE v_kind = 'all' OR kind = v_kind
  ), totals AS (
    SELECT
      COALESCE(sum(signed_amount) FILTER (WHERE kind = 'collection'), 0) AS collections,
      COALESCE(sum(signed_amount) FILTER (WHERE kind = 'settlement'), 0) AS settlements
    FROM matched
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(page_row) ORDER BY page_row.created_at DESC, page_row.id DESC)
      FROM (
        SELECT *
        FROM filtered
        ORDER BY created_at DESC, id DESC
        OFFSET ((p_page - 1) * p_page_size)
        LIMIT p_page_size
      ) page_row
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'summary', jsonb_build_object(
      'collection_total', (SELECT collections::text FROM totals),
      'settlement_total', (SELECT settlements::text FROM totals),
      'net_total', (SELECT (collections - settlements)::text FROM totals)
    )
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.postal_cod_activity_page(uuid,integer,integer,text,text,timestamptz,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_cod_activity_page(uuid,integer,integer,text,text,timestamptz,timestamptz)
  TO authenticated, service_role;
