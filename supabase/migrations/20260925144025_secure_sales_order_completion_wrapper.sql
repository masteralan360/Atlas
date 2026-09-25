-- Keep the privileged implementation outside PostgREST's exposed public
-- schema. The public RPC is an invoker wrapper; the private implementation
-- performs the explicit workspace/role checks before writing protected rows.

ALTER FUNCTION public.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) SET SCHEMA private;

REVOKE ALL ON FUNCTION private.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_sales_order_with_inventory(
  p_order_id uuid,
  p_workspace_id uuid,
  p_expected_order_version bigint,
  p_operation_id uuid,
  p_items jsonb,
  p_actual_delivery_date timestamptz,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.complete_sales_order_with_inventory(
    p_order_id,
    p_workspace_id,
    p_expected_order_version,
    p_operation_id,
    p_items,
    p_actual_delivery_date,
    p_changes
  );
$function$;

REVOKE ALL ON FUNCTION public.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) TO authenticated, service_role;

COMMENT ON FUNCTION private.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) IS 'Private atomic sales order completion implementation with explicit workspace authorization.';

COMMENT ON FUNCTION public.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) IS 'Invokes the authorized private operation that atomically completes a sales order and posts its inventory.';

NOTIFY pgrst, 'reload schema';
