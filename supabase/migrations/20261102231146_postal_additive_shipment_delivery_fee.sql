-- Keep the selected tariff and entered delivery-fee add-on separately while
-- retaining delivery_fee as the effective amount used by labels and collection.
ALTER TABLE public.postal_shipments
  ADD COLUMN delivery_fee_tariff bigint,
  ADD COLUMN delivery_fee_addon bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT postal_shipment_delivery_fee_tariff_check
    CHECK (delivery_fee_tariff IS NULL OR delivery_fee_tariff >= 0),
  ADD CONSTRAINT postal_shipment_delivery_fee_addon_check
    CHECK (delivery_fee_addon >= 0);

WITH fee_parts AS (
  SELECT
    id,
    CASE
      WHEN shipment_size IS NULL OR delivery_fee IS NULL THEN NULL
      WHEN shipment_size = 'small_package'
        AND governorate IN ('sulaymaniyah','erbil','duhok')
        AND delivery_fee = CASE
          WHEN lower(area) LIKE '%center%' OR lower(area) LIKE '%centre%' THEN 5000
          ELSE 6000
        END THEN delivery_fee
      WHEN governorate NOT IN ('sulaymaniyah','erbil','duhok')
        AND ((shipment_size = 'carton' AND delivery_fee IN (8000,12000,15000,20000))
          OR (shipment_size = 'ship' AND delivery_fee IN (15000,24000,35000,55000)))
        THEN delivery_fee
      -- Preserve an older custom total as the add-on when its tariff component
      -- cannot be recovered from the previous single-fee snapshot.
      ELSE 0
    END::bigint AS tariff_fee
  FROM public.postal_shipments
)
UPDATE public.postal_shipments s
SET delivery_fee_tariff = p.tariff_fee,
    delivery_fee_addon = CASE
      WHEN s.delivery_fee IS NULL THEN 0
      ELSE s.delivery_fee - COALESCE(p.tariff_fee, 0)
    END
FROM fee_parts p
WHERE p.id = s.id;

ALTER TABLE public.postal_shipments
  DROP CONSTRAINT postal_shipment_tariff_snapshot_check,
  ADD CONSTRAINT postal_shipment_tariff_snapshot_check CHECK (
    (
      shipment_size IS NULL
      AND tariff_zone IS NULL
      AND delivery_fee IS NULL
      AND delivery_fee_tariff IS NULL
      AND delivery_fee_addon = 0
      AND tariff_assigned_at IS NULL
      AND tariff_assigned_by IS NULL
    )
    OR (
      delivery_fee IS NOT NULL
      AND tariff_assigned_at IS NOT NULL
      AND (
        (
          shipment_size IS NULL
          AND tariff_zone IS NULL
          AND delivery_fee_tariff IS NULL
          AND delivery_fee_addon = delivery_fee
        )
        OR (
          shipment_size IS NOT NULL
          AND delivery_fee_tariff IS NOT NULL
          AND delivery_fee = delivery_fee_tariff + delivery_fee_addon
          AND (
            (shipment_size = 'small_package' AND tariff_zone IN ('center', 'outside'))
            OR (shipment_size IN ('carton', 'ship') AND tariff_zone IS NULL)
          )
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION postal_private.apply_intake_tariff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
  v_size text;
  v_fee_text text;
  v_addon_text text;
  v_fee bigint;
  v_addon bigint;
  v_total bigint;
  v_zone text;
  v_is_northern boolean;
  v_is_center boolean;
BEGIN
  IF OLD.state = 'draft' AND NEW.state IN ('draft','received')
    AND current_setting('postal.tariff_authorized', true) = 'true' THEN
    v_size := NULLIF(current_setting('postal.tariff_size', true), '');
    v_fee_text := NULLIF(current_setting('postal.tariff_fee', true), '');
    v_addon_text := NULLIF(current_setting('postal.tariff_fee_addon', true), '');

    -- An omitted assignment retains its existing tariff and add-on.
    IF v_size IS NULL AND v_fee_text IS NULL AND v_addon_text IS NULL THEN
      v_size := OLD.shipment_size;
      v_fee_text := OLD.delivery_fee_tariff::text;
      v_addon_text := OLD.delivery_fee_addon::text;
    END IF;
    IF v_addon_text IS NULL THEN
      v_addon := COALESCE(OLD.delivery_fee_addon, 0);
    ELSE
      IF v_addon_text !~ '^[0-9]{1,12}$' THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      v_addon := v_addon_text::bigint;
    END IF;

    v_is_northern := NEW.governorate IN ('sulaymaniyah','erbil','duhok');
    v_is_center := lower(NEW.area) LIKE '%center%' OR lower(NEW.area) LIKE '%centre%';
    IF v_size IS NULL THEN
      IF v_fee_text IS NOT NULL THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      IF v_addon <= 0 THEN
        RAISE EXCEPTION 'postal_tariff_required' USING ERRCODE = '23514';
      END IF;
      v_fee := NULL;
      v_zone := NULL;
      v_total := v_addon;
    ELSE
      IF v_fee_text IS NULL OR v_fee_text !~ '^[0-9]{1,12}$' THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      v_fee := v_fee_text::bigint;
      IF v_fee <= 0 THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;

      IF v_is_northern THEN
        v_zone := CASE WHEN v_is_center THEN 'center' ELSE 'outside' END;
        IF v_size IS DISTINCT FROM 'small_package'
          OR v_fee IS DISTINCT FROM
            (CASE WHEN v_is_center THEN 5000::bigint ELSE 6000::bigint END) THEN
          RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
        END IF;
      ELSE
        v_zone := NULL;
        IF NOT COALESCE((
          (v_size = 'carton' AND v_fee IN (8000,12000,15000,20000))
          OR (v_size = 'ship' AND v_fee IN (15000,24000,35000,55000))
        ), false) THEN
          RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
        END IF;
      END IF;
      v_total := v_fee + v_addon;
    END IF;

    IF v_total <= 0 OR v_total > 999999999999 THEN
      RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
    END IF;

    NEW.shipment_size := v_size;
    NEW.tariff_zone := v_zone;
    NEW.delivery_fee_tariff := v_fee;
    NEW.delivery_fee_addon := v_addon;
    NEW.delivery_fee := v_total;
    IF OLD.tariff_assigned_at IS NULL
      OR ROW(v_size, v_zone, v_fee, v_addon, v_total)
        IS DISTINCT FROM ROW(OLD.shipment_size, OLD.tariff_zone,
          OLD.delivery_fee_tariff, OLD.delivery_fee_addon, OLD.delivery_fee) THEN
      NEW.tariff_assigned_by := auth.uid();
      NEW.tariff_assigned_at := now();
    END IF;
  ELSIF OLD.state = 'draft' AND NEW.state = 'received' THEN
    RAISE EXCEPTION 'postal_tariff_required' USING ERRCODE = '23514';
  ELSIF ROW(NEW.shipment_size, NEW.tariff_zone, NEW.delivery_fee,
            NEW.delivery_fee_tariff, NEW.delivery_fee_addon,
            NEW.tariff_assigned_by, NEW.tariff_assigned_at)
    IS DISTINCT FROM ROW(OLD.shipment_size, OLD.tariff_zone, OLD.delivery_fee,
                          OLD.delivery_fee_tariff, OLD.delivery_fee_addon,
                          OLD.tariff_assigned_by, OLD.tariff_assigned_at) THEN
    RAISE EXCEPTION 'postal_tariff_locked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.postal_command(
  p_command text,
  p_payload jsonb,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM set_config('postal.tariff_authorized',
    CASE WHEN p_command IN ('create_shipment','edit_shipment','receive') THEN 'true' ELSE 'false' END, true);
  PERFORM set_config('postal.tariff_size', COALESCE(p_payload->>'tariff_size',''), true);
  PERFORM set_config('postal.tariff_fee', COALESCE(p_payload->>'delivery_fee',''), true);
  PERFORM set_config('postal.tariff_fee_addon',
    COALESCE(p_payload->>'delivery_fee_addon',''), true);
  IF p_command IN ('generate_qr_batch','set_qr_batch_active','delete_qr_batch') THEN
    RETURN postal_private.qr_batch_command(p_command,p_payload,p_request_id);
  END IF;
  IF p_command = 'delivery_fee_collection' THEN
    RETURN postal_private.delivery_fee_collection(p_payload,p_request_id);
  END IF;
  RETURN postal_private.command(p_command,p_payload,p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION postal_private.attach_tariff_to_receive_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
  v_tariff_metadata jsonb;
BEGIN
  IF NEW.event_type = 'receive' THEN
    SELECT jsonb_build_object(
      'shipment_size', s.shipment_size,
      'tariff_zone', s.tariff_zone,
      'delivery_fee', s.delivery_fee,
      'delivery_fee_tariff', s.delivery_fee_tariff,
      'delivery_fee_addon', s.delivery_fee_addon,
      'tariff_assigned_by', s.tariff_assigned_by,
      'tariff_assigned_at', s.tariff_assigned_at
    ) INTO v_tariff_metadata
    FROM public.postal_shipments s
    WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.shipment_id;
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || COALESCE(v_tariff_metadata, '{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$$;

-- Keep draft history and idempotent replays aligned with the expanded snapshot.
DO $$
DECLARE
  v_source text;
  v_updated text;
BEGIN
  SELECT prosrc INTO v_source FROM pg_proc
  WHERE oid = 'postal_private.command(text,jsonb,uuid)'::regprocedure;

  v_updated := replace(v_source,
    '''shipment_size'',''tariff_zone'',''delivery_fee'',''tariff_assigned_by'',''tariff_assigned_at''',
    '''shipment_size'',''tariff_zone'',''delivery_fee'',''delivery_fee_tariff'',''delivery_fee_addon'',''tariff_assigned_by'',''tariff_assigned_at''');
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft tariff snapshots';
  END IF;
  v_source := v_updated;

  v_updated := replace(v_source,
    'cached.payload = p_payload - ARRAY[''tariff_size'',''delivery_fee'']',
    'cached.payload = p_payload - ARRAY[''tariff_size'',''delivery_fee'',''delivery_fee_addon'']');
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft replay comparison';
  END IF;
  v_source := v_updated;

  v_updated := replace(v_source,
    'AND NOT (cached.response ? ''shipment_size'') THEN',
    'AND NOT (cached.response ? ''delivery_fee_tariff'') THEN');
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft replay compatibility';
  END IF;
  v_source := v_updated;

  v_updated := replace(v_source,
    '''delivery_fee'', current_shipment.delivery_fee,',
    '''delivery_fee'', current_shipment.delivery_fee,
          ''delivery_fee_tariff'', current_shipment.delivery_fee_tariff,
          ''delivery_fee_addon'', current_shipment.delivery_fee_addon,');
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft replay response';
  END IF;
  v_source := v_updated;

  v_updated := replace(v_source,
    'saved_request.payload - ARRAY[''tariff_size'',''delivery_fee'']',
    'saved_request.payload - ARRAY[''tariff_size'',''delivery_fee'',''delivery_fee_addon'']');
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal draft request payload cleanup';
  END IF;
  v_source := v_updated;

  EXECUTE format(
    $ddl$CREATE OR REPLACE FUNCTION postal_private.command(
      p_command text, p_payload jsonb, p_request_id uuid
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS %L$ddl$,
    v_updated
  );
END;
$$;

REVOKE ALL ON FUNCTION postal_private.apply_intake_tariff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.postal_command(text,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_command(text,jsonb,uuid) TO authenticated, service_role;
