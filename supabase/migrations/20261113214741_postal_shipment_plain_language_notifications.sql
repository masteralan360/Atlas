-- Include the shipment recipient in notifications so the localized message can
-- state the shipment number, client, and current status in plain language.
DO $migration$
DECLARE
  v_definition text;
  v_anchor text;
BEGIN
  v_definition := pg_get_functiondef(
    'postal_private.notify_organization_on_shipment_status_change()'::regprocedure
  );

  v_anchor := E'  v_shipment_number bigint;\n';
  IF position(v_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate the shipment number variable';
  END IF;
  v_definition := replace(
    v_definition,
    v_anchor,
    E'  v_shipment_number bigint;\n  v_client_name text;\n'
  );

  v_anchor := E'    shipment.shipment_number,\n    EXTRACT(YEAR';
  IF position(v_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate the shipment recipient query';
  END IF;
  v_definition := replace(
    v_definition,
    v_anchor,
    E'    shipment.shipment_number,\n    shipment.recipient_name,\n    EXTRACT(YEAR'
  );

  v_anchor := E'  INTO v_organization_id, v_shipment_number, v_shipment_year';
  IF position(v_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate the shipment query targets';
  END IF;
  v_definition := replace(
    v_definition,
    v_anchor,
    '  INTO v_organization_id, v_shipment_number, v_client_name, v_shipment_year'
  );

  v_anchor := E'        ''shipment_number'', v_shipment_number,\n';
  IF position(v_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate the notification shipment number payload';
  END IF;
  v_definition := replace(
    v_definition,
    v_anchor,
    E'        ''shipment_number'', v_shipment_number,\n        ''client_name'', v_client_name,\n'
  );

  v_anchor := '        ''body'', format(''Shipment #%s: %s → %s'', v_shipment_number, NEW.previous_state, NEW.resulting_state),';
  IF position(v_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate the notification fallback body';
  END IF;
  v_definition := replace(
    v_definition,
    v_anchor,
    '        ''body'', format(''Your shipment #%s for client %s has changed status.'', v_shipment_number, v_client_name),'
  );

  EXECUTE v_definition;
END;
$migration$;
