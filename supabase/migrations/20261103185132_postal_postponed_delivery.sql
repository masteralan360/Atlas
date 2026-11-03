ALTER TABLE public.postal_shipments
  DROP CONSTRAINT postal_shipments_state_check,
  ADD CONSTRAINT postal_shipments_state_check
    CHECK (state IN (
      'draft', 'received', 'in_transit', 'arrived', 'out_for_delivery',
      'postponed', 'delivered', 'cancelled'
    ));

-- Extend the existing command function in place so its authorization,
-- idempotency, shipment revision, and event handling remain unchanged.
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
    $find$p_command IN ('save_branch','save_organization','move_member','authorize_transfer','cancel_transfer','cancel','settlement') AND r<>'admin'$find$,
    $replace$(p_command IN ('save_branch','save_organization','move_member','cancel_transfer','settlement') AND r<>'admin')
   OR (p_command IN ('authorize_transfer','cancel') AND r<>'admin'
     AND NOT (r='office' AND p_payload->>'expected_state'='postponed'))$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not extend postal command replay permissions';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$OR (p_command IN ('receive','dispatch','arrive','out_for_delivery','deliver','collection') AND r NOT IN ('admin','office'))$find$,
    $replace$OR (p_command IN ('receive','dispatch','arrive','out_for_delivery','postpone_delivery','deliver','collection') AND r NOT IN ('admin','office'))$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not extend postal command replay permissions';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$IF r<>'admin' OR s.state NOT IN ('received','arrived') OR tr.id IS NOT NULL THEN RAISE EXCEPTION 'postal_invalid_transition'; END IF;$find$,
    $replace$IF (r<>'admin' AND NOT (r='office' AND s.state='postponed'
       AND p_payload->>'expected_state'='postponed'))
     OR s.state NOT IN ('received','arrived','postponed') OR tr.id IS NOT NULL THEN RAISE EXCEPTION 'postal_invalid_transition'; END IF;$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not allow transfers from postponed shipments';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$ELSIF p_command IN ('receive','dispatch','arrive','out_for_delivery','deliver','cancel') THEN$find$,
    $replace$ELSIF p_command IN ('receive','dispatch','arrive','out_for_delivery','postpone_delivery','deliver','cancel') THEN$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not add postponed delivery command';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$ELSIF p_command='dispatch' AND s.state IN ('received','arrived') AND tr.status='authorized' THEN$find$,
    $replace$ELSIF p_command='dispatch' AND s.state IN ('received','arrived','postponed') AND tr.status='authorized' THEN$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not allow dispatch from postponed shipments';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$ELSIF p_command='out_for_delivery' AND s.state IN ('received','arrived') AND tr.id IS NULL THEN s.state:='out_for_delivery';$find$,
    $replace$ELSIF p_command='out_for_delivery' AND s.state IN ('received','arrived','postponed') AND tr.id IS NULL THEN s.state:='out_for_delivery';$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not resume postponed delivery';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$   ELSIF p_command='deliver' AND s.state='out_for_delivery' THEN s.state:='delivered';$find$,
    $replace$   ELSIF p_command='postpone_delivery' AND s.state='out_for_delivery' THEN s.state:='postponed';
   ELSIF p_command='deliver' AND s.state='out_for_delivery' THEN s.state:='delivered';$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not add postponed delivery state transition';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $find$ELSIF p_command='cancel' AND r='admin' AND s.state NOT IN ('delivered','cancelled') AND tr.status IS DISTINCT FROM 'dispatched' THEN$find$,
    $replace$ELSIF p_command='cancel' AND (r='admin' OR (r='office' AND s.state='postponed'
     AND p_payload->>'expected_state'='postponed')) AND s.state NOT IN ('delivered','cancelled') AND tr.status IS DISTINCT FROM 'dispatched' THEN$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not allow cancellation of postponed shipments';
  END IF;
  v_source := v_updated;

  EXECUTE format(
    $ddl$CREATE OR REPLACE FUNCTION postal_private.command(
      p_command text, p_payload jsonb, p_request_id uuid
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS %L$ddl$,
    v_source
  );
END
$$;

-- Make the new state available as a dashboard filter.
DO $$
DECLARE
  v_source text;
  v_updated text;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE oid = 'postal_private.dashboard_summary(uuid,text,text,timestamptz,timestamptz)'::regprocedure;

  v_updated := replace(
    v_source,
    $find$'out_for_delivery','delivered'$find$,
    $replace$'out_for_delivery','postponed','delivered'$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not add postponed shipment filter';
  END IF;

  EXECUTE format(
    $ddl$CREATE OR REPLACE FUNCTION postal_private.dashboard_summary(
      p_workspace_id uuid, p_search text DEFAULT '', p_status text DEFAULT 'all',
      p_start timestamptz DEFAULT NULL, p_end timestamptz DEFAULT NULL
    ) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS %L$ddl$,
    v_updated
  );
END
$$;
