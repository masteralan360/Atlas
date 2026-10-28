-- Read-only organization statements. Public wrappers remain invokers so the
-- existing workspace/module/organization RLS policies apply to every source.
CREATE FUNCTION public.postal_statement_organizations(p_workspace_id uuid, p_search text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_role text := postal_private.access_role(p_workspace_id);
  v_search text := replace(replace(replace(btrim(COALESCE(p_search, '')), '\', ''), '%', ''), '_', '');
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'office') THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF length(v_search) < 3 THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.name, o.id), '[]'::jsonb)
    FROM (
      SELECT id, workspace_id, name, code, leader_id
      FROM public.postal_organizations
      WHERE workspace_id = p_workspace_id
        AND (name ILIKE '%' || v_search || '%' OR code ILIKE '%' || v_search || '%')
      ORDER BY name, id LIMIT 8
    ) o
  );
END $$;

CREATE FUNCTION public.postal_organization_statement(
  p_workspace_id uuid,
  p_organization_id uuid,
  p_page integer,
  p_page_size integer,
  p_start timestamptz DEFAULT NULL,
  p_end timestamptz DEFAULT NULL,
  p_search text DEFAULT '',
  p_kind text DEFAULT 'all'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_role text := postal_private.access_role(p_workspace_id);
  v_search text := replace(replace(replace(btrim(COALESCE(p_search, '')), '\', ''), '%', ''), '_', '');
  v_organization jsonb;
  v_result jsonb;
BEGIN
  -- Do not treat a NULL authorization result as an allowed role.
  IF v_role IS NULL OR v_role NOT IN ('admin', 'office') THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_page IS NULL OR p_page < 1 OR p_page > 1000000
    OR p_page_size IS NULL OR p_page_size NOT IN (20, 50, 100)
    OR p_kind IS NULL OR p_kind NOT IN ('all', 'collection', 'settlement', 'delivery_fee')
    OR (p_start IS NOT NULL AND p_end IS NOT NULL AND p_start >= p_end) THEN
    RAISE EXCEPTION 'postal_invalid_filter' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object('id', id, 'workspace_id', workspace_id,
    'name', name, 'code', code, 'leader_id', leader_id)
  INTO v_organization FROM public.postal_organizations
  WHERE workspace_id = p_workspace_id AND id = p_organization_id;
  IF v_organization IS NULL THEN
    RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
  END IF;

  WITH movements AS MATERIALIZED (
    SELECT c.id, c.shipment_id, c.kind, c.signed_amount::numeric AS amount,
      CASE WHEN c.kind = 'collection' THEN c.signed_amount::numeric
        ELSE -c.signed_amount::numeric END AS delta,
      c.payment_transaction_id, c.created_at, c.notes
    FROM public.postal_cod_records c
    WHERE c.workspace_id = p_workspace_id AND c.organization_id = p_organization_id
    UNION ALL
    -- Recipient delivery fees are service cash, never organization COD funds.
    SELECT f.id, f.shipment_id, 'delivery_fee', f.signed_amount::numeric, 0::numeric,
      f.payment_transaction_id, f.created_at, f.notes
    FROM public.postal_delivery_fee_records f
    WHERE f.workspace_id = p_workspace_id AND f.organization_id = p_organization_id
  ), ordered AS MATERIALIZED (
    SELECT m.*, sum(delta) OVER (ORDER BY created_at, id, kind
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
    FROM movements m WHERE p_end IS NULL OR m.created_at < p_end
  ), period AS MATERIALIZED (
    SELECT * FROM ordered WHERE p_start IS NULL OR created_at >= p_start
  ), totals AS (
    SELECT COALESCE(sum(greatest(-delta, 0)), 0) AS debit,
      COALESCE(sum(greatest(delta, 0)), 0) AS credit,
      COALESCE(sum(amount) FILTER (WHERE kind = 'collection'), 0) AS collections,
      COALESCE(sum(amount) FILTER (WHERE kind = 'settlement'), 0) AS settlements,
      COALESCE(sum(amount) FILTER (WHERE kind = 'delivery_fee'), 0) AS delivery_fees
    FROM period
  ), filtered AS MATERIALIZED (
    SELECT p.* FROM period p
    JOIN public.postal_shipments s ON s.workspace_id = p_workspace_id AND s.id = p.shipment_id
    WHERE (p_kind = 'all' OR p.kind = p_kind)
      AND (v_search = '' OR s.recipient_name ILIKE '%' || v_search || '%'
        OR s.primary_phone ILIKE '%' || v_search || '%'
        OR p.payment_transaction_id::text ILIKE '%' || v_search || '%'
        OR p.notes ILIKE '%' || v_search || '%'
        OR ('PS-' || EXTRACT(YEAR FROM s.created_at AT TIME ZONE 'UTC')::integer::text
          || '-' || lpad(s.shipment_number::text, greatest(6, length(s.shipment_number::text)), '0'))
          ILIKE '%' || v_search || '%')
  ), page AS MATERIALIZED (
    SELECT * FROM filtered ORDER BY created_at, id, kind
    OFFSET ((p_page - 1) * p_page_size) LIMIT p_page_size
  ), current_cod AS (
    SELECT shipment_id, sum(amount) FILTER (WHERE kind = 'collection') AS collected,
      sum(delta) AS balance
    FROM movements WHERE kind <> 'delivery_fee' GROUP BY shipment_id
  ), outstanding AS (
    -- These are current operational figures, independent of the statement period.
    SELECT COALESCE(sum(greatest(s.cod_amount::numeric - COALESCE(c.collected, 0), 0)), 0) AS recipient_due,
      COALESCE(sum(greatest(COALESCE(c.collected, 0) - s.cod_amount::numeric, 0)), 0) AS recipient_refund_due,
      count(*) FILTER (WHERE s.delivery_fee IS NULL) AS missing_tariffs
    FROM public.postal_shipments s LEFT JOIN current_cod c ON c.shipment_id = s.id
    WHERE s.workspace_id = p_workspace_id AND s.organization_id = p_organization_id
      AND s.state = 'delivered' AND s.deleted_at IS NULL
  )
  SELECT jsonb_build_object(
    'organization', v_organization,
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'kind', p.kind, 'created_at', p.created_at,
        'shipment_id', p.shipment_id, 'shipment_number', s.shipment_number,
        'shipment_created_at', s.created_at, 'recipient_name', s.recipient_name,
        'primary_phone', s.primary_phone, 'shipment_state', s.state,
        'signed_amount', p.amount::text, 'debit', greatest(-p.delta, 0)::text,
        'credit', greatest(p.delta, 0)::text, 'balance', p.balance::text,
        'payment_transaction_id', p.payment_transaction_id,
        'payment_direction', pt.direction, 'payment_method', pt.payment_method,
        'account_name_snapshot', pt.account_name_snapshot, 'notes', p.notes
      ) ORDER BY p.created_at, p.id, p.kind)
      FROM page p
      JOIN public.postal_shipments s ON s.workspace_id = p_workspace_id AND s.id = p.shipment_id
      LEFT JOIN public.payment_transactions pt
        ON pt.workspace_id = p_workspace_id AND pt.id = p.payment_transaction_id
    ), '[]'::jsonb),
    'total', (SELECT count(*) FROM filtered),
    'summary', jsonb_build_object(
      'opening_balance', COALESCE((SELECT sum(delta) FROM ordered WHERE created_at < p_start), 0)::text,
      'debit_total', (SELECT debit::text FROM totals),
      'credit_total', (SELECT credit::text FROM totals),
      'closing_balance', COALESCE((SELECT sum(delta) FROM ordered), 0)::text,
      'collections', (SELECT collections::text FROM totals),
      'settlements', (SELECT settlements::text FROM totals),
      'delivery_fees', (SELECT delivery_fees::text FROM totals),
      'current_due_to', COALESCE((SELECT sum(greatest(balance, 0)) FROM current_cod), 0)::text,
      'current_due_from', COALESCE((SELECT sum(greatest(-balance, 0)) FROM current_cod), 0)::text,
      'recipient_due', (SELECT recipient_due::text FROM outstanding),
      'recipient_refund_due', (SELECT recipient_refund_due::text FROM outstanding),
      'missing_tariffs', (SELECT missing_tariffs FROM outstanding)
    )
  ) INTO v_result;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.postal_statement_organizations(uuid,text),
  public.postal_organization_statement(uuid,uuid,integer,integer,timestamptz,timestamptz,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_statement_organizations(uuid,text),
  public.postal_organization_statement(uuid,uuid,integer,integer,timestamptz,timestamptz,text,text)
  TO authenticated, service_role;
