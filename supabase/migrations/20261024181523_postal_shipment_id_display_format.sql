-- Present the immutable workspace shipment number with its UTC creation year.
-- The underlying sequence and UUID relations remain unchanged.
DROP TRIGGER IF EXISTS postal_payment_integrity ON public.payment_transactions;

UPDATE public.payment_transactions AS payment
SET reference_label = 'PS-' || to_char(shipment.created_at AT TIME ZONE 'UTC', 'YYYY')
      || '-' || lpad(shipment.shipment_number::text, 6, '0'),
    metadata = COALESCE(payment.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'shipmentNumber', shipment.shipment_number,
        'shipmentReference', 'PS-' || to_char(shipment.created_at AT TIME ZONE 'UTC', 'YYYY')
          || '-' || lpad(shipment.shipment_number::text, 6, '0'),
        'shipmentYear', to_char(shipment.created_at AT TIME ZONE 'UTC', 'YYYY')
      )
FROM public.postal_shipments AS shipment
WHERE payment.source_module = 'postal_service'
  AND payment.source_type IN ('postal_cod', 'postal_settlement')
  AND payment.workspace_id = shipment.workspace_id
  AND payment.source_record_id = shipment.id;

CREATE TRIGGER postal_payment_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION postal_private.protect_payment();

CREATE OR REPLACE FUNCTION postal_private.attach_shipment_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
  v_shipment_number bigint;
  v_shipment_created_at timestamptz;
  v_shipment_year text;
  v_shipment_reference text;
BEGIN
  IF NEW.source_module = 'postal_service'
     AND NEW.source_type IN ('postal_cod', 'postal_settlement')
     AND NEW.source_record_id IS NOT NULL THEN
    SELECT shipment_number, created_at
      INTO v_shipment_number, v_shipment_created_at
    FROM public.postal_shipments
    WHERE workspace_id = NEW.workspace_id AND id = NEW.source_record_id;
    IF v_shipment_number IS NULL OR v_shipment_created_at IS NULL THEN
      RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
    END IF;
    v_shipment_year := to_char(v_shipment_created_at AT TIME ZONE 'UTC', 'YYYY');
    v_shipment_reference := 'PS-' || v_shipment_year || '-'
      || lpad(v_shipment_number::text, 6, '0');
    NEW.reference_label := v_shipment_reference;
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'shipmentNumber', v_shipment_number,
        'shipmentReference', v_shipment_reference,
        'shipmentYear', v_shipment_year
      );
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION postal_private.attach_shipment_reference() FROM PUBLIC, anon, authenticated;

-- Match shipment-list searches for either the raw sequence or formatted ID.
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
  )
  SELECT jsonb_build_object(
    'total_shipments', count(*),
    'active_shipments', count(*) FILTER (WHERE state NOT IN ('delivered','cancelled')),
    'delivered_shipments', count(*) FILTER (WHERE state = 'delivered'),
    'in_transit_shipments', count(*) FILTER (WHERE state = 'in_transit'),
    'cod_balance', (SELECT COALESCE(sum(amount), 0)::text FROM pending),
    'collection_records', (SELECT COALESCE(sum(collection_records), 0) FROM pending)
  ) INTO v_result FROM filtered;
  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION postal_private.dashboard_summary(uuid,text,text,timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION postal_private.dashboard_summary(uuid,text,text,timestamptz,timestamptz)
  TO authenticated, service_role;
