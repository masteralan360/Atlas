-- Include the shipment amount columns in the organization statement's period totals.
-- The totals use distinct organization movements in the period and intentionally
-- ignore search/type filters, like the existing debit and credit period totals.
DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(
    'public.postal_organization_statement(uuid,uuid,integer,integer,timestamptz,timestamptz,text,text)'::regprocedure
  ) INTO v_definition;

  IF position($find$'delivery_fees', (SELECT delivery_fees::text FROM totals),$find$ IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate the postal organization statement summary';
  END IF;

  v_updated := replace(
    v_definition,
    $find$'delivery_fees', (SELECT delivery_fees::text FROM totals),$find$,
    $replace$'delivery_fees', (SELECT delivery_fees::text FROM totals),
      'cod_amount_total', COALESCE((
        SELECT sum(s.cod_amount::numeric)
        FROM (SELECT DISTINCT shipment_id FROM period WHERE kind <> 'collection') period_shipments
        JOIN public.postal_shipments s ON s.workspace_id = p_workspace_id AND s.id = period_shipments.shipment_id
      ), 0)::text,
      'delivery_fee_total', COALESCE((
        SELECT sum(s.delivery_fee::numeric)
        FROM (SELECT DISTINCT shipment_id FROM period WHERE kind <> 'collection') period_shipments
        JOIN public.postal_shipments s ON s.workspace_id = p_workspace_id AND s.id = period_shipments.shipment_id
      ), 0)::text,$replace$
  );

  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'Could not add postal statement shipment totals';
  END IF;
  EXECUTE v_updated;
END $$;
