-- Let postal admins correct COD and delivery amounts until delivery/payment is
-- complete. Admin edits are applied to the current shipment row without adding
-- an edit event to the shipment timeline.

DO $$
DECLARE
  v_source text;
  v_updated text;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE oid = 'postal_private.command(text,jsonb,uuid)'::regprocedure;

  v_updated := replace(
    v_source,
    $find$IF r='admin' AND length(btrim(COALESCE(p_payload->>'reason','')))=0 THEN RAISE EXCEPTION 'postal_reason_required'; END IF;$find$,
    $replace$-- Admin edits do not require a reason.$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not remove the admin edit reason requirement';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$IF s.state<>'draft' AND s.cod_amount IS DISTINCT FROM (p_payload->>'cod_amount')::bigint THEN RAISE EXCEPTION 'postal_cod_locked'; END IF;$find$,
    $replace$IF s.cod_amount IS DISTINCT FROM (p_payload->>'cod_amount')::bigint AND (
    NOT ((r='admin' AND s.state NOT IN ('delivered','cancelled')) OR (r='merchant' AND s.state='draft'))
    OR EXISTS(SELECT 1 FROM public.postal_cod_records WHERE shipment_id=s.id)
   ) THEN RAISE EXCEPTION 'postal_cod_locked'; END IF;
   IF p_payload ? 'delivery_fee_override' AND (
     r<>'admin' OR s.state NOT IN ('received','in_transit','arrived','out_for_delivery','postponed')
     OR EXISTS(SELECT 1 FROM public.postal_cod_records WHERE shipment_id=s.id)
     OR EXISTS(SELECT 1 FROM public.postal_delivery_fee_records WHERE shipment_id=s.id)
   ) THEN RAISE EXCEPTION 'postal_amount_locked'; END IF;$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not extend postal amount edit guards';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$detail:=jsonb_build_object('before',
      CASE WHEN s.state = 'draft' THEN to_jsonb(s) - ARRAY[
        'shipment_size','tariff_zone','delivery_fee','delivery_fee_tariff','delivery_fee_addon','tariff_assigned_by','tariff_assigned_at'
      ] ELSE to_jsonb(s) END, 'reason',p_payload->>'reason');$find$,
    $replace$detail:='{}';$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not remove admin edit history metadata';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$event_kind:=CASE WHEN r='admin' THEN 'admin_correction' ELSE 'edited' END;$find$,
    $replace$event_kind:=CASE WHEN r='admin' THEN NULL ELSE 'edited' END;$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not suppress admin edit timeline events';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$IF event_kind IS NOT NULL THEN$find$,
    $replace$IF event_kind IS NOT NULL OR p_command='edit_shipment' THEN$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not preserve admin shipment revisions';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$INSERT INTO public.postal_events(workspace_id,shipment_id,event_type,previous_state,resulting_state,actor_id,actor_name,origin_id,destination_id,notes,metadata)$find$,
    $replace$IF event_kind IS NOT NULL THEN INSERT INTO public.postal_events(workspace_id,shipment_id,event_type,previous_state,resulting_state,actor_id,actor_name,origin_id,destination_id,notes,metadata)$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not suppress admin edit timeline events';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$VALUES(w,s.id,event_kind,previous,s.state,actor,actor_name,origin,destination,p_payload->>'notes',detail);$find$,
    $replace$VALUES(w,s.id,event_kind,previous,s.state,actor,actor_name,origin,destination,p_payload->>'notes',detail); END IF;$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not close admin edit timeline guard';
  END IF;
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not keep admin shipment revisions without timeline events';
  END IF;

  EXECUTE format(
    $ddl$CREATE OR REPLACE FUNCTION postal_private.command(
      p_command text, p_payload jsonb, p_request_id uuid
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS %L$ddl$,
    v_updated
  );
END
$$;

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
  v_profile text;
  v_area_zone text;
BEGIN
  IF OLD.state = 'draft' AND NEW.state IN ('draft','received')
    AND current_setting('postal.tariff_authorized', true) = 'true' THEN
    v_size := NULLIF(current_setting('postal.tariff_size', true), '');
    v_fee_text := NULLIF(current_setting('postal.tariff_fee', true), '');
    v_addon_text := NULLIF(current_setting('postal.tariff_fee_addon', true), '');

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

      SELECT g.tariff_profile, l.tariff_zone
        INTO v_profile, v_area_zone
      FROM public.postal_governorates g
      JOIN public.postal_locations l ON l.governorate = g.id
      WHERE g.id = NEW.governorate AND l.area = NEW.area;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'postal_location_unavailable' USING ERRCODE = '22023';
      END IF;

      v_zone := CASE WHEN v_profile = 'northern' THEN v_area_zone ELSE 'standard' END;
      IF NOT EXISTS (
        SELECT 1 FROM public.postal_shipment_tariffs t
        WHERE t.tariff_profile = v_profile
          AND t.shipment_size = v_size
          AND t.tariff_zone = v_zone
          AND t.fee = v_fee
          AND (
            t.is_active
            OR (
              OLD.shipment_size = v_size
              AND OLD.delivery_fee_tariff = v_fee
              AND OLD.tariff_zone IS NOT DISTINCT FROM
                CASE WHEN v_profile = 'northern' THEN v_zone ELSE NULL END
            )
          )
      ) THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      IF v_profile <> 'northern' THEN v_zone := NULL; END IF;
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
  ELSIF current_setting('postal.late_delivery_fee_edit_authorized', true) = 'true'
    AND postal_private.access_role(public.current_workspace_id()) = 'admin'
    AND OLD.state IN ('received','in_transit','arrived','out_for_delivery','postponed')
    AND NEW.state = OLD.state THEN
    v_fee_text := NULLIF(current_setting('postal.late_delivery_fee_override', true), '');
    IF v_fee_text IS NULL OR v_fee_text !~ '^[0-9]{1,12}$' THEN
      RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
    END IF;
    v_total := v_fee_text::bigint;
    IF v_total <= 0 OR v_total > 999999999999 THEN
      RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
    END IF;
    IF NEW.shipment_size IS NULL THEN
      NEW.delivery_fee_tariff := NULL;
      NEW.delivery_fee_addon := v_total;
    ELSE
      NEW.delivery_fee_tariff := v_total;
      NEW.delivery_fee_addon := 0;
    END IF;
    NEW.delivery_fee := v_total;
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

DO $$
DECLARE
  v_source text;
  v_updated text;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE oid = 'public.postal_command(text,jsonb,uuid)'::regprocedure;
  v_updated := replace(
    v_source,
    $find$  PERFORM set_config('postal.tariff_fee_addon',
    COALESCE(p_payload->>'delivery_fee_addon',''), true);$find$,
    $replace$  PERFORM set_config('postal.tariff_fee_addon',
    COALESCE(p_payload->>'delivery_fee_addon',''), true);
  PERFORM set_config('postal.late_delivery_fee_edit_authorized',
    CASE WHEN p_command='edit_shipment'
      AND postal_private.access_role(public.current_workspace_id())='admin'
      AND p_payload ? 'delivery_fee_override' THEN 'true' ELSE 'false' END, true);
  PERFORM set_config('postal.late_delivery_fee_override',
    COALESCE(p_payload->>'delivery_fee_override',''), true);$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not authorize live postal admin fee edits';
  END IF;
  EXECUTE format(
    $ddl$CREATE OR REPLACE FUNCTION public.postal_command(
      p_command text, p_payload jsonb, p_request_id uuid
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS %L$ddl$,
    v_updated
  );
END
$$;

REVOKE ALL ON FUNCTION postal_private.apply_intake_tariff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.postal_command(text,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_command(text,jsonb,uuid) TO authenticated, service_role;
