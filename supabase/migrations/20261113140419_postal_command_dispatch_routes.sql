BEGIN;

-- Keep every postal command on its dedicated handler. In particular,
-- create_organization must not fall through to the shipment command, where a
-- missing shipment ID is reported as postal_unavailable.
CREATE OR REPLACE FUNCTION public.postal_command(
  p_command text,
  p_payload jsonb,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = '' AS $$
BEGIN
  PERFORM set_config(
    'postal.tariff_authorized',
    CASE WHEN p_command IN ('create_shipment', 'edit_shipment', 'receive')
      THEN 'true' ELSE 'false' END,
    true
  );
  PERFORM set_config('postal.tariff_size', COALESCE(p_payload->>'tariff_size', ''), true);
  PERFORM set_config('postal.tariff_fee', COALESCE(p_payload->>'delivery_fee', ''), true);
  PERFORM set_config(
    'postal.tariff_fee_addon',
    COALESCE(p_payload->>'delivery_fee_addon', ''),
    true
  );
  PERFORM set_config(
    'postal.late_delivery_fee_edit_authorized',
    CASE WHEN p_command = 'edit_shipment'
      AND postal_private.access_role(public.current_workspace_id()) = 'admin'
      AND p_payload ? 'delivery_fee_override'
      THEN 'true' ELSE 'false' END,
    true
  );
  PERFORM set_config(
    'postal.late_delivery_fee_override',
    COALESCE(p_payload->>'delivery_fee_override', ''),
    true
  );

  IF p_command = 'create_organization' THEN
    RETURN postal_private.create_organization_command(p_payload, p_request_id);
  END IF;
  IF p_command IN ('generate_qr_batch', 'set_qr_batch_active', 'delete_qr_batch') THEN
    RETURN postal_private.qr_batch_command(p_command, p_payload, p_request_id);
  END IF;
  IF p_command = 'delivery_fee_collection' THEN
    RETURN postal_private.delivery_fee_collection(p_payload, p_request_id);
  END IF;
  RETURN postal_private.command(p_command, p_payload, p_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.postal_command(text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_command(text, jsonb, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
