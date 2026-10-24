-- Give each workspace a stable, user-facing shipment number while retaining
-- the UUID primary key for internal relationships and commands.
CREATE TABLE IF NOT EXISTS postal_private.shipment_counters (
  workspace_id uuid PRIMARY KEY,
  last_value bigint NOT NULL CHECK (last_value >= 0)
);
ALTER TABLE postal_private.shipment_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON postal_private.shipment_counters FROM PUBLIC, anon, authenticated;

ALTER TABLE public.postal_shipments
  ADD COLUMN IF NOT EXISTS shipment_number bigint;

WITH numbered AS (
  SELECT id,
    row_number() OVER (PARTITION BY workspace_id ORDER BY created_at, id)::bigint AS number
  FROM public.postal_shipments
  WHERE shipment_number IS NULL
)
UPDATE public.postal_shipments AS shipment
SET shipment_number = numbered.number
FROM numbered
WHERE shipment.id = numbered.id;

ALTER TABLE public.postal_shipments
  ALTER COLUMN shipment_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS postal_shipments_workspace_number
  ON public.postal_shipments (workspace_id, shipment_number);

INSERT INTO postal_private.shipment_counters (workspace_id, last_value)
SELECT workspace_id, max(shipment_number)
FROM public.postal_shipments
GROUP BY workspace_id
ON CONFLICT (workspace_id) DO UPDATE
SET last_value = greatest(
  postal_private.shipment_counters.last_value,
  EXCLUDED.last_value
);

-- Existing Post Service payment records are immutable through normal writes;
-- temporarily replace the integrity trigger inside this migration transaction
-- so their display reference can be upgraded atomically with the shipment IDs.
DROP TRIGGER IF EXISTS postal_payment_integrity ON public.payment_transactions;
UPDATE public.payment_transactions AS payment
SET reference_label = shipment.shipment_number::text,
    metadata = COALESCE(payment.metadata, '{}'::jsonb)
      || jsonb_build_object('shipmentNumber', shipment.shipment_number)
FROM public.postal_shipments AS shipment
WHERE payment.source_module = 'postal_service'
  AND payment.source_type IN ('postal_cod', 'postal_settlement')
  AND payment.workspace_id = shipment.workspace_id
  AND payment.source_record_id = shipment.id;
CREATE TRIGGER postal_payment_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION postal_private.protect_payment();

CREATE FUNCTION postal_private.assign_shipment_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' AS $$
BEGIN
  IF NEW.shipment_number IS NOT NULL THEN
    RAISE EXCEPTION 'postal_shipment_number_managed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO postal_private.shipment_counters (workspace_id, last_value)
  VALUES (NEW.workspace_id, 1)
  ON CONFLICT (workspace_id) DO UPDATE
  SET last_value = postal_private.shipment_counters.last_value + 1
  RETURNING last_value INTO NEW.shipment_number;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION postal_private.assign_shipment_number() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER postal_assign_shipment_number
  BEFORE INSERT ON public.postal_shipments
  FOR EACH ROW EXECUTE FUNCTION postal_private.assign_shipment_number();

-- Shipment numbers are identities too and cannot change after creation.
CREATE OR REPLACE FUNCTION postal_private.protect_shipment_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
BEGIN
  IF ROW(NEW.id, NEW.qr_id, NEW.workspace_id, NEW.organization_id,
         NEW.created_by, NEW.created_at, NEW.shipment_number)
    IS DISTINCT FROM
     ROW(OLD.id, OLD.qr_id, OLD.workspace_id, OLD.organization_id,
         OLD.created_by, OLD.created_at, OLD.shipment_number)
  THEN
    RAISE EXCEPTION 'postal_identity_is_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- Payment rows keep a friendly reference and the user-facing shipment number
-- in metadata; source_record_id remains the internal shipment UUID.
CREATE FUNCTION postal_private.attach_shipment_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' AS $$
DECLARE v_shipment_number bigint;
BEGIN
  IF NEW.source_module = 'postal_service'
     AND NEW.source_type IN ('postal_cod', 'postal_settlement')
     AND NEW.source_record_id IS NOT NULL THEN
    SELECT shipment_number INTO v_shipment_number
    FROM public.postal_shipments
    WHERE workspace_id = NEW.workspace_id AND id = NEW.source_record_id;
    IF v_shipment_number IS NULL THEN
      RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
    END IF;
    NEW.reference_label := v_shipment_number::text;
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object('shipmentNumber', v_shipment_number);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION postal_private.attach_shipment_reference() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER postal_attach_shipment_reference
  BEFORE INSERT ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION postal_private.attach_shipment_reference();

-- Numeric search follows the same filters used by the shipment list and its
-- summary, including Arabic and Kurdish localized numerals normalized by the UI.
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
      AND (v_search = '' OR s.recipient_name ILIKE '%' || v_search || '%'
        OR s.primary_phone ILIKE '%' || v_search || '%'
        OR (v_search ~ '^[0-9]+$' AND s.shipment_number::text = v_search))
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
