CREATE FUNCTION public.postal_shipment_page(
  p_workspace_id uuid,
  p_page integer,
  p_page_size integer,
  p_search text DEFAULT '',
  p_status text DEFAULT 'all',
  p_start timestamptz DEFAULT NULL,
  p_end timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_role text := postal_private.access_role(p_workspace_id);
  v_search text := replace(replace(btrim(COALESCE(p_search, '')), '%', ''), '_', '');
  v_status text := COALESCE(p_status, 'all');
  v_is_shipment_id boolean := v_search ~* '^PS-[0-9]{4}-[0-9]{6,}$'
    AND split_part(upper(v_search), '-', 2) <> '0000'
    AND NULLIF(ltrim(split_part(upper(v_search), '-', 3), '0'), '') IS NOT NULL;
  v_result jsonb;
BEGIN
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_page IS NULL OR p_page < 1 OR p_page > 1000000
    OR p_page_size IS NULL OR p_page_size NOT IN (20, 50, 100)
    OR v_status NOT IN ('all','draft','received','in_transit','arrived','out_for_delivery','postponed','delivered','cancelled')
    OR (p_start IS NOT NULL AND p_end IS NOT NULL AND p_start >= p_end) THEN
    RAISE EXCEPTION 'postal_invalid_filter' USING ERRCODE = '22023';
  END IF;

  WITH matched AS MATERIALIZED (
    SELECT
      s.*,
      CASE WHEN v_role = 'admin' THEN o.name ELSE NULL END AS organization_name
    FROM public.postal_shipments s
    LEFT JOIN public.postal_organizations o
      ON o.workspace_id = s.workspace_id AND o.id = s.organization_id
    WHERE s.workspace_id = p_workspace_id
      AND s.deleted_at IS NULL
      AND (v_status = 'all' OR s.state = v_status)
      AND (p_start IS NULL OR s.created_at >= p_start)
      AND (p_end IS NULL OR s.created_at < p_end)
      AND (
        v_search = ''
        OR (
          v_is_shipment_id
          AND s.shipment_number::text = COALESCE(
            NULLIF(ltrim(split_part(upper(v_search), '-', 3), '0'), ''), '0'
          )
          AND to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY') = split_part(upper(v_search), '-', 2)
        )
        OR (
          NOT v_is_shipment_id
          AND (
            s.recipient_name ILIKE '%' || v_search || '%'
            OR s.primary_phone ILIKE '%' || v_search || '%'
            OR o.name ILIKE '%' || v_search || '%'
            OR (
              v_search ~ '^[0-9]+$'
              AND s.shipment_number::text = COALESCE(NULLIF(ltrim(v_search, '0'), ''), '0')
            )
          )
        )
      )
  ), page_rows AS MATERIALIZED (
    SELECT * FROM matched
    ORDER BY created_at DESC, id DESC
    OFFSET ((p_page - 1) * p_page_size)
    LIMIT p_page_size
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(page_rows) ORDER BY page_rows.created_at DESC, page_rows.id DESC)
      FROM page_rows
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM matched)
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.postal_shipment_page(uuid,integer,integer,text,text,timestamptz,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_shipment_page(uuid,integer,integer,text,text,timestamptz,timestamptz)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION postal_private.dashboard_summary(
  p_workspace_id uuid,
  p_search text DEFAULT '',
  p_status text DEFAULT 'all',
  p_start timestamptz DEFAULT NULL,
  p_end timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text := postal_private.access_role(p_workspace_id);
  v_organization uuid;
  v_search text := translate(btrim(COALESCE(p_search, '')), '%_,().' || chr(92), '');
  v_status text := COALESCE(p_status, 'all');
  v_is_shipment_id boolean := v_search ~* '^PS-[0-9]{4}-[0-9]{6,}$'
    AND split_part(upper(v_search), '-', 2) <> '0000'
    AND NULLIF(ltrim(split_part(upper(v_search), '-', 3), '0'), '') IS NOT NULL;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF v_status NOT IN ('all','draft','received','in_transit','arrived','out_for_delivery','postponed','delivered','cancelled')
    OR (p_start IS NOT NULL AND p_end IS NOT NULL AND p_start >= p_end) THEN
    RAISE EXCEPTION 'postal_invalid_filter' USING ERRCODE = '22023';
  END IF;
  IF v_role = 'merchant' THEN
    SELECT m.organization_id INTO v_organization
    FROM public.postal_memberships m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = v_actor;
    IF v_organization IS NULL THEN
      RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH filtered AS MATERIALIZED (
    SELECT s.id, s.state, s.cod_amount
    FROM public.postal_shipments s
    JOIN public.postal_organizations o
      ON o.workspace_id = s.workspace_id AND o.id = s.organization_id
    WHERE s.workspace_id = p_workspace_id AND s.deleted_at IS NULL
      AND (v_organization IS NULL OR s.organization_id = v_organization)
      AND (v_status = 'all' OR s.state = v_status)
      AND (p_start IS NULL OR s.created_at >= p_start)
      AND (p_end IS NULL OR s.created_at < p_end)
      AND (
        v_search = ''
        OR (
          v_is_shipment_id
          AND s.shipment_number::text = COALESCE(
            NULLIF(ltrim(split_part(v_search, '-', 3), '0'), ''), '0'
          )
          AND to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY') = split_part(upper(v_search), '-', 2)
        )
        OR (
          NOT v_is_shipment_id
          AND (
            s.recipient_name ILIKE '%' || v_search || '%'
            OR s.primary_phone ILIKE '%' || v_search || '%'
            OR o.name ILIKE '%' || v_search || '%'
            OR (
              v_search ~ '^[0-9]+$'
              AND s.shipment_number::text = COALESCE(NULLIF(ltrim(v_search, '0'), ''), '0')
            )
          )
        )
      )
  ), pending AS (
    SELECT s.id, s.cod_amount - COALESCE(sum(c.signed_amount), 0) AS amount,
      count(c.id) AS collection_records
    FROM filtered s LEFT JOIN public.postal_cod_records c
      ON c.workspace_id = p_workspace_id AND c.shipment_id = s.id AND c.kind = 'collection'
    WHERE s.state = 'delivered'
    GROUP BY s.id, s.cod_amount
  ), merchant_balances AS (
    SELECT s.id,
      greatest(
        COALESCE(sum(c.signed_amount::numeric) FILTER (WHERE c.kind = 'collection'), 0)
        - COALESCE(sum(c.signed_amount::numeric) FILTER (WHERE c.kind = 'settlement'), 0),
        0
      ) AS remaining
    FROM filtered s LEFT JOIN public.postal_cod_records c
      ON c.workspace_id = p_workspace_id AND c.shipment_id = s.id
    GROUP BY s.id
  )
  SELECT jsonb_build_object(
    'total_shipments', count(*),
    'active_shipments', count(*) FILTER (WHERE state NOT IN ('delivered','cancelled')),
    'delivered_shipments', count(*) FILTER (WHERE state = 'delivered'),
    'in_transit_shipments', count(*) FILTER (WHERE state = 'in_transit'),
    'cod_balance', (SELECT COALESCE(sum(amount), 0)::text FROM pending),
    'remaining_merchant_settlements',
      (SELECT COALESCE(sum(remaining), 0)::text FROM merchant_balances),
    'collection_records', (SELECT COALESCE(sum(collection_records), 0) FROM pending)
  ) INTO v_result FROM filtered;
  RETURN v_result;
END
$$;
