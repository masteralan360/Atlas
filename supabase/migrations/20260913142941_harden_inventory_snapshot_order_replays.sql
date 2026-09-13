-- Keep compare-and-set strict while making sales-order inventory completion
-- safely replayable with a stable business operation id. This migration does
-- not update inventory, products, orders, or any other business rows.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER FUNCTION private.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  RENAME TO apply_inventory_snapshot_changes_once;

REVOKE ALL ON FUNCTION private.apply_inventory_snapshot_changes_once(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.apply_inventory_snapshot_changes(
  p_operation_id uuid,
  p_workspace_id uuid,
  p_operation_kind text,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing_receipt private.inventory_snapshot_receipts%ROWTYPE;
  v_jwt_role text := COALESCE(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  );
BEGIN
  IF p_operation_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Inventory operation and workspace identifiers are required'
      USING ERRCODE = '22023';
  END IF;

  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication is required'
        USING ERRCODE = '42501';
    END IF;

    IF p_workspace_id IS DISTINCT FROM public.current_workspace_id()
      OR public.current_user_role() NOT IN ('admin', 'staff')
    THEN
      RAISE EXCEPTION 'You are not allowed to change inventory in this workspace'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NULLIF(pg_catalog.btrim(p_operation_kind), '') IS NULL
    OR pg_catalog.length(p_operation_kind) > 80
  THEN
    RAISE EXCEPTION 'Inventory operation kind is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_changes IS NULL
    OR pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(p_changes) = 0
  THEN
    RAISE EXCEPTION 'Inventory changes must be a non-empty array'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_array_length(p_changes) > 1000 THEN
    RAISE EXCEPTION 'Inventory changes exceed the maximum batch size'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_changes) AS changes(change)
    WHERE pg_catalog.jsonb_typeof(change) = 'object'
      AND NULLIF(pg_catalog.btrim(change->>'product_id'), '') IS NOT NULL
      AND NULLIF(pg_catalog.btrim(change->>'storage_id'), '') IS NOT NULL
    GROUP BY
      pg_catalog.btrim(change->>'product_id'),
      pg_catalog.btrim(change->>'storage_id')
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Inventory changes contain duplicate product and storage positions'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize all attempts for the same business operation before checking its
  -- receipt. A concurrent retry therefore observes the first committed result.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-operation:' || p_operation_id::text, 0)
  );

  IF p_operation_kind = 'sales_order_completion' THEN
    SELECT *
    INTO v_existing_receipt
    FROM private.inventory_snapshot_receipts
    WHERE operation_id = p_operation_id;

    IF FOUND THEN
      IF v_existing_receipt.workspace_id IS DISTINCT FROM p_workspace_id
        OR v_existing_receipt.operation_kind IS DISTINCT FROM p_operation_kind
      THEN
        RAISE EXCEPTION 'Inventory operation id is already used by another operation'
          USING ERRCODE = '23505';
      END IF;

      -- A retry after a lost response may have rehydrated the already-reduced
      -- stock and consequently rebuilt a different snapshot payload. The order
      -- id still identifies the same one-time business operation, so return the
      -- original rows instead of applying or rejecting a second deduction.
      RETURN v_existing_receipt.result
        || pg_catalog.jsonb_build_object('already_applied', true);
    END IF;
  END IF;

  RETURN private.apply_inventory_snapshot_changes_once(
    p_operation_id,
    p_workspace_id,
    p_operation_kind,
    p_changes
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION private.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb) IS
  'Validates and serializes strict inventory CAS writes; sales-order completion ids replay their first committed result.';

COMMENT ON FUNCTION private.apply_inventory_snapshot_changes_once(uuid, uuid, text, jsonb) IS
  'Private strict inventory compare-and-set implementation. Call through private.apply_inventory_snapshot_changes.';

COMMENT ON FUNCTION public.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb) IS
  'Idempotent strict inventory snapshot RPC. Stable sales-order completion ids replay once without weakening version checks.';
