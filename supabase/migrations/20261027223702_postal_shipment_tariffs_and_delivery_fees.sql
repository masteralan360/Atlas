-- Snapshot the tariff chosen by staff when the parcel is physically received.
ALTER TABLE public.postal_shipments
  ADD COLUMN shipment_size text,
  ADD COLUMN tariff_zone text,
  ADD COLUMN delivery_fee bigint,
  ADD COLUMN tariff_assigned_by uuid REFERENCES public.profiles(id),
  ADD COLUMN tariff_assigned_at timestamptz,
  ADD CONSTRAINT postal_shipment_size_check
    CHECK (shipment_size IS NULL OR shipment_size IN ('carton','ship','small_package')),
  ADD CONSTRAINT postal_shipment_tariff_zone_check
    CHECK (tariff_zone IS NULL OR tariff_zone IN ('center','outside')),
  ADD CONSTRAINT postal_shipment_delivery_fee_check
    CHECK (delivery_fee IS NULL OR delivery_fee > 0),
  ADD CONSTRAINT postal_shipment_tariff_snapshot_check CHECK (
    (shipment_size IS NULL AND delivery_fee IS NULL AND tariff_assigned_at IS NULL
      AND tariff_assigned_by IS NULL)
    OR (shipment_size IS NOT NULL AND delivery_fee IS NOT NULL AND tariff_assigned_at IS NOT NULL)
  ),
  ADD CONSTRAINT postal_shipment_tariff_classification_check CHECK (
    (shipment_size = 'small_package' AND tariff_zone IS NOT NULL
      AND tariff_zone IN ('center','outside'))
    OR (shipment_size IN ('carton','ship') AND tariff_zone IS NULL)
    OR (shipment_size IS NULL AND tariff_zone IS NULL)
  );

CREATE FUNCTION postal_private.apply_intake_tariff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
  v_size text;
  v_fee_text text;
  v_fee bigint;
  v_zone text;
  v_is_northern boolean;
  v_is_center boolean;
BEGIN
  IF OLD.state = 'draft' AND NEW.state = 'received' THEN
    IF current_setting('postal.tariff_authorized', true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'postal_tariff_required' USING ERRCODE = '23514';
    END IF;

    v_size := current_setting('postal.tariff_size', true);
    v_fee_text := current_setting('postal.tariff_fee', true);
    IF COALESCE(v_fee_text, '') !~ '^[0-9]{1,12}$' THEN
      RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
    END IF;
    v_fee := v_fee_text::bigint;
    v_is_northern := NEW.governorate IN ('sulaymaniyah','erbil','duhok');
    v_is_center := lower(NEW.area) LIKE '%center%' OR lower(NEW.area) LIKE '%centre%';

    IF v_is_northern THEN
      v_zone := CASE WHEN v_is_center THEN 'center' ELSE 'outside' END;
      IF v_size IS DISTINCT FROM 'small_package'
        OR v_fee IS DISTINCT FROM (CASE WHEN v_is_center THEN 5000::bigint ELSE 6000::bigint END) THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
    ELSE
      v_zone := NULL;
      IF NOT COALESCE((
        (v_size = 'carton' AND v_fee IN (8000,12000,15000))
        OR (v_size = 'ship' AND v_fee IN (15000,24000,35000,55000))
      ),false) THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
    END IF;

    NEW.shipment_size := v_size;
    NEW.tariff_zone := v_zone;
    NEW.delivery_fee := v_fee;
    NEW.tariff_assigned_by := auth.uid();
    NEW.tariff_assigned_at := now();
  ELSIF OLD.state = 'draft' AND NEW.state = 'draft'
    AND ROW(NEW.shipment_size, NEW.tariff_zone, NEW.delivery_fee,
            NEW.tariff_assigned_by, NEW.tariff_assigned_at)
        IS DISTINCT FROM
        ROW(OLD.shipment_size, OLD.tariff_zone, OLD.delivery_fee,
            OLD.tariff_assigned_by, OLD.tariff_assigned_at) THEN
    RAISE EXCEPTION 'postal_tariff_locked' USING ERRCODE = '42501';
  ELSIF OLD.tariff_assigned_at IS NOT NULL
    AND ROW(NEW.shipment_size, NEW.tariff_zone, NEW.delivery_fee,
            NEW.tariff_assigned_by, NEW.tariff_assigned_at)
        IS DISTINCT FROM
        ROW(OLD.shipment_size, OLD.tariff_zone, OLD.delivery_fee,
            OLD.tariff_assigned_by, OLD.tariff_assigned_at) THEN
    RAISE EXCEPTION 'postal_tariff_locked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION postal_private.apply_intake_tariff() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER postal_apply_intake_tariff
  BEFORE UPDATE ON public.postal_shipments
  FOR EACH ROW EXECUTE FUNCTION postal_private.apply_intake_tariff();

CREATE FUNCTION postal_private.attach_tariff_to_receive_event()
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
REVOKE ALL ON FUNCTION postal_private.attach_tariff_to_receive_event() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER postal_event_tariff_snapshot
  BEFORE INSERT ON public.postal_events
  FOR EACH ROW EXECUTE FUNCTION postal_private.attach_tariff_to_receive_event();

-- Delivery-fee receipts are distinct from COD so they never increase the
-- amount owed to the merchant.
CREATE TABLE public.postal_delivery_fee_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  signed_amount bigint NOT NULL CHECK (signed_amount > 0 AND signed_amount <= 999999999999),
  payment_transaction_id uuid NOT NULL UNIQUE REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,shipment_id,organization_id)
    REFERENCES public.postal_shipments(workspace_id,id,organization_id)
);
ALTER TABLE public.postal_delivery_fee_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.postal_delivery_fee_records FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.postal_delivery_fee_records TO authenticated;
GRANT ALL ON public.postal_delivery_fee_records TO service_role;
CREATE POLICY postal_delivery_fee_read ON public.postal_delivery_fee_records
  FOR SELECT TO authenticated
  USING (postal_private.can_read(workspace_id,organization_id));
CREATE INDEX postal_delivery_fee_history
  ON public.postal_delivery_fee_records(workspace_id,organization_id,created_at DESC,id DESC);
CREATE INDEX postal_delivery_fee_shipment
  ON public.postal_delivery_fee_records(workspace_id,shipment_id,created_at,id);
CREATE TRIGGER postal_delivery_fee_immutable
  BEFORE UPDATE OR DELETE ON public.postal_delivery_fee_records
  FOR EACH ROW EXECUTE FUNCTION postal_private.immutable_history();

CREATE OR REPLACE FUNCTION postal_private.delivery_fee_collection(
  p_payload jsonb,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
  w uuid := public.current_workspace_id();
  actor uuid := auth.uid();
  role_name text;
  s public.postal_shipments;
  cached postal_private.requests;
  actor_name text;
  amount bigint;
  collected bigint;
  method text;
  payment_id uuid;
  record_id uuid;
  payment_data jsonb;
  result jsonb;
  event_metadata jsonb;
BEGIN
  role_name := postal_private.access_role(w);
  IF actor IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','office') OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF (p_payload->>'workspace_id')::uuid IS DISTINCT FROM w THEN
    RAISE EXCEPTION 'postal_workspace_changed' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(w::text || actor::text || p_request_id::text, 0));
  SELECT * INTO cached FROM postal_private.requests
  WHERE workspace_id = w AND actor_id = actor AND request_id = p_request_id;
  IF FOUND THEN
    IF cached.command <> 'delivery_fee_collection' OR cached.payload <> p_payload THEN
      RAISE EXCEPTION 'postal_request_conflict';
    END IF;
    IF cached.response ? 'organization_id'
      AND NOT postal_private.can_read(w,(cached.response->>'organization_id')::uuid) THEN
      RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
    END IF;
    RETURN cached.response;
  END IF;

  SELECT COALESCE(name,'') INTO actor_name FROM public.profiles WHERE id = actor;
  SELECT * INTO s FROM public.postal_shipments
  WHERE workspace_id = w AND id = (p_payload->>'id')::uuid AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR NOT postal_private.can_read(w,s.organization_id) THEN
    RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
  END IF;
  IF s.revision IS DISTINCT FROM (p_payload->>'revision')::integer THEN
    RAISE EXCEPTION 'postal_stale_shipment' USING ERRCODE = '40001';
  END IF;
  IF s.state <> 'delivered' OR s.delivery_fee IS NULL OR s.delivery_fee <= 0 THEN
    RAISE EXCEPTION 'postal_invalid_transition' USING ERRCODE = '23514';
  END IF;

  IF COALESCE(p_payload->>'signed_amount','') !~ '^[0-9]{1,12}$' THEN
    RAISE EXCEPTION 'postal_invalid_payment' USING ERRCODE = '22023';
  END IF;
  amount := (p_payload->>'signed_amount')::bigint;
  method := p_payload->>'payment_method';
  IF amount <= 0 OR method IS NULL
    OR method NOT IN ('cash','fib','qicard','zaincash','fastpay','bank_transfer') THEN
    RAISE EXCEPTION 'postal_invalid_payment' USING ERRCODE = '22023';
  END IF;
  IF p_payload->>'direction' IS DISTINCT FROM 'incoming' THEN
    RAISE EXCEPTION 'postal_invalid_payment' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(sum(f.signed_amount),0) INTO collected
  FROM public.postal_delivery_fee_records f
  WHERE f.workspace_id = w AND f.shipment_id = s.id;
  IF amount > s.delivery_fee - collected THEN
    RAISE EXCEPTION 'postal_invalid_payment' USING ERRCODE = '22023';
  END IF;

  payment_id := gen_random_uuid();
  record_id := gen_random_uuid();
  INSERT INTO public.payment_transactions(
    id,workspace_id,source_module,source_type,source_record_id,source_subrecord_id,
    direction,amount,currency,payment_method,paid_at,counterparty_name,reference_label,
    note,created_by,account_id,account_name_snapshot,metadata
  ) VALUES (
    payment_id,w,'postal_service','postal_delivery_fee',s.id,record_id,
    'incoming',amount,'iqd',method,now(),s.recipient_name,s.id::text,
    p_payload->>'notes',actor,NULLIF(p_payload->>'account_id','')::uuid,
    p_payload->>'account_name_snapshot',
    jsonb_build_object('organizationId',s.organization_id,'deliveryFeeAmount',amount)
  );
  INSERT INTO public.postal_delivery_fee_records(
    id,workspace_id,shipment_id,organization_id,signed_amount,
    payment_transaction_id,actor_id,notes
  ) VALUES (
    record_id,w,s.id,s.organization_id,amount,payment_id,actor,p_payload->>'notes'
  );

  UPDATE public.postal_shipments
  SET revision = revision + 1, updated_at = now()
  WHERE id = s.id RETURNING * INTO s;
  event_metadata := jsonb_build_object(
    'signed_amount',amount,'delivery_fee',s.delivery_fee,
    'payment_transaction_id',payment_id
  );
  INSERT INTO public.postal_events(
    workspace_id,shipment_id,event_type,previous_state,resulting_state,
    actor_id,actor_name,notes,metadata
  ) VALUES (
    w,s.id,'delivery_fee_recorded','delivered','delivered',
    actor,actor_name,p_payload->>'notes',event_metadata
  );
  SELECT to_jsonb(p) INTO payment_data FROM public.payment_transactions p WHERE p.id = payment_id;
  result := to_jsonb(s) || jsonb_build_object('payment_transaction',payment_data);
  INSERT INTO postal_private.requests(workspace_id,actor_id,request_id,command,payload,response)
  VALUES (w,actor,p_request_id,'delivery_fee_collection',p_payload,result);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION postal_private.delivery_fee_collection(jsonb,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION postal_private.delivery_fee_collection(jsonb,uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.postal_command(
  p_command text,
  p_payload jsonb,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = '' AS $$
BEGIN
  IF p_command = 'receive' THEN
    PERFORM set_config('postal.tariff_authorized','true',true);
    PERFORM set_config('postal.tariff_size',COALESCE(p_payload->>'tariff_size',''),true);
    PERFORM set_config('postal.tariff_fee',COALESCE(p_payload->>'delivery_fee',''),true);
  ELSIF p_command = 'delivery_fee_collection' THEN
    RETURN postal_private.delivery_fee_collection(p_payload,p_request_id);
  END IF;
  RETURN postal_private.command(p_command,p_payload,p_request_id);
END;
$$;
REVOKE ALL ON FUNCTION public.postal_command(text,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_command(text,jsonb,uuid) TO authenticated, service_role;

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
     AND NEW.source_type IN ('postal_cod','postal_settlement','postal_delivery_fee')
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
        'shipmentNumber',v_shipment_number,
        'shipmentReference',v_shipment_reference,
        'shipmentYear',v_shipment_year
      );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION postal_private.attach_shipment_reference() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.postal_financial_summary(p_shipment_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'collected',COALESCE(sum(c.signed_amount) FILTER (WHERE c.kind='collection'),0),
    'settled',COALESCE(sum(c.signed_amount) FILTER (WHERE c.kind='settlement'),0),
    'record_count',count(c.id),
    'delivery_fee_collected',COALESCE((
      SELECT sum(f.signed_amount) FROM public.postal_delivery_fee_records f
      WHERE f.workspace_id = public.current_workspace_id() AND f.shipment_id = p_shipment_id
    ),0),
    'delivery_fee_record_count',COALESCE((
      SELECT count(*) FROM public.postal_delivery_fee_records f
      WHERE f.workspace_id = public.current_workspace_id() AND f.shipment_id = p_shipment_id
    ),0)
  )
  FROM public.postal_cod_records c
  WHERE c.shipment_id = p_shipment_id
    AND c.workspace_id = public.current_workspace_id()
  HAVING EXISTS (
    SELECT 1 FROM public.postal_shipments s
    WHERE s.id = p_shipment_id AND s.workspace_id = public.current_workspace_id()
  );
$$;
REVOKE ALL ON FUNCTION public.postal_financial_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_financial_summary(uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
        AND tablename = 'postal_delivery_fee_records'
    ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.postal_delivery_fee_records;
  END IF;
END;
$$;
