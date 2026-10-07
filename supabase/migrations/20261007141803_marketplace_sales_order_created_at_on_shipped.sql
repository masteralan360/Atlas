-- A marketplace CRM Sales Order is materialized when the marketplace order
-- transitions to Shipped. Use that event time for the Sales Order's created_at.
-- Existing Sales Order rows are intentionally unchanged.
DO $migration$
DECLARE
  v_definition text;
  v_updated text;
  v_source_pattern text := $pattern$(v_order[.]id,[[:space:]]+v_shipped_actor_id,[[:space:]]+)v_order[.]created_at,([[:space:]]+v_shipment_timestamp,[[:space:]]+'synced')$pattern$;
  v_shipment_pattern text := $pattern$(v_order[.]id,[[:space:]]+v_shipped_actor_id,[[:space:]]+)v_shipment_timestamp,([[:space:]]+v_shipment_timestamp,[[:space:]]+'synced')$pattern$;
  v_match_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  )
  INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Marketplace order transition procedure was not found';
  END IF;

  v_definition := replace(v_definition, chr(13), '');

  SELECT count(*)
  INTO v_match_count
  FROM regexp_matches(v_definition, v_source_pattern, 'g');

  IF v_match_count = 0 AND v_definition ~ v_shipment_pattern THEN
    RETURN;
  ELSIF v_match_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one marketplace Sales Order created_at value to update; found %',
      v_match_count;
  END IF;

  v_updated := regexp_replace(
    v_definition,
    v_source_pattern,
    $replacement$\1v_shipment_timestamp,\2$replacement$
  );

  IF v_updated IS NOT DISTINCT FROM v_definition
    OR v_updated !~ v_shipment_pattern
  THEN
    RAISE EXCEPTION 'Marketplace Sales Order created_at could not be set to shipment time';
  END IF;

  EXECUTE v_updated;
END;
$migration$;
