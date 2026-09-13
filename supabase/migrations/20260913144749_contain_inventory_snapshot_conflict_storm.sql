-- Convert strict compare-and-set conflicts into an explicit result envelope.
-- The exception block is a PostgreSQL subtransaction: every attempted write
-- is rolled back before the envelope is returned. Other errors still fail.

CREATE OR REPLACE FUNCTION public.apply_inventory_snapshot_changes(
  p_operation_id uuid,
  p_workspace_id uuid,
  p_operation_kind text,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  RETURN private.apply_inventory_snapshot_changes(
    p_operation_id,
    p_workspace_id,
    p_operation_kind,
    p_changes
  );
EXCEPTION
  WHEN serialization_failure THEN
    RETURN pg_catalog.jsonb_build_object(
      'operation_id', p_operation_id,
      'inventory', NULL,
      'already_applied', false,
      'conflict', true,
      'retry_after_ms', 5000
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb) IS
  'Strict inventory CAS RPC. Version conflicts roll back and return a conflict envelope without creating a PostgreSQL error storm.';
