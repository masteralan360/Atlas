-- Add the current amount owed to merchants to the shipment dashboard. The
-- amount follows the dashboard's shipment filters and nets records per
-- shipment so one merchant's credit cannot offset another shipment's debt.
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
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF v_status NOT IN ('all','draft','received','in_transit','arrived','out_for_delivery','delivered','cancelled')
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
    WHERE s.workspace_id = p_workspace_id AND s.deleted_at IS NULL
      AND (v_organization IS NULL OR s.organization_id = v_organization)
      AND (v_status = 'all' OR s.state = v_status)
      AND (p_start IS NULL OR s.created_at >= p_start)
      AND (p_end IS NULL OR s.created_at < p_end)
      AND (
        v_search = ''
        OR s.recipient_name ILIKE '%' || v_search || '%'
        OR s.primary_phone ILIKE '%' || v_search || '%'
        OR (v_search ~ '^[0-9]+$' AND s.shipment_number::text = v_search)
        OR (
          v_search ~* '^PS-[0-9]{4}-[0-9]{6,}$'
          AND s.shipment_number::text = COALESCE(
            NULLIF(ltrim(split_part(v_search, '-', 3), '0'), ''), '0'
          )
          AND to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY') = split_part(v_search, '-', 2)
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
    -- Text preserves exact IQD totals beyond JavaScript's safe integer range.
    'cod_balance', (SELECT COALESCE(sum(amount), 0)::text FROM pending),
    'remaining_merchant_settlements',
      (SELECT COALESCE(sum(remaining), 0)::text FROM merchant_balances),
    'collection_records', (SELECT COALESCE(sum(collection_records), 0) FROM pending)
  ) INTO v_result FROM filtered;
  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION postal_private.dashboard_summary(uuid,text,text,timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION postal_private.dashboard_summary(uuid,text,text,timestamptz,timestamptz)
  TO authenticated, service_role;
