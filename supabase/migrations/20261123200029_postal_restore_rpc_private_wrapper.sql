BEGIN;

ALTER FUNCTION public.postal_restore_shipment_to_draft(uuid, uuid, integer, uuid)
  SET SCHEMA postal_private;

CREATE FUNCTION public.postal_restore_shipment_to_draft(
  p_workspace_id uuid,
  p_shipment_id uuid,
  p_expected_revision integer,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $function$
  SELECT postal_private.postal_restore_shipment_to_draft(
    p_workspace_id,
    p_shipment_id,
    p_expected_revision,
    p_request_id
  )
$function$;

REVOKE ALL ON FUNCTION public.postal_restore_shipment_to_draft(uuid, uuid, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_restore_shipment_to_draft(uuid, uuid, integer, uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
