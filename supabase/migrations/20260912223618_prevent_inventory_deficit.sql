-- Prevent every new inventory deficit without touching historical negative
-- rows. Historical rows may stay unchanged or move toward zero until the
-- operator finishes the manual cleanup; they can never become more negative.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.guard_nonnegative_quantity_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_old_quantity numeric;
  v_new_quantity numeric;
BEGIN
  v_new_quantity := NEW.quantity;

  IF v_new_quantity IS NULL
    OR v_new_quantity::text IN ('NaN', 'Infinity', '-Infinity')
  THEN
    RAISE EXCEPTION 'Inventory quantity must be a finite number'
      USING ERRCODE = '23514',
            CONSTRAINT = TG_TABLE_NAME || '_quantity_finite';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_quantity < 0 THEN
      RAISE EXCEPTION 'Inventory quantity cannot be negative'
        USING ERRCODE = '23514',
              CONSTRAINT = TG_TABLE_NAME || '_quantity_nonnegative';
    END IF;
    RETURN NEW;
  END IF;

  v_old_quantity := OLD.quantity;

  -- A legacy invalid/non-finite value may only be replaced by a finite value.
  IF v_old_quantity IS NULL
    OR v_old_quantity::text IN ('NaN', 'Infinity', '-Infinity')
  THEN
    RETURN NEW;
  END IF;

  IF v_old_quantity < 0 THEN
    IF v_new_quantity < v_old_quantity THEN
      RAISE EXCEPTION 'A legacy inventory deficit cannot be increased'
        USING ERRCODE = '23514',
              CONSTRAINT = TG_TABLE_NAME || '_quantity_legacy_not_worsened';
    END IF;
  ELSIF v_new_quantity < 0 THEN
    RAISE EXCEPTION 'Inventory quantity cannot be negative'
      USING ERRCODE = '23514',
            CONSTRAINT = TG_TABLE_NAME || '_quantity_nonnegative';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_nonnegative_quantity_transition() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inventory_prevent_deficit ON public.inventory;
CREATE TRIGGER inventory_prevent_deficit
BEFORE INSERT OR UPDATE OF quantity ON public.inventory
FOR EACH ROW
EXECUTE FUNCTION private.guard_nonnegative_quantity_transition();

DROP TRIGGER IF EXISTS products_prevent_deficit_snapshot ON public.products;
CREATE TRIGGER products_prevent_deficit_snapshot
BEFORE INSERT OR UPDATE OF quantity ON public.products
FOR EACH ROW
EXECUTE FUNCTION private.guard_nonnegative_quantity_transition();

-- Idempotency receipts live outside the exposed API schema. They make an
-- uncertain network retry return its original result instead of applying a
-- stock snapshot twice.
CREATE TABLE IF NOT EXISTS private.inventory_snapshot_receipts (
  operation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_kind text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE private.inventory_snapshot_receipts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS inventory_snapshot_receipts_workspace_created_idx
  ON private.inventory_snapshot_receipts (workspace_id, created_at DESC);

REVOKE ALL ON TABLE private.inventory_snapshot_receipts FROM PUBLIC, anon, authenticated;

-- This is the only client-facing compatibility path for snapshot-style
-- inventory writes. Each position is compare-and-set by server version, so a
-- stale device cannot overwrite a concurrent sale, return, or transfer.
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
  v_payload_hash text;
  v_existing_receipt private.inventory_snapshot_receipts%ROWTYPE;
  v_change jsonb;
  v_product_id uuid;
  v_storage_id uuid;
  v_requested_id uuid;
  v_expected_version integer;
  v_current_version integer;
  v_current_quantity numeric;
  v_next_quantity numeric;
  v_inventory public.inventory%ROWTYPE;
  v_rows jsonb := '[]'::jsonb;
  v_result jsonb;
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

  v_payload_hash := pg_catalog.md5(
    p_workspace_id::text || ':' || p_operation_kind || ':' || p_changes::text
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('inventory-operation:' || p_operation_id::text, 0)
  );

  SELECT *
  INTO v_existing_receipt
  FROM private.inventory_snapshot_receipts
  WHERE operation_id = p_operation_id;

  IF FOUND THEN
    IF v_existing_receipt.workspace_id IS DISTINCT FROM p_workspace_id
      OR v_existing_receipt.operation_kind IS DISTINCT FROM p_operation_kind
      OR v_existing_receipt.payload_hash IS DISTINCT FROM v_payload_hash
    THEN
      RAISE EXCEPTION 'Inventory operation id is already used by another payload'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_receipt.result || pg_catalog.jsonb_build_object('already_applied', true);
  END IF;

  -- Sorting is mandatory: concurrent multi-position operations acquire locks
  -- in the same order and therefore cannot deadlock each other.
  FOR v_change IN
    SELECT change
    FROM pg_catalog.jsonb_array_elements(p_changes) AS changes(change)
    ORDER BY change->>'product_id', change->>'storage_id'
  LOOP
    IF pg_catalog.jsonb_typeof(v_change) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Each inventory change must be an object'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_product_id := NULLIF(pg_catalog.btrim(v_change->>'product_id'), '')::uuid;
      v_storage_id := NULLIF(pg_catalog.btrim(v_change->>'storage_id'), '')::uuid;
      v_requested_id := COALESCE(
        NULLIF(pg_catalog.btrim(v_change->>'id'), '')::uuid,
        pg_catalog.gen_random_uuid()
      );
      v_expected_version := COALESCE((v_change->>'expected_version')::integer, 0);
      v_next_quantity := pg_catalog.round((v_change->>'quantity')::numeric, 6);
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Inventory change contains an invalid identifier, version, or quantity'
          USING ERRCODE = '22023';
    END;

    IF v_product_id IS NULL OR v_storage_id IS NULL
      OR v_expected_version < 0
      OR v_next_quantity IS NULL
      OR v_next_quantity::text IN ('NaN', 'Infinity', '-Infinity')
    THEN
      RAISE EXCEPTION 'Inventory change identifiers, version, and finite quantity are required'
        USING ERRCODE = '22023';
    END IF;

    PERFORM 1
    FROM public.products
    WHERE id = v_product_id
      AND workspace_id = p_workspace_id
      AND (
        v_next_quantity = 0
        OR (
          COALESCE(is_deleted, false) = false
          AND COALESCE(is_service, false) = false
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inventory product is not active in this workspace'
        USING ERRCODE = '23503';
    END IF;

    PERFORM 1
    FROM public.storages
    WHERE id = v_storage_id
      AND workspace_id = p_workspace_id
      AND COALESCE(is_deleted, false) = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inventory storage is not active in this workspace'
        USING ERRCODE = '23503';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'inventory:' || p_workspace_id::text || ':' || v_product_id::text || ':' || v_storage_id::text,
        0
      )
    );

    SELECT *
    INTO v_inventory
    FROM public.inventory
    WHERE workspace_id = p_workspace_id
      AND product_id = v_product_id
      AND storage_id = v_storage_id
    FOR UPDATE;

    IF FOUND THEN
      v_current_version := COALESCE(v_inventory.version, 0);
      v_current_quantity := v_inventory.quantity;
    ELSE
      v_current_version := 0;
      v_current_quantity := 0;
    END IF;

    IF v_current_version IS DISTINCT FROM v_expected_version THEN
      RAISE EXCEPTION 'Inventory changed on another device; refresh and retry'
        USING ERRCODE = '40001';
    END IF;

    IF v_next_quantity < 0
      AND NOT (v_current_quantity < 0 AND v_next_quantity >= v_current_quantity)
    THEN
      RAISE EXCEPTION 'Inventory quantity cannot be negative'
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.inventory (
      id,
      workspace_id,
      product_id,
      storage_id,
      quantity,
      created_at,
      updated_at,
      version,
      is_deleted
    )
    VALUES (
      v_requested_id,
      p_workspace_id,
      v_product_id,
      v_storage_id,
      v_next_quantity,
      pg_catalog.now(),
      pg_catalog.now(),
      v_current_version + 1,
      v_next_quantity = 0
    )
    ON CONFLICT (workspace_id, product_id, storage_id)
    DO UPDATE SET
      quantity = EXCLUDED.quantity,
      updated_at = pg_catalog.now(),
      version = v_current_version + 1,
      is_deleted = EXCLUDED.is_deleted
    RETURNING * INTO v_inventory;

    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_inventory));
  END LOOP;

  v_result := pg_catalog.jsonb_build_object(
    'operation_id', p_operation_id,
    'inventory', v_rows,
    'already_applied', false
  );

  INSERT INTO private.inventory_snapshot_receipts (
    operation_id,
    workspace_id,
    operation_kind,
    payload_hash,
    result,
    actor_id
  )
  VALUES (
    p_operation_id,
    p_workspace_id,
    p_operation_kind,
    v_payload_hash,
    v_result,
    auth.uid()
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION private.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_inventory_snapshot_changes(
  p_operation_id uuid,
  p_workspace_id uuid,
  p_operation_kind text,
  p_changes jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.apply_inventory_snapshot_changes(
    p_operation_id,
    p_workspace_id,
    p_operation_kind,
    p_changes
  );
$function$;

REVOKE ALL ON FUNCTION public.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb)
  TO authenticated, service_role;

-- Keep the large, battle-tested checkout body private and put a small
-- idempotent API wrapper in front of it. A retry with the same sale id returns
-- the committed result; a different sale id remains a different operation.
ALTER FUNCTION public.complete_sale(jsonb) SET SCHEMA private;
ALTER FUNCTION private.complete_sale(jsonb) RENAME TO complete_sale_once;
ALTER FUNCTION private.complete_sale_once(jsonb) SET search_path = '';
REVOKE ALL ON FUNCTION private.complete_sale_once(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.complete_sale_once(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_sale(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_sale_id uuid;
  v_existing record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_sale_id := NULLIF(pg_catalog.btrim(payload->>'id'), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Sale id is invalid'
        USING ERRCODE = '22023';
  END;

  IF v_sale_id IS NOT NULL THEN
    SELECT id, sequence_id, system_verified, system_review_status, system_review_reason
    INTO v_existing
    FROM public.sales
    WHERE id = v_sale_id;

    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'sale_id', v_existing.id,
        'sequence_id', v_existing.sequence_id,
        'system_verified', v_existing.system_verified,
        'system_review_status', v_existing.system_review_status,
        'system_review_reason', v_existing.system_review_reason,
        'already_applied', true
      );
    END IF;
  END IF;

  BEGIN
    RETURN private.complete_sale_once(payload);
  EXCEPTION
    WHEN unique_violation THEN
      IF v_sale_id IS NULL THEN
        RAISE;
      END IF;

      SELECT id, sequence_id, system_verified, system_review_status, system_review_reason
      INTO v_existing
      FROM public.sales
      WHERE id = v_sale_id;

      IF NOT FOUND THEN
        RAISE;
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'sale_id', v_existing.id,
        'sequence_id', v_existing.sequence_id,
        'system_verified', v_existing.system_verified,
        'system_review_status', v_existing.system_review_status,
        'system_review_reason', v_existing.system_review_reason,
        'already_applied', true
      );
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_sale(jsonb) TO authenticated, service_role;

-- Phase A intentionally preserves the existing inventory table grants and RLS
-- policies so older installed clients continue to function during rollout.
-- The transition trigger still rejects every new or worsened deficit. Direct
-- writes can be revoked in a later migration after all clients use the RPC.

COMMENT ON FUNCTION public.apply_inventory_snapshot_changes(uuid, uuid, text, jsonb) IS
  'Idempotent, version-checked inventory snapshot compatibility RPC. Rejects stale writes and every new or worsened deficit.';

COMMENT ON FUNCTION public.complete_sale(jsonb) IS
  'Idempotent POS checkout wrapper. Reusing payload.id returns the original committed sale result.';
