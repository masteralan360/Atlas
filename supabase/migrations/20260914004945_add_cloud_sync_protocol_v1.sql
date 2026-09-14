-- Atlas Cloud Sync protocol v1.
--
-- This migration deliberately leaves the legacy table grants in place. A
-- workspace opts into the RPC protocol only after its client has durably
-- migrated the local replica/outbox and calls the activation RPC below.

CREATE SCHEMA IF NOT EXISTS private;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- `cloud` may remain in an older enum type, but it is no longer a valid stored
-- mode. The BEFORE trigger below translates an old-client write to `hybrid`
-- before this constraint is evaluated.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS sync_protocol_version integer NOT NULL DEFAULT 0;

UPDATE public.workspaces
SET data_mode = 'hybrid'
WHERE data_mode::text = 'cloud';

ALTER TABLE public.workspaces
  ALTER COLUMN data_mode SET DEFAULT 'hybrid';

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_data_mode_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_data_mode_check
  CHECK (
    data_mode::text = ANY (
      ARRAY['hybrid'::text, 'local'::text, 'demo'::text]
    )
  );

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_sync_protocol_version_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_sync_protocol_version_check
  CHECK (sync_protocol_version BETWEEN 0 AND 1);

COMMENT ON COLUMN public.workspaces.sync_protocol_version IS
  '0 keeps the legacy direct-write sync path; 1 enables the SQLite-outbox RPC/change-feed protocol after explicit workspace cutover.';

CREATE OR REPLACE FUNCTION private.atlas_normalize_workspace_data_mode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.data_mode IS NULL OR NEW.data_mode::text = 'cloud' THEN
    NEW.data_mode := 'hybrid';
  END IF;

  IF NEW.data_mode::text <> 'hybrid' THEN
    NEW.sync_protocol_version := 0;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_normalize_workspace_data_mode()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS atlas_normalize_workspace_data_mode
  ON public.workspaces;
CREATE TRIGGER atlas_normalize_workspace_data_mode
BEFORE INSERT OR UPDATE OF data_mode ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION private.atlas_normalize_workspace_data_mode();

-- Authenticated clients cannot change the protocol version while rollout is
-- locked. Do not trust a custom GUC as an internal bypass: PostgreSQL custom
-- settings are session-controlled and therefore are not an authorization
-- boundary. While rollout is incomplete, only migration-owner maintenance is
-- allowed to stage version-one data for verification.
CREATE OR REPLACE FUNCTION private.atlas_guard_sync_protocol_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated', 'service_role') THEN
    IF TG_OP = 'INSERT' AND COALESCE(NEW.sync_protocol_version, 0) <> 0 THEN
      RAISE EXCEPTION 'Sync protocol version must be changed through the activation RPC'
        USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE'
      AND NEW.sync_protocol_version IS DISTINCT FROM OLD.sync_protocol_version
    THEN
      RAISE EXCEPTION 'Sync protocol version must be changed through the activation RPC'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_guard_sync_protocol_version()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS atlas_guard_sync_protocol_version
  ON public.workspaces;
CREATE TRIGGER atlas_guard_sync_protocol_version
BEFORE INSERT OR UPDATE OF sync_protocol_version ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION private.atlas_guard_sync_protocol_version();

-- Only relations in this private registry can be addressed by the generic
-- entity dispatcher. Relation identifiers and writable columns are never
-- accepted from a client.
CREATE TABLE IF NOT EXISTS private.atlas_sync_entity_registry (
  entity_type text PRIMARY KEY,
  relation regclass NOT NULL UNIQUE,
  payload_schema_version integer NOT NULL DEFAULT 1,
  writable_columns text[] NOT NULL,
  allowed_roles text[] NOT NULL DEFAULT ARRAY['admin', 'staff']::text[],
  required_capability text NULL,
  enabled boolean NOT NULL DEFAULT true,
  CONSTRAINT atlas_sync_entity_registry_entity_type_check
    CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,79}$'),
  CONSTRAINT atlas_sync_entity_registry_payload_schema_check
    CHECK (payload_schema_version > 0),
  CONSTRAINT atlas_sync_entity_registry_columns_check
    CHECK (COALESCE(pg_catalog.array_length(writable_columns, 1), 0) > 0),
  CONSTRAINT atlas_sync_entity_registry_roles_check
    CHECK (COALESCE(pg_catalog.array_length(allowed_roles, 1), 0) > 0)
);

ALTER TABLE private.atlas_sync_entity_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.atlas_sync_entity_registry
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE private.atlas_sync_entity_registry
  TO service_role;

INSERT INTO private.atlas_sync_entity_registry (
  entity_type,
  relation,
  payload_schema_version,
  writable_columns,
  allowed_roles,
  required_capability
)
VALUES
  (
    'categories',
    'public.categories'::regclass,
    1,
    ARRAY['name', 'description']::text[],
    ARRAY['admin', 'staff']::text[],
    NULL
  ),
  (
    'units',
    'public.units'::regclass,
    1,
    ARRAY['code', 'icon', 'is_dynamic']::text[],
    ARRAY['admin', 'staff']::text[],
    NULL
  ),
  (
    'product_barcodes',
    'public.product_barcodes'::regclass,
    1,
    ARRAY['product_id', 'barcode', 'label', 'is_primary']::text[],
    ARRAY['admin', 'staff']::text[],
    NULL
  ),
  (
    'price_books',
    'public.price_books'::regclass,
    1,
    ARRAY['name', 'save_warn']::text[],
    ARRAY['admin', 'staff']::text[],
    'priceBooks'
  ),
  (
    'price_book_items',
    'public.price_book_items'::regclass,
    1,
    ARRAY['price_book_id', 'product_id', 'cost_price', 'price', 'currency']::text[],
    ARRAY['admin', 'staff']::text[],
    'priceBooks'
  ),
  (
    'product_discounts',
    'public.product_discounts'::regclass,
    1,
    ARRAY[
      'product_id',
      'discount_type',
      'discount_value',
      'starts_at',
      'ends_at',
      'min_stock_threshold',
      'is_active',
      'price_scope',
      'price_book_ids',
      'discount_currency'
    ]::text[],
    ARRAY['admin', 'staff']::text[],
    NULL
  ),
  (
    'category_discounts',
    'public.category_discounts'::regclass,
    1,
    ARRAY[
      'category_id',
      'discount_type',
      'discount_value',
      'starts_at',
      'ends_at',
      'min_stock_threshold',
      'is_active'
    ]::text[],
    ARRAY['admin', 'staff']::text[],
    NULL
  ),
  (
    'reorder_transfer_rules',
    'public.reorder_transfer_rules'::regclass,
    1,
    ARRAY[
      'product_id',
      'source_storage_id',
      'destination_storage_id',
      'min_stock_level',
      'transfer_quantity',
      'expires_on',
      'is_indefinite'
    ]::text[],
    ARRAY['admin', 'staff']::text[],
    NULL
  )
ON CONFLICT (entity_type) DO UPDATE
SET
  relation = EXCLUDED.relation,
  payload_schema_version = EXCLUDED.payload_schema_version,
  writable_columns = EXCLUDED.writable_columns,
  allowed_roles = EXCLUDED.allowed_roles,
  required_capability = EXCLUDED.required_capability,
  enabled = true;

CREATE TABLE IF NOT EXISTS private.atlas_mutation_receipts (
  workspace_id uuid NOT NULL
    REFERENCES public.workspaces(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  protocol_version integer NOT NULL,
  mutation_type text NOT NULL,
  entity_type text NULL,
  entity_id uuid NULL,
  payload_schema_version integer NOT NULL,
  base_version bigint NULL,
  payload_hash text NOT NULL,
  status text NOT NULL,
  server_version bigint NULL,
  change_seq bigint NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (workspace_id, mutation_id),
  CONSTRAINT atlas_mutation_receipts_protocol_check
    CHECK (protocol_version > 0),
  CONSTRAINT atlas_mutation_receipts_payload_schema_check
    CHECK (payload_schema_version > 0),
  CONSTRAINT atlas_mutation_receipts_base_version_check
    CHECK (base_version IS NULL OR base_version >= 0),
  CONSTRAINT atlas_mutation_receipts_hash_check
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT atlas_mutation_receipts_status_check
    CHECK (status IN ('acknowledged', 'conflict', 'rejected')),
  CONSTRAINT atlas_mutation_receipts_response_check
    CHECK (pg_catalog.jsonb_typeof(response) = 'object')
);

ALTER TABLE private.atlas_mutation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.atlas_mutation_receipts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE private.atlas_mutation_receipts
  TO service_role;

CREATE INDEX IF NOT EXISTS atlas_mutation_receipts_workspace_created_idx
  ON private.atlas_mutation_receipts (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS private.atlas_workspace_change_counters (
  workspace_id uuid PRIMARY KEY
    REFERENCES public.workspaces(id) ON DELETE CASCADE,
  last_change_seq bigint NOT NULL DEFAULT 0,
  first_retained_seq bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT atlas_workspace_change_counters_last_check
    CHECK (last_change_seq >= 0),
  CONSTRAINT atlas_workspace_change_counters_first_check
    CHECK (
      first_retained_seq >= 1
      AND first_retained_seq <= last_change_seq + 1
    )
);

ALTER TABLE private.atlas_workspace_change_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.atlas_workspace_change_counters
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE private.atlas_workspace_change_counters TO service_role;

CREATE TABLE IF NOT EXISTS private.atlas_workspace_change_log (
  workspace_id uuid NOT NULL
    REFERENCES public.workspaces(id) ON DELETE CASCADE,
  change_seq bigint NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  operation text NOT NULL,
  entity_version bigint NOT NULL,
  payload jsonb NOT NULL,
  mutation_id uuid NULL,
  actor_id uuid NULL,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (workspace_id, change_seq),
  CONSTRAINT atlas_workspace_change_log_seq_check
    CHECK (change_seq > 0),
  CONSTRAINT atlas_workspace_change_log_operation_check
    CHECK (operation IN ('upsert', 'delete')),
  CONSTRAINT atlas_workspace_change_log_version_check
    CHECK (entity_version >= 0),
  CONSTRAINT atlas_workspace_change_log_payload_check
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

ALTER TABLE private.atlas_workspace_change_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.atlas_workspace_change_log
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE private.atlas_workspace_change_log TO service_role;

-- One business command may legitimately update several allowlisted rows. The
-- mutation id is therefore a lookup/correlation key, not a uniqueness key.
DROP INDEX IF EXISTS private.atlas_workspace_change_log_mutation_idx;
CREATE INDEX atlas_workspace_change_log_mutation_idx
  ON private.atlas_workspace_change_log (
    workspace_id,
    mutation_id,
    entity_type,
    entity_id,
    change_seq
  )
  WHERE mutation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS atlas_workspace_change_log_retention_idx
  ON private.atlas_workspace_change_log (changed_at, workspace_id, change_seq);

-- The client sends compact, recursively key-sorted JSON as payload_canonical.
-- Hashing those exact UTF-8 bytes avoids PostgreSQL jsonb rendering differences
-- from JavaScript JSON.stringify. The mutation gateway separately parses this
-- text and asserts that it is semantically equal to `payload`.
CREATE OR REPLACE FUNCTION private.atlas_sync_payload_hash(
  p_payload_canonical text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_payload_canonical, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$function$;

REVOKE ALL ON FUNCTION private.atlas_sync_payload_hash(text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.atlas_sync_payload_hash(
  p_payload_canonical text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.atlas_sync_payload_hash(p_payload_canonical);
$function$;

REVOKE ALL ON FUNCTION public.atlas_sync_payload_hash(text)
  FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.atlas_sync_payload_hash(text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.atlas_sync_payload_hash(text)
  TO authenticated, service_role;

-- Captures both protocol writes and compatibility-window direct writes for the
-- allowlisted entity set. Only protocol writes carry mutation_id.
CREATE OR REPLACE FUNCTION private.atlas_capture_sync_entity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_registry private.atlas_sync_entity_registry%ROWTYPE;
  v_row jsonb;
  v_workspace_id uuid;
  v_entity_id uuid;
  v_entity_version bigint;
  v_operation text;
  v_mutation_id uuid;
  v_actor_id uuid;
  v_change_seq bigint;
  v_setting text;
BEGIN
  SELECT registry.*
  INTO v_registry
  FROM private.atlas_sync_entity_registry AS registry
  WHERE registry.relation = TG_RELID
    AND registry.enabled;

  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  v_row := CASE
    WHEN TG_OP = 'DELETE' THEN pg_catalog.to_jsonb(OLD)
    ELSE pg_catalog.to_jsonb(NEW)
  END;

  v_workspace_id := NULLIF(v_row->>'workspace_id', '')::uuid;
  v_entity_id := NULLIF(v_row->>'id', '')::uuid;
  v_entity_version := COALESCE(NULLIF(v_row->>'version', '')::bigint, 0);
  v_operation := CASE
    WHEN TG_OP = 'DELETE' OR COALESCE((v_row->>'is_deleted')::boolean, false)
      THEN 'delete'
    ELSE 'upsert'
  END;

  v_setting := NULLIF(
    pg_catalog.current_setting('atlas.sync_mutation_id', true),
    ''
  );
  IF v_setting IS NOT NULL THEN
    v_mutation_id := v_setting::uuid;
  END IF;

  v_setting := NULLIF(
    pg_catalog.current_setting('atlas.sync_actor_id', true),
    ''
  );
  IF v_setting IS NOT NULL THEN
    v_actor_id := v_setting::uuid;
  ELSE
    v_actor_id := auth.uid();
  END IF;

  INSERT INTO private.atlas_workspace_change_counters AS counter (
    workspace_id,
    last_change_seq,
    first_retained_seq,
    updated_at
  )
  VALUES (v_workspace_id, 1, 1, pg_catalog.now())
  ON CONFLICT (workspace_id) DO UPDATE
  SET
    last_change_seq = counter.last_change_seq + 1,
    updated_at = pg_catalog.now()
  RETURNING last_change_seq INTO v_change_seq;

  INSERT INTO private.atlas_workspace_change_log (
    workspace_id,
    change_seq,
    entity_type,
    entity_id,
    operation,
    entity_version,
    payload,
    mutation_id,
    actor_id
  )
  VALUES (
    v_workspace_id,
    v_change_seq,
    v_registry.entity_type,
    v_entity_id,
    v_operation,
    v_entity_version,
    v_row,
    v_mutation_id,
    v_actor_id
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_capture_sync_entity_change()
  FROM PUBLIC, anon, authenticated;

DO $block$
DECLARE
  v_registry record;
BEGIN
  FOR v_registry IN
    SELECT
      namespace.nspname AS schema_name,
      class.relname AS table_name
    FROM private.atlas_sync_entity_registry AS registry
    JOIN pg_catalog.pg_class AS class
      ON class.oid = registry.relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = class.relnamespace
    WHERE registry.enabled
  LOOP
    EXECUTE pg_catalog.format(
      'DROP TRIGGER IF EXISTS atlas_capture_sync_change ON %I.%I',
      v_registry.schema_name,
      v_registry.table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER atlas_capture_sync_change '
        || 'AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION private.atlas_capture_sync_entity_change()',
      v_registry.schema_name,
      v_registry.table_name
    );
  END LOOP;
END;
$block$;

-- Returns a typed relationship error, or NULL when the effective entity
-- snapshot is workspace-safe. Database constraints still enforce domain
-- details such as nonblank names, positive values, and date ranges.
CREATE OR REPLACE FUNCTION private.atlas_validate_sync_entity_relationships(
  p_entity_type text,
  p_workspace_id uuid,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_product_id uuid;
  v_category_id uuid;
  v_price_book_id uuid;
  v_source_storage_id uuid;
  v_destination_storage_id uuid;
BEGIN
  IF p_entity_type IN (
    'product_barcodes',
    'price_book_items',
    'product_discounts',
    'reorder_transfer_rules'
  ) THEN
    v_product_id := NULLIF(p_payload->>'product_id', '')::uuid;
    IF v_product_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.id = v_product_id
        AND product.workspace_id = p_workspace_id
        AND NOT COALESCE(product.is_deleted, false)
    ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'code', 'related_product_not_found',
        'message', 'The related product is not active in this workspace',
        'retryable', false
      );
    END IF;
  END IF;

  IF p_entity_type = 'category_discounts' THEN
    v_category_id := NULLIF(p_payload->>'category_id', '')::uuid;
    IF v_category_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.categories AS category
      WHERE category.id = v_category_id
        AND category.workspace_id = p_workspace_id
        AND NOT COALESCE(category.is_deleted, false)
    ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'code', 'related_category_not_found',
        'message', 'The related category is not active in this workspace',
        'retryable', false
      );
    END IF;
  END IF;

  IF p_entity_type = 'price_book_items' THEN
    v_price_book_id := NULLIF(p_payload->>'price_book_id', '')::uuid;
    IF v_price_book_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.price_books AS price_book
      WHERE price_book.id = v_price_book_id
        AND price_book.workspace_id = p_workspace_id
        AND NOT price_book.is_deleted
    ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'code', 'related_price_book_not_found',
        'message', 'The related Price Book is not active in this workspace',
        'retryable', false
      );
    END IF;
  END IF;

  IF p_entity_type = 'reorder_transfer_rules' THEN
    v_source_storage_id := NULLIF(p_payload->>'source_storage_id', '')::uuid;
    v_destination_storage_id := NULLIF(p_payload->>'destination_storage_id', '')::uuid;

    IF v_source_storage_id IS NULL
      OR v_destination_storage_id IS NULL
      OR v_source_storage_id = v_destination_storage_id
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'code', 'invalid_storage_route',
        'message', 'Source and destination storages must be different',
        'retryable', false
      );
    END IF;

    IF (
      SELECT pg_catalog.count(*)
      FROM public.storages AS storage
      WHERE storage.id IN (v_source_storage_id, v_destination_storage_id)
        AND storage.workspace_id = p_workspace_id
        AND NOT COALESCE(storage.is_deleted, false)
    ) <> 2 THEN
      RETURN pg_catalog.jsonb_build_object(
        'code', 'related_storage_not_found',
        'message', 'Both storages must be active in this workspace',
        'retryable', false
      );
    END IF;
  END IF;

  RETURN NULL;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN pg_catalog.jsonb_build_object(
      'code', 'invalid_payload',
      'message', 'The mutation payload contains an invalid identifier or value',
      'retryable', false
    );
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_validate_sync_entity_relationships(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.atlas_get_workspace_offline_entitlement(
  p_workspace_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_server_verified_at timestamptz := pg_catalog.statement_timestamp();
  v_current_workspace_id uuid := public.current_workspace_id();
  v_has_usage_limits boolean := false;
  v_payment_summary jsonb := '{}'::jsonb;
  v_locked_workspace boolean;
  v_subscription_expires_at timestamptz;
  v_renewal_due_at timestamptz;
  v_payment_access_locked boolean := false;
BEGIN
  -- This snapshot authorizes offline access, so it must only ever describe the
  -- workspace selected by the authenticated profile. In particular, do not
  -- accept a workspace id from JWT metadata as proof of membership.
  IF auth.uid() IS NULL
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM v_current_workspace_id
  THEN
    RAISE EXCEPTION 'workspace_access_denied' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace_row
    WHERE workspace_row.id = p_workspace_id
      AND workspace_row.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'workspace_access_denied' USING ERRCODE = '42501';
  END IF;

  -- These existing gateways own usage/payment reconciliation. Calling them
  -- here keeps the offline decision aligned with the online lock decision and
  -- avoids a second, subtly different billing implementation.
  SELECT COALESCE(usage_status.has_limits, false)
  INTO v_has_usage_limits
  FROM public.get_workspace_usage_status(p_workspace_id) AS usage_status
  LIMIT 1;

  v_has_usage_limits := COALESCE(v_has_usage_limits, false);
  v_payment_summary := COALESCE(
    public.get_workspace_payment_summary(),
    '{}'::jsonb
  );

  SELECT
    COALESCE(workspace_row.locked_workspace, false),
    workspace_row.subscription_expires_at
  INTO
    v_locked_workspace,
    v_subscription_expires_at
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = p_workspace_id
    AND workspace_row.deleted_at IS NULL;

  BEGIN
    v_renewal_due_at := NULLIF(
      v_payment_summary#>>'{configuration,renewal_due_at}',
      ''
    )::timestamptz;
  EXCEPTION
    WHEN invalid_datetime_format THEN
      -- Billing configuration is server-owned. Treat malformed legacy data as
      -- unavailable rather than issuing an unverifiable offline deadline.
      v_renewal_due_at := NULL;
  END;

  v_payment_access_locked :=
    COALESCE((v_payment_summary#>>'{eligibility,subscription_expired}')::boolean, false)
    OR COALESCE((v_payment_summary#>>'{eligibility,usage_exhausted}')::boolean, false)
    OR COALESCE((v_payment_summary#>>'{eligibility,usage_renewal_due}')::boolean, false)
    OR COALESCE(v_payment_summary#>>'{eligibility,alert_reason}', '') IN (
      'subscription_expired',
      'usage_exhausted',
      'usage_renewal_due'
    )
    OR (
      v_has_usage_limits
      AND v_renewal_due_at IS NOT NULL
      AND v_renewal_due_at <= v_server_verified_at
    )
    OR (
      NOT v_has_usage_limits
      AND v_subscription_expires_at IS NOT NULL
      AND v_subscription_expires_at <= v_server_verified_at
    );

  RETURN pg_catalog.jsonb_build_object(
    'workspace_id', p_workspace_id,
    'server_verified_at', v_server_verified_at,
    'locked_workspace', COALESCE(v_locked_workspace, false),
    'subscription_expires_at', v_subscription_expires_at,
    'renewal_due_at', v_renewal_due_at,
    'has_usage_limits', v_has_usage_limits,
    'payment_access_locked', v_payment_access_locked
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_get_workspace_offline_entitlement(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.atlas_get_workspace_offline_entitlement(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.atlas_get_workspace_offline_entitlement(
  p_workspace_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.atlas_get_workspace_offline_entitlement(p_workspace_id);
$function$;

REVOKE ALL ON FUNCTION public.atlas_get_workspace_offline_entitlement(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.atlas_get_workspace_offline_entitlement(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.atlas_activate_workspace_sync_protocol(
  p_workspace_id uuid,
  p_protocol_version integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_protocol_version <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'error', pg_catalog.jsonb_build_object(
        'code', 'protocol_version_unsupported',
        'message', 'Only Atlas sync protocol version 1 can be activated',
        'retryable', false
      )
    );
  END IF;

  -- Version one deliberately covers only the pilot entity allowlist and has
  -- no transactional command adapters. Enabling it for a workspace would
  -- route normal business workflows into deterministic rejections. This gate
  -- is unconditional, including for service_role; a later completeness
  -- migration must replace it before any workspace can opt in.
  RETURN pg_catalog.jsonb_build_object(
    'status', 'rejected',
    'workspace_id', p_workspace_id,
    'protocol_version', 0,
    'error', pg_catalog.jsonb_build_object(
      'code', 'rollout_incomplete',
      'message', 'Cloud Sync protocol v1 is not yet complete enough for workspace activation',
      'retryable', false
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_activate_workspace_sync_protocol(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.atlas_activate_workspace_sync_protocol(uuid, integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.atlas_activate_workspace_sync_protocol(
  p_workspace_id uuid,
  p_protocol_version integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.atlas_activate_workspace_sync_protocol(
    p_workspace_id,
    p_protocol_version
  );
$function$;

REVOKE ALL ON FUNCTION public.atlas_activate_workspace_sync_protocol(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atlas_activate_workspace_sync_protocol(uuid, integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.atlas_apply_sync_mutation(p_envelope jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_protocol_version integer;
  v_mutation_id uuid;
  v_workspace_id uuid;
  v_actor_id uuid;
  v_mutation_type text;
  v_entity_type text;
  v_entity_id uuid;
  v_payload_schema_version integer;
  v_base_version bigint;
  v_payload_hash text;
  v_payload_canonical text;
  v_payload jsonb;
  v_canonical_payload jsonb;
  v_computed_payload_hash text;
  v_request_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    auth.jwt()->>'role',
    ''
  );
  v_workspace_mode text;
  v_workspace_protocol integer;
  v_workspace_plan text;
  v_user_role text;
  v_existing_receipt private.atlas_mutation_receipts%ROWTYPE;
  v_registry private.atlas_sync_entity_registry%ROWTYPE;
  v_schema_name text;
  v_table_name text;
  v_relation_name text;
  v_unknown_keys text[];
  v_write_columns text;
  v_source_columns text;
  v_update_assignments text;
  v_write_payload jsonb;
  v_effective_payload jsonb;
  v_current_entity jsonb;
  v_current_version bigint;
  v_entity jsonb;
  v_server_version bigint;
  v_change_seq bigint;
  v_relationship_error jsonb;
  v_response jsonb;
  v_receipt_created_at timestamptz;
BEGIN
  IF p_envelope IS NULL
    OR pg_catalog.jsonb_typeof(p_envelope) IS DISTINCT FROM 'object'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'error', pg_catalog.jsonb_build_object(
        'code', 'invalid_envelope',
        'message', 'The sync envelope must be a JSON object',
        'retryable', false
      )
    );
  END IF;

  BEGIN
    v_protocol_version := NULLIF(p_envelope->>'protocol_version', '')::integer;
    v_mutation_id := NULLIF(p_envelope->>'mutation_id', '')::uuid;
    v_workspace_id := NULLIF(p_envelope->>'workspace_id', '')::uuid;
    v_actor_id := NULLIF(p_envelope->>'actor_id', '')::uuid;
    v_mutation_type := NULLIF(pg_catalog.btrim(p_envelope->>'mutation_type'), '');
    v_entity_type := NULLIF(pg_catalog.btrim(p_envelope->>'entity_type'), '');
    v_entity_id := NULLIF(p_envelope->>'entity_id', '')::uuid;
    v_payload_schema_version := NULLIF(
      p_envelope->>'payload_schema_version',
      ''
    )::integer;
    v_base_version := NULLIF(p_envelope->>'base_version', '')::bigint;
    v_payload_hash := pg_catalog.lower(
      NULLIF(pg_catalog.btrim(p_envelope->>'payload_hash'), '')
    );
    v_payload_canonical := p_envelope->>'payload_canonical';
    v_payload := COALESCE(p_envelope->'payload', '{}'::jsonb);
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'error', pg_catalog.jsonb_build_object(
          'code', 'invalid_envelope',
          'message', 'The sync envelope contains an invalid identifier or number',
          'retryable', false
        )
      );
  END;

  IF v_protocol_version IS NULL
    OR v_mutation_id IS NULL
    OR v_workspace_id IS NULL
    OR v_actor_id IS NULL
    OR v_mutation_type IS NULL
    OR v_payload_schema_version IS NULL
    OR v_payload_schema_version < 1
    OR v_payload_hash IS NULL
    OR v_payload_hash !~ '^[0-9a-f]{64}$'
    OR v_payload_canonical IS NULL
    OR pg_catalog.octet_length(v_payload_canonical) > 5242880
    OR pg_catalog.jsonb_typeof(v_payload) IS DISTINCT FROM 'object'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'invalid_envelope',
        'message', 'Required sync envelope fields are missing or invalid',
        'retryable', false
      )
    );
  END IF;

  IF v_protocol_version <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'protocol_version_unsupported',
        'message', 'This server does not support the requested sync protocol version',
        'retryable', false,
        'supported_versions', pg_catalog.jsonb_build_array(1)
      )
    );
  END IF;

  IF v_request_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'authentication_required',
          'message', 'Authentication is required',
          'retryable', false
        )
      );
    END IF;

    IF v_actor_id IS DISTINCT FROM auth.uid() THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'actor_mismatch',
          'message', 'The envelope actor does not match the authenticated user',
          'retryable', false
        )
      );
    END IF;

    IF v_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'workspace_access_denied',
          'message', 'The actor cannot mutate this workspace',
          'retryable', false
        )
      );
    END IF;
  END IF;

  SELECT
    workspace.data_mode::text,
    workspace.sync_protocol_version,
    workspace.plan::text
  INTO
    v_workspace_mode,
    v_workspace_protocol,
    v_workspace_plan
  FROM public.workspaces AS workspace
  WHERE workspace.id = v_workspace_id
    AND workspace.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'workspace_not_found',
        'message', 'The workspace is unavailable',
        'retryable', false
      )
    );
  END IF;

  IF v_workspace_mode <> 'hybrid' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'workspace_mode_unsupported',
        'message', 'The workspace does not use Cloud Sync',
        'retryable', false
      )
    );
  END IF;

  IF v_workspace_protocol <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'protocol_not_active',
        'message', 'The workspace has not completed Cloud Sync protocol activation',
        'retryable', true,
        'workspace_protocol_version', v_workspace_protocol
      )
    );
  END IF;

  BEGIN
    v_canonical_payload := v_payload_canonical::jsonb;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'invalid_payload_canonical',
          'message', 'The canonical payload is not valid JSON',
          'retryable', false
        )
      );
  END;

  IF v_canonical_payload IS DISTINCT FROM v_payload THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'payload_canonical_mismatch',
        'message', 'The canonical payload does not describe the supplied payload',
        'retryable', false
      )
    );
  END IF;

  v_computed_payload_hash := private.atlas_sync_payload_hash(v_payload_canonical);
  IF v_payload_hash IS DISTINCT FROM v_computed_payload_hash THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'payload_hash_mismatch',
        'message', 'The payload hash does not match the canonical payload',
        'retryable', false,
        'expected_payload_hash', v_computed_payload_hash
      )
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'atlas-sync-mutation:' || v_workspace_id::text || ':' || v_mutation_id::text,
      0
    )
  );

  SELECT receipt.*
  INTO v_existing_receipt
  FROM private.atlas_mutation_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.mutation_id = v_mutation_id;

  IF FOUND THEN
    IF v_existing_receipt.actor_id IS DISTINCT FROM v_actor_id
      OR v_existing_receipt.protocol_version IS DISTINCT FROM v_protocol_version
      OR v_existing_receipt.mutation_type IS DISTINCT FROM v_mutation_type
      OR v_existing_receipt.entity_type IS DISTINCT FROM v_entity_type
      OR v_existing_receipt.entity_id IS DISTINCT FROM v_entity_id
      OR v_existing_receipt.payload_schema_version IS DISTINCT FROM v_payload_schema_version
      OR v_existing_receipt.base_version IS DISTINCT FROM v_base_version
      OR v_existing_receipt.payload_hash IS DISTINCT FROM v_payload_hash
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'mutation_id_reused',
          'message', 'This mutation identifier is already bound to another envelope',
          'retryable', false
        )
      );
    END IF;

    RETURN pg_catalog.jsonb_set(
      v_existing_receipt.response,
      '{receipt,replayed}',
      'true'::jsonb,
      true
    );
  END IF;

  IF v_mutation_type LIKE 'command.%' THEN
    v_receipt_created_at := pg_catalog.now();
    v_response := pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'server_version', NULL,
      'change_seq', NULL,
      'receipt', pg_catalog.jsonb_build_object(
        'payload_hash', v_payload_hash,
        'actor_id', v_actor_id,
        'created_at', v_receipt_created_at,
        'replayed', false
      ),
      'result', NULL,
      'error', pg_catalog.jsonb_build_object(
        'code', 'unsupported_command',
        'message', 'This business command does not have a protocol v1 server adapter yet',
        'retryable', false,
        'command_type', v_mutation_type
      )
    );

    INSERT INTO private.atlas_mutation_receipts (
      workspace_id, mutation_id, actor_id, protocol_version, mutation_type,
      entity_type, entity_id, payload_schema_version, base_version,
      payload_hash, status, server_version, change_seq, response, created_at
    )
    VALUES (
      v_workspace_id, v_mutation_id, v_actor_id, v_protocol_version,
      v_mutation_type, v_entity_type, v_entity_id, v_payload_schema_version,
      v_base_version, v_payload_hash, 'rejected', NULL, NULL, v_response,
      v_receipt_created_at
    );
    RETURN v_response;
  END IF;

  IF v_mutation_type NOT IN ('entity.upsert', 'entity.delete')
    OR v_entity_type IS NULL
    OR v_entity_id IS NULL
    OR v_base_version < 0
    OR v_base_version > 2147483646
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'invalid_envelope',
        'message', 'Entity mutations require a type, identifier, and valid base version',
        'retryable', false
      )
    );
  END IF;

  IF v_base_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'base_version_required',
        'message', 'The mutation must be rebased against a confirmed server version before it can be applied',
        'retryable', true
      )
    );
  END IF;

  SELECT registry.*
  INTO v_registry
  FROM private.atlas_sync_entity_registry AS registry
  WHERE registry.entity_type = v_entity_type
    AND registry.enabled;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'entity_not_allowlisted',
        'message', 'This entity type does not have a safe protocol v1 adapter',
        'retryable', false,
        'entity_type', v_entity_type
      )
    );
  END IF;

  IF v_payload_schema_version <> v_registry.payload_schema_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'payload_schema_unsupported',
        'message', 'The entity payload schema version is unsupported',
        'retryable', false,
        'supported_payload_schema_version', v_registry.payload_schema_version
      )
    );
  END IF;

  -- Legacy callers used `hardDelete`, serialized as `hard_delete`, for a few
  -- entities whose visible behavior is equivalent to a tombstone. Protocol v1
  -- never physically deletes allowlisted business rows: normalize that marker
  -- away only for entity.delete, after the original canonical payload/hash has
  -- already been authenticated and bound to its receipt.
  IF v_mutation_type = 'entity.delete' AND v_payload ? 'hard_delete' THEN
    IF pg_catalog.jsonb_typeof(v_payload->'hard_delete') <> 'boolean' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'invalid_delete_payload',
          'message', 'The legacy hard-delete marker must be a boolean',
          'retryable', false
        )
      );
    END IF;
    v_payload := v_payload - 'hard_delete';
  END IF;

  IF v_request_role IS DISTINCT FROM 'service_role' THEN
    v_user_role := public.current_user_role();
    IF v_user_role IS NULL OR NOT (v_user_role = ANY(v_registry.allowed_roles)) THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'entity_permission_denied',
          'message', 'The actor cannot change this entity type',
          'retryable', false,
          'entity_type', v_entity_type
        )
      );
    END IF;

    IF v_registry.required_capability IS NOT NULL
      AND NOT public.workspace_capability_allowed(
        v_workspace_id,
        v_workspace_plan,
        v_registry.required_capability
      )
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'workspace_capability_required',
          'message', 'The workspace does not have the required capability',
          'retryable', false,
          'capability', v_registry.required_capability
        )
      );
    END IF;
  END IF;

  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_unknown_keys
  FROM pg_catalog.jsonb_object_keys(v_payload) AS payload_key(key_name)
  WHERE NOT (key_name = ANY(v_registry.writable_columns))
    AND NOT (
      key_name = ANY(
        ARRAY[
          'id', 'workspace_id', 'created_at', 'updated_at', 'created_by',
          'version', 'is_deleted', 'sync_status'
        ]::text[]
      )
    );

  IF COALESCE(pg_catalog.array_length(v_unknown_keys, 1), 0) > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'payload_field_not_allowlisted',
        'message', 'The payload contains fields that are not writable for this entity',
        'retryable', false,
        'fields', pg_catalog.to_jsonb(v_unknown_keys)
      )
    );
  END IF;

  BEGIN
    IF v_payload ? 'id'
      AND NULLIF(v_payload->>'id', '')::uuid IS DISTINCT FROM v_entity_id
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'entity_id_mismatch',
          'message', 'Payload and envelope entity identifiers differ',
          'retryable', false
        )
      );
    END IF;

    IF v_payload ? 'workspace_id'
      AND NULLIF(v_payload->>'workspace_id', '')::uuid IS DISTINCT FROM v_workspace_id
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'workspace_id_mismatch',
          'message', 'Payload and envelope workspace identifiers differ',
          'retryable', false
        )
      );
    END IF;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'error', pg_catalog.jsonb_build_object(
          'code', 'invalid_payload',
          'message', 'The payload contains an invalid identifier',
          'retryable', false
        )
      );
  END;

  SELECT namespace.nspname, class.relname
  INTO v_schema_name, v_table_name
  FROM pg_catalog.pg_class AS class
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = class.relnamespace
  WHERE class.oid = v_registry.relation
    AND class.relkind IN ('r', 'p');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Allowlisted Atlas sync relation is unavailable'
      USING ERRCODE = '55000';
  END IF;

  v_relation_name := pg_catalog.format('%I.%I', v_schema_name, v_table_name);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'atlas-sync-entity:' || v_workspace_id::text || ':'
        || v_entity_type || ':' || v_entity_id::text,
      0
    )
  );

  EXECUTE pg_catalog.format(
    'SELECT pg_catalog.to_jsonb(entity), entity.version::bigint '
      || 'FROM %s AS entity '
      || 'WHERE entity.id = $1 AND entity.workspace_id = $2 '
      || 'FOR UPDATE',
    v_relation_name
  )
  USING v_entity_id, v_workspace_id
  INTO v_current_entity, v_current_version;

  IF (v_current_entity IS NULL AND v_base_version <> 0)
    OR (v_current_entity IS NOT NULL AND v_current_version IS DISTINCT FROM v_base_version)
  THEN
    v_receipt_created_at := pg_catalog.now();
    v_response := pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'server_version', COALESCE(v_current_version, 0),
      'change_seq', NULL,
      'receipt', pg_catalog.jsonb_build_object(
        'payload_hash', v_payload_hash,
        'actor_id', v_actor_id,
        'created_at', v_receipt_created_at,
        'replayed', false
      ),
      'result', pg_catalog.jsonb_build_object('entity', v_current_entity),
      'error', pg_catalog.jsonb_build_object(
        'code', 'version_conflict',
        'message', 'The entity changed after the local base snapshot',
        'retryable', false,
        'base_version', v_base_version,
        'server_version', COALESCE(v_current_version, 0)
      )
    );

    INSERT INTO private.atlas_mutation_receipts (
      workspace_id, mutation_id, actor_id, protocol_version, mutation_type,
      entity_type, entity_id, payload_schema_version, base_version,
      payload_hash, status, server_version, change_seq, response, created_at
    )
    VALUES (
      v_workspace_id, v_mutation_id, v_actor_id, v_protocol_version,
      v_mutation_type, v_entity_type, v_entity_id, v_payload_schema_version,
      v_base_version, v_payload_hash, 'conflict', COALESCE(v_current_version, 0),
      NULL, v_response, v_receipt_created_at
    );
    RETURN v_response;
  END IF;

  IF v_current_entity IS NOT NULL AND v_base_version = 0 THEN
    v_receipt_created_at := pg_catalog.now();
    v_response := pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'server_version', v_current_version,
      'change_seq', NULL,
      'receipt', pg_catalog.jsonb_build_object(
        'payload_hash', v_payload_hash,
        'actor_id', v_actor_id,
        'created_at', v_receipt_created_at,
        'replayed', false
      ),
      'result', pg_catalog.jsonb_build_object('entity', v_current_entity),
      'error', pg_catalog.jsonb_build_object(
        'code', 'version_conflict',
        'message', 'The entity already exists on the server',
        'retryable', false,
        'base_version', v_base_version,
        'server_version', v_current_version
      )
    );

    INSERT INTO private.atlas_mutation_receipts (
      workspace_id, mutation_id, actor_id, protocol_version, mutation_type,
      entity_type, entity_id, payload_schema_version, base_version,
      payload_hash, status, server_version, change_seq, response, created_at
    )
    VALUES (
      v_workspace_id, v_mutation_id, v_actor_id, v_protocol_version,
      v_mutation_type, v_entity_type, v_entity_id, v_payload_schema_version,
      v_base_version, v_payload_hash, 'conflict', v_current_version, NULL,
      v_response, v_receipt_created_at
    );
    RETURN v_response;
  END IF;

  IF v_mutation_type = 'entity.delete' AND v_current_entity IS NULL THEN
    v_receipt_created_at := pg_catalog.now();
    v_response := pg_catalog.jsonb_build_object(
      'status', 'acknowledged',
      'mutation_id', v_mutation_id,
      'workspace_id', v_workspace_id,
      'server_version', 0,
      'change_seq', NULL,
      'receipt', pg_catalog.jsonb_build_object(
        'payload_hash', v_payload_hash,
        'actor_id', v_actor_id,
        'created_at', v_receipt_created_at,
        'replayed', false
      ),
      'result', pg_catalog.jsonb_build_object(
        'entity', NULL,
        'deleted', true,
        'already_absent', true
      )
    );

    INSERT INTO private.atlas_mutation_receipts (
      workspace_id, mutation_id, actor_id, protocol_version, mutation_type,
      entity_type, entity_id, payload_schema_version, base_version,
      payload_hash, status, server_version, change_seq, response, created_at
    )
    VALUES (
      v_workspace_id, v_mutation_id, v_actor_id, v_protocol_version,
      v_mutation_type, v_entity_type, v_entity_id, v_payload_schema_version,
      v_base_version, v_payload_hash, 'acknowledged', 0, NULL, v_response,
      v_receipt_created_at
    );
    RETURN v_response;
  END IF;

  v_effective_payload := COALESCE(v_current_entity, '{}'::jsonb) || v_payload;
  IF v_mutation_type = 'entity.upsert' THEN
    v_relationship_error := private.atlas_validate_sync_entity_relationships(
      v_entity_type,
      v_workspace_id,
      v_effective_payload
    );
    IF v_relationship_error IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'server_version', COALESCE(v_current_version, 0),
        'change_seq', NULL,
        'result', pg_catalog.jsonb_build_object('entity', v_current_entity),
        'error', v_relationship_error
      );
    END IF;
  END IF;

  PERFORM pg_catalog.set_config(
    'atlas.sync_mutation_id',
    v_mutation_id::text,
    true
  );
  PERFORM pg_catalog.set_config('atlas.sync_actor_id', v_actor_id::text, true);

  BEGIN
    IF v_mutation_type = 'entity.delete' THEN
      EXECUTE pg_catalog.format(
        'UPDATE %s AS entity '
          || 'SET is_deleted = true, updated_at = pg_catalog.now(), '
          || 'version = entity.version + 1 '
          || 'WHERE entity.id = $1 AND entity.workspace_id = $2 '
          || 'AND entity.version::bigint = $3 '
          || 'RETURNING pg_catalog.to_jsonb(entity), entity.version::bigint',
        v_relation_name
      )
      USING v_entity_id, v_workspace_id, v_base_version
      INTO v_entity, v_server_version;
    ELSE
      SELECT
        pg_catalog.string_agg(
          pg_catalog.format('%I', column_name),
          ', ' ORDER BY ordinal
        ),
        pg_catalog.string_agg(
          pg_catalog.format('source.%I', column_name),
          ', ' ORDER BY ordinal
        ),
        pg_catalog.string_agg(
          pg_catalog.format('%I = source.%I', column_name, column_name),
          ', ' ORDER BY ordinal
        )
      INTO v_write_columns, v_source_columns, v_update_assignments
      FROM pg_catalog.unnest(v_registry.writable_columns)
        WITH ORDINALITY AS writable(column_name, ordinal)
      WHERE v_payload ? column_name;

      IF v_write_columns IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'rejected',
          'mutation_id', v_mutation_id,
          'workspace_id', v_workspace_id,
          'error', pg_catalog.jsonb_build_object(
            'code', 'empty_entity_payload',
            'message', 'An entity upsert must include at least one writable field',
            'retryable', false
          )
        );
      END IF;

      IF v_current_entity IS NULL THEN
        v_write_payload := v_payload || pg_catalog.jsonb_build_object(
          'id', v_entity_id,
          'workspace_id', v_workspace_id,
          'created_by', v_actor_id,
          'created_at', pg_catalog.now(),
          'updated_at', pg_catalog.now(),
          'version', 1,
          'is_deleted', false
        );

        IF EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = v_registry.relation
            AND attribute.attname = 'created_by'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ) THEN
          EXECUTE pg_catalog.format(
            'INSERT INTO %s AS entity '
              || '(id, workspace_id, %s, created_by, created_at, updated_at, version, is_deleted) '
              || 'SELECT source.id, source.workspace_id, %s, source.created_by, '
              || 'source.created_at, source.updated_at, source.version, source.is_deleted '
              || 'FROM pg_catalog.jsonb_populate_record(NULL::%s, $1) AS source '
              || 'RETURNING pg_catalog.to_jsonb(entity), entity.version::bigint',
            v_relation_name,
            v_write_columns,
            v_source_columns,
            v_relation_name
          )
          USING v_write_payload
          INTO v_entity, v_server_version;
        ELSE
          EXECUTE pg_catalog.format(
            'INSERT INTO %s AS entity '
              || '(id, workspace_id, %s, created_at, updated_at, version, is_deleted) '
              || 'SELECT source.id, source.workspace_id, %s, source.created_at, '
              || 'source.updated_at, source.version, source.is_deleted '
              || 'FROM pg_catalog.jsonb_populate_record(NULL::%s, $1) AS source '
              || 'RETURNING pg_catalog.to_jsonb(entity), entity.version::bigint',
            v_relation_name,
            v_write_columns,
            v_source_columns,
            v_relation_name
          )
          USING v_write_payload
          INTO v_entity, v_server_version;
        END IF;
      ELSE
        EXECUTE pg_catalog.format(
          'UPDATE %s AS entity SET %s, '
            || 'updated_at = pg_catalog.now(), version = entity.version + 1, '
            || 'is_deleted = false '
            || 'FROM pg_catalog.jsonb_populate_record(NULL::%s, $1) AS source '
            || 'WHERE entity.id = $2 AND entity.workspace_id = $3 '
            || 'AND entity.version::bigint = $4 '
            || 'RETURNING pg_catalog.to_jsonb(entity), entity.version::bigint',
          v_relation_name,
          v_update_assignments,
          v_relation_name
        )
        USING v_payload, v_entity_id, v_workspace_id, v_base_version
        INTO v_entity, v_server_version;
      END IF;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      v_response := pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'server_version', COALESCE(v_current_version, 0),
        'change_seq', NULL,
        'result', pg_catalog.jsonb_build_object('entity', v_current_entity),
        'error', pg_catalog.jsonb_build_object(
          'code', 'unique_constraint_conflict',
          'message', 'The mutation conflicts with another active record',
          'retryable', false
        )
      );
    WHEN foreign_key_violation THEN
      v_response := pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'server_version', COALESCE(v_current_version, 0),
        'change_seq', NULL,
        'result', pg_catalog.jsonb_build_object('entity', v_current_entity),
        'error', pg_catalog.jsonb_build_object(
          'code', 'relationship_constraint_failed',
          'message', 'A related record is unavailable',
          'retryable', false
        )
      );
    WHEN check_violation OR not_null_violation
      OR invalid_text_representation OR numeric_value_out_of_range
    THEN
      v_response := pg_catalog.jsonb_build_object(
        'status', 'rejected',
        'mutation_id', v_mutation_id,
        'workspace_id', v_workspace_id,
        'server_version', COALESCE(v_current_version, 0),
        'change_seq', NULL,
        'result', pg_catalog.jsonb_build_object('entity', v_current_entity),
        'error', pg_catalog.jsonb_build_object(
          'code', 'domain_validation_failed',
          'message', 'The entity payload violates its domain contract',
          'retryable', false
        )
      );
  END;

  IF v_response IS NOT NULL THEN
    v_receipt_created_at := pg_catalog.now();
    v_response := v_response || pg_catalog.jsonb_build_object(
      'receipt', pg_catalog.jsonb_build_object(
        'payload_hash', v_payload_hash,
        'actor_id', v_actor_id,
        'created_at', v_receipt_created_at,
        'replayed', false
      )
    );

    INSERT INTO private.atlas_mutation_receipts (
      workspace_id, mutation_id, actor_id, protocol_version, mutation_type,
      entity_type, entity_id, payload_schema_version, base_version,
      payload_hash, status, server_version, change_seq, response, created_at
    )
    VALUES (
      v_workspace_id, v_mutation_id, v_actor_id, v_protocol_version,
      v_mutation_type, v_entity_type, v_entity_id, v_payload_schema_version,
      v_base_version, v_payload_hash, 'rejected', COALESCE(v_current_version, 0),
      NULL, v_response, v_receipt_created_at
    );
    RETURN v_response;
  END IF;

  IF v_entity IS NULL OR v_server_version IS NULL THEN
    RAISE EXCEPTION 'Atlas sync mutation lost its entity compare-and-set'
      USING ERRCODE = '40001';
  END IF;

  SELECT change_log.change_seq
  INTO v_change_seq
  FROM private.atlas_workspace_change_log AS change_log
  WHERE change_log.workspace_id = v_workspace_id
    AND change_log.mutation_id = v_mutation_id
    AND change_log.entity_type = v_entity_type
    AND change_log.entity_id = v_entity_id
  ORDER BY change_log.change_seq DESC
  LIMIT 1;

  IF v_change_seq IS NULL THEN
    RAISE EXCEPTION 'Atlas sync change capture did not produce a cursor'
      USING ERRCODE = '55000';
  END IF;

  v_receipt_created_at := pg_catalog.now();
  v_response := pg_catalog.jsonb_build_object(
    'status', 'acknowledged',
    'mutation_id', v_mutation_id,
    'workspace_id', v_workspace_id,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'server_version', v_server_version,
    'change_seq', v_change_seq,
    'receipt', pg_catalog.jsonb_build_object(
      'payload_hash', v_payload_hash,
      'actor_id', v_actor_id,
      'created_at', v_receipt_created_at,
      'replayed', false
    ),
    'result', pg_catalog.jsonb_build_object(
      'entity', v_entity,
      'delete_mode', CASE
        WHEN v_mutation_type = 'entity.delete' THEN 'soft'
        ELSE NULL
      END
    )
  );

  INSERT INTO private.atlas_mutation_receipts (
    workspace_id, mutation_id, actor_id, protocol_version, mutation_type,
    entity_type, entity_id, payload_schema_version, base_version,
    payload_hash, status, server_version, change_seq, response, created_at
  )
  VALUES (
    v_workspace_id, v_mutation_id, v_actor_id, v_protocol_version,
    v_mutation_type, v_entity_type, v_entity_id, v_payload_schema_version,
    v_base_version, v_payload_hash, 'acknowledged', v_server_version,
    v_change_seq, v_response, v_receipt_created_at
  );

  RETURN v_response;
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_apply_sync_mutation(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.atlas_apply_sync_mutation(jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.atlas_apply_sync_mutation(p_envelope jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.atlas_apply_sync_mutation(p_envelope);
$function$;

REVOKE ALL ON FUNCTION public.atlas_apply_sync_mutation(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atlas_apply_sync_mutation(jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.atlas_pull_workspace_changes(
  p_workspace_id uuid,
  p_after_change_seq bigint DEFAULT 0,
  p_limit integer DEFAULT 500,
  p_has_baseline boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_request_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    auth.jwt()->>'role',
    ''
  );
  v_protocol_version integer;
  v_workspace_mode text;
  v_first_retained_seq bigint := 1;
  v_watermark bigint := 0;
  v_changes jsonb := '[]'::jsonb;
  v_next_cursor bigint;
  v_has_more boolean := false;
BEGIN
  IF p_workspace_id IS NULL
    OR p_after_change_seq IS NULL
    OR p_after_change_seq < 0
    OR p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 1000
    OR p_has_baseline IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'snapshot_required', false,
      'changes', '[]'::jsonb,
      'error', pg_catalog.jsonb_build_object(
        'code', 'invalid_pull_request',
        'message', 'Cursor must be nonnegative and page size must be between 1 and 1000',
        'retryable', false
      )
    );
  END IF;

  IF v_request_role IS DISTINCT FROM 'service_role'
    AND (
      auth.uid() IS NULL
      OR p_workspace_id IS DISTINCT FROM public.current_workspace_id()
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'snapshot_required', false,
      'changes', '[]'::jsonb,
      'error', pg_catalog.jsonb_build_object(
        'code', 'workspace_access_denied',
        'message', 'The actor cannot pull this workspace',
        'retryable', false
      )
    );
  END IF;

  SELECT workspace.data_mode::text, workspace.sync_protocol_version
  INTO v_workspace_mode, v_protocol_version
  FROM public.workspaces AS workspace
  WHERE workspace.id = p_workspace_id
    AND workspace.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'snapshot_required', false,
      'changes', '[]'::jsonb,
      'error', pg_catalog.jsonb_build_object(
        'code', 'workspace_not_found',
        'message', 'The workspace is unavailable',
        'retryable', false
      )
    );
  END IF;

  IF v_workspace_mode <> 'hybrid' OR v_protocol_version <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'protocol_version', v_protocol_version,
      'snapshot_required', false,
      'changes', '[]'::jsonb,
      'error', pg_catalog.jsonb_build_object(
        'code', 'protocol_not_active',
        'message', 'The workspace has not completed Cloud Sync protocol activation',
        'retryable', true
      )
    );
  END IF;

  SELECT counter.first_retained_seq, counter.last_change_seq
  INTO v_first_retained_seq, v_watermark
  FROM private.atlas_workspace_change_counters AS counter
  WHERE counter.workspace_id = p_workspace_id;

  IF NOT FOUND THEN
    v_first_retained_seq := 1;
    v_watermark := 0;
  END IF;

  -- A numeric cursor alone cannot distinguish a fresh SQLite database from a
  -- fully installed snapshot at watermark zero. The client persists the
  -- snapshot watermark in the same SQLite transaction as the baseline swap
  -- and sends that durable marker on every pull.
  IF NOT p_has_baseline THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'snapshot_required',
      'workspace_id', p_workspace_id,
      'protocol_version', v_protocol_version,
      'first_available_change_seq', v_first_retained_seq,
      'watermark', v_watermark,
      'snapshot_watermark', v_watermark,
      'next_cursor', p_after_change_seq,
      'has_more', false,
      'snapshot_required', true,
      'error', pg_catalog.jsonb_build_object(
        'code', 'baseline_required',
        'message', 'This SQLite replica has not installed its initial server baseline',
        'retryable', false
      )
    );
  END IF;

  IF p_after_change_seq > v_watermark THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'protocol_version', v_protocol_version,
      'first_available_change_seq', v_first_retained_seq,
      'watermark', v_watermark,
      'snapshot_required', false,
      'changes', '[]'::jsonb,
      'error', pg_catalog.jsonb_build_object(
        'code', 'cursor_ahead_of_server',
        'message', 'The requested cursor is ahead of the workspace watermark',
        'retryable', false
      )
    );
  END IF;

  IF p_after_change_seq < v_first_retained_seq - 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'snapshot_required',
      'workspace_id', p_workspace_id,
      'protocol_version', v_protocol_version,
      'first_available_change_seq', v_first_retained_seq,
      'watermark', v_watermark,
      'snapshot_watermark', v_watermark,
      'next_cursor', p_after_change_seq,
      'has_more', false,
      'snapshot_required', true,
      'changes', '[]'::jsonb,
      'error', pg_catalog.jsonb_build_object(
        'code', 'cursor_expired',
        'message', 'The cursor is older than the retained 180-day change history',
        'retryable', false
      )
    );
  END IF;

  WITH page AS (
    SELECT
      change_log.change_seq,
      change_log.entity_type,
      change_log.entity_id,
      change_log.operation,
      change_log.entity_version,
      change_log.payload,
      change_log.mutation_id,
      change_log.actor_id,
      change_log.changed_at,
      pg_catalog.row_number() OVER (ORDER BY change_log.change_seq) AS row_number
    FROM private.atlas_workspace_change_log AS change_log
    WHERE change_log.workspace_id = p_workspace_id
      AND change_log.change_seq > p_after_change_seq
      AND change_log.change_seq <= v_watermark
    ORDER BY change_log.change_seq
    LIMIT p_limit + 1
  ), returned_page AS (
    SELECT *
    FROM page
    WHERE row_number <= p_limit
  )
  SELECT
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'change_seq', returned_page.change_seq,
          'entity_type', returned_page.entity_type,
          'entity_id', returned_page.entity_id,
          'operation', returned_page.operation,
          'entity_version', returned_page.entity_version,
          'payload', returned_page.payload,
          'mutation_id', returned_page.mutation_id,
          'actor_id', returned_page.actor_id,
          'changed_at', returned_page.changed_at
        )
        ORDER BY returned_page.change_seq
      ),
      '[]'::jsonb
    ),
    COALESCE(pg_catalog.max(returned_page.change_seq), p_after_change_seq),
    EXISTS (SELECT 1 FROM page WHERE page.row_number > p_limit)
  INTO v_changes, v_next_cursor, v_has_more
  FROM returned_page;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'workspace_id', p_workspace_id,
    'protocol_version', v_protocol_version,
    'after_change_seq', p_after_change_seq,
    'first_available_change_seq', v_first_retained_seq,
    'watermark', v_watermark,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more,
    'snapshot_required', false,
    'changes', v_changes
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_pull_workspace_changes(uuid, bigint, integer, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.atlas_pull_workspace_changes(uuid, bigint, integer, boolean)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.atlas_pull_workspace_changes(
  p_workspace_id uuid,
  p_after_change_seq bigint DEFAULT 0,
  p_limit integer DEFAULT 500,
  p_has_baseline boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.atlas_pull_workspace_changes(
    p_workspace_id,
    p_after_change_seq,
    p_limit,
    p_has_baseline
  );
$function$;

REVOKE ALL ON FUNCTION public.atlas_pull_workspace_changes(uuid, bigint, integer, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atlas_pull_workspace_changes(uuid, bigint, integer, boolean)
  TO authenticated, service_role;

-- Keyset-paged workspace snapshot used only when a retained change-feed cursor
-- has expired. The watermark is captured on the first request and reused on
-- every page. Rows may change while pages are read; replaying change_seq values
-- strictly after that watermark turns this fuzzy snapshot into a consistent
-- replica without holding a database transaction open across HTTP requests.
CREATE OR REPLACE FUNCTION private.atlas_get_workspace_sync_snapshot(
  p_workspace_id uuid,
  p_snapshot_watermark bigint DEFAULT NULL,
  p_after_entity_type text DEFAULT '',
  p_after_entity_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_request_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    auth.jwt()->>'role',
    ''
  );
  v_protocol_version integer;
  v_workspace_mode text;
  v_first_retained_seq bigint := 1;
  v_current_watermark bigint := 0;
  v_snapshot_watermark bigint;
  v_entity_types jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_entity_type text;
  v_next_entity_id uuid;
BEGIN
  IF p_workspace_id IS NULL
    OR p_limit IS NULL
    OR p_limit < 1
    OR p_limit > 1000
    OR p_snapshot_watermark < 0
    OR COALESCE(p_after_entity_type, '') !~ '^[a-z0-9_]*$'
    OR (COALESCE(p_after_entity_type, '') = '' AND p_after_entity_id IS NOT NULL)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'invalid_snapshot_request',
        'message', 'Snapshot watermark, cursor, or page size is invalid',
        'retryable', false
      )
    );
  END IF;

  IF v_request_role IS DISTINCT FROM 'service_role'
    AND (
      auth.uid() IS NULL
      OR p_workspace_id IS DISTINCT FROM public.current_workspace_id()
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'workspace_access_denied',
        'message', 'The actor cannot snapshot this workspace',
        'retryable', false
      )
    );
  END IF;

  SELECT workspace.data_mode::text, workspace.sync_protocol_version
  INTO v_workspace_mode, v_protocol_version
  FROM public.workspaces AS workspace
  WHERE workspace.id = p_workspace_id
    AND workspace.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'error', pg_catalog.jsonb_build_object(
        'code', 'workspace_not_found',
        'message', 'The workspace is unavailable',
        'retryable', false
      )
    );
  END IF;

  IF v_workspace_mode <> 'hybrid' OR v_protocol_version <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'protocol_version', v_protocol_version,
      'error', pg_catalog.jsonb_build_object(
        'code', 'protocol_not_active',
        'message', 'The workspace has not completed Cloud Sync protocol activation',
        'retryable', true
      )
    );
  END IF;

  SELECT counter.first_retained_seq, counter.last_change_seq
  INTO v_first_retained_seq, v_current_watermark
  FROM private.atlas_workspace_change_counters AS counter
  WHERE counter.workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    v_first_retained_seq := 1;
    v_current_watermark := 0;
  END IF;

  v_snapshot_watermark := COALESCE(p_snapshot_watermark, v_current_watermark);
  IF v_snapshot_watermark > v_current_watermark THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'snapshot_watermark', v_current_watermark,
      'error', pg_catalog.jsonb_build_object(
        'code', 'snapshot_watermark_ahead',
        'message', 'The snapshot watermark is ahead of the workspace change feed',
        'retryable', false
      )
    );
  END IF;
  IF v_snapshot_watermark < v_first_retained_seq - 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'snapshot_watermark', v_current_watermark,
      'error', pg_catalog.jsonb_build_object(
        'code', 'snapshot_restart_required',
        'message', 'Changes after the requested snapshot watermark are no longer retained',
        'retryable', true
      )
    );
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(registry.entity_type ORDER BY registry.entity_type), '[]'::jsonb)
  INTO v_entity_types
  FROM private.atlas_sync_entity_registry AS registry
  WHERE registry.enabled;

  IF COALESCE(p_after_entity_type, '') <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM private.atlas_sync_entity_registry AS registry
      WHERE registry.enabled
        AND registry.entity_type = p_after_entity_type
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'rejected',
      'workspace_id', p_workspace_id,
      'snapshot_watermark', v_snapshot_watermark,
      'error', pg_catalog.jsonb_build_object(
        'code', 'invalid_snapshot_cursor',
        'message', 'The snapshot cursor entity type is not registered',
        'retryable', false
      )
    );
  END IF;

  WITH raw_snapshot_rows(entity_type, entity_id, payload) AS (
    SELECT 'categories'::text, row_data.id, pg_catalog.to_jsonb(row_data)
    FROM public.categories AS row_data
    WHERE row_data.workspace_id = p_workspace_id
    UNION ALL
    SELECT 'category_discounts'::text, row_data.id, pg_catalog.to_jsonb(row_data)
    FROM public.category_discounts AS row_data
    WHERE row_data.workspace_id = p_workspace_id
    UNION ALL
    SELECT 'price_book_items'::text, row_data.id, pg_catalog.to_jsonb(row_data)
    FROM public.price_book_items AS row_data
    WHERE row_data.workspace_id = p_workspace_id
    UNION ALL
    SELECT 'price_books'::text, row_data.id, pg_catalog.to_jsonb(row_data)
    FROM public.price_books AS row_data
    WHERE row_data.workspace_id = p_workspace_id
    UNION ALL
    SELECT 'product_barcodes'::text, row_data.id, pg_catalog.to_jsonb(row_data)
    FROM public.product_barcodes AS row_data
    WHERE row_data.workspace_id = p_workspace_id
    UNION ALL
    SELECT 'product_discounts'::text, row_data.id, pg_catalog.to_jsonb(row_data)
    FROM public.product_discounts AS row_data
    WHERE row_data.workspace_id = p_workspace_id
    UNION ALL
    SELECT 'reorder_transfer_rules'::text, row_data.id, pg_catalog.to_jsonb(row_data)
    FROM public.reorder_transfer_rules AS row_data
    WHERE row_data.workspace_id = p_workspace_id
    UNION ALL
    SELECT 'units'::text, row_data.id, pg_catalog.to_jsonb(row_data)
    FROM public.units AS row_data
    WHERE row_data.workspace_id = p_workspace_id
  ), page AS (
    SELECT
      raw.entity_type,
      raw.entity_id,
      CASE
        WHEN COALESCE((raw.payload->>'is_deleted')::boolean, false) THEN 'delete'
        ELSE 'upsert'
      END AS operation,
      COALESCE(NULLIF(raw.payload->>'version', '')::bigint, 0) AS entity_version,
      CASE
        WHEN COALESCE((raw.payload->>'is_deleted')::boolean, false) THEN NULL
        ELSE raw.payload
      END AS payload,
      COALESCE(
        NULLIF(raw.payload->>'updated_at', '')::timestamptz,
        NULLIF(raw.payload->>'created_at', '')::timestamptz,
        pg_catalog.now()
      ) AS changed_at,
      pg_catalog.row_number() OVER (ORDER BY raw.entity_type, raw.entity_id) AS row_number
    FROM raw_snapshot_rows AS raw
    WHERE (raw.entity_type, raw.entity_id) > (
      COALESCE(p_after_entity_type, ''),
      COALESCE(p_after_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    ORDER BY raw.entity_type, raw.entity_id
    LIMIT p_limit + 1
  ), returned_page AS (
    SELECT *
    FROM page
    WHERE page.row_number <= p_limit
  )
  SELECT
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'entity_type', returned_page.entity_type,
          'entity_id', returned_page.entity_id,
          'operation', returned_page.operation,
          'entity_version', returned_page.entity_version,
          'payload', returned_page.payload,
          'changed_at', returned_page.changed_at
        )
        ORDER BY returned_page.entity_type, returned_page.entity_id
      ),
      '[]'::jsonb
    ),
    EXISTS (SELECT 1 FROM page WHERE page.row_number > p_limit)
  INTO v_rows, v_has_more
  FROM returned_page;

  IF pg_catalog.jsonb_array_length(v_rows) > 0 THEN
    v_next_entity_type := v_rows->-1->>'entity_type';
    v_next_entity_id := (v_rows->-1->>'entity_id')::uuid;
  ELSE
    v_next_entity_type := NULLIF(p_after_entity_type, '');
    v_next_entity_id := p_after_entity_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'workspace_id', p_workspace_id,
    'protocol_version', v_protocol_version,
    'snapshot_watermark', v_snapshot_watermark,
    'entity_types', v_entity_types,
    'next_entity_type', v_next_entity_type,
    'next_entity_id', v_next_entity_id,
    'has_more', v_has_more,
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_get_workspace_sync_snapshot(uuid, bigint, text, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.atlas_get_workspace_sync_snapshot(uuid, bigint, text, uuid, integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.atlas_get_workspace_sync_snapshot(
  p_workspace_id uuid,
  p_snapshot_watermark bigint DEFAULT NULL,
  p_after_entity_type text DEFAULT '',
  p_after_entity_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.atlas_get_workspace_sync_snapshot(
    p_workspace_id,
    p_snapshot_watermark,
    p_after_entity_type,
    p_after_entity_id,
    p_limit
  );
$function$;

REVOKE ALL ON FUNCTION public.atlas_get_workspace_sync_snapshot(uuid, bigint, text, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atlas_get_workspace_sync_snapshot(uuid, bigint, text, uuid, integer)
  TO authenticated, service_role;

-- Retention is intentionally operational rather than hidden in request paths.
-- Schedule this service-role routine daily. It never removes changes newer
-- than 180 days, even if a caller supplies a later cutoff.
CREATE OR REPLACE FUNCTION private.atlas_prune_workspace_change_log(
  p_before timestamptz DEFAULT pg_catalog.now() - INTERVAL '180 days',
  p_batch_size integer DEFAULT 10000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_cutoff timestamptz;
  v_deleted integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 100000 THEN
    RAISE EXCEPTION 'Change-log prune batch size must be between 1 and 100000'
      USING ERRCODE = '22023';
  END IF;

  v_cutoff := LEAST(
    COALESCE(p_before, pg_catalog.now() - INTERVAL '180 days'),
    pg_catalog.now() - INTERVAL '180 days'
  );

  WITH doomed AS (
    SELECT change_log.workspace_id, change_log.change_seq
    FROM private.atlas_workspace_change_log AS change_log
    WHERE change_log.changed_at < v_cutoff
    ORDER BY change_log.changed_at, change_log.workspace_id, change_log.change_seq
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM private.atlas_workspace_change_log AS change_log
    USING doomed
    WHERE change_log.workspace_id = doomed.workspace_id
      AND change_log.change_seq = doomed.change_seq
    RETURNING change_log.workspace_id, change_log.change_seq
  ), retained_floor AS (
    SELECT deleted.workspace_id, pg_catalog.max(deleted.change_seq) + 1 AS first_retained_seq
    FROM deleted
    GROUP BY deleted.workspace_id
  ), updated_counters AS (
    UPDATE private.atlas_workspace_change_counters AS counter
    SET
      first_retained_seq = GREATEST(
        counter.first_retained_seq,
        retained_floor.first_retained_seq
      ),
      updated_at = pg_catalog.now()
    FROM retained_floor
    WHERE counter.workspace_id = retained_floor.workspace_id
    RETURNING counter.workspace_id
  )
  SELECT pg_catalog.count(*)::integer
  INTO v_deleted
  FROM deleted;

  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION private.atlas_prune_workspace_change_log(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.atlas_prune_workspace_change_log(timestamptz, integer)
  TO service_role;

COMMENT ON TABLE private.atlas_mutation_receipts IS
  'Durable idempotency receipts keyed by (workspace_id, mutation_id); effect and receipt commit in the same RPC transaction.';
COMMENT ON TABLE private.atlas_workspace_change_log IS
  'Monotonic per-workspace entity feed retained for at least 180 days; Realtime may wake a pull but is not the source of truth.';
COMMENT ON FUNCTION public.atlas_get_workspace_offline_entitlement(uuid) IS
  'Returns one authenticated current-workspace lock snapshot with a server-owned verification timestamp for the seven-day SQLite offline-access lease.';
COMMENT ON FUNCTION public.atlas_apply_sync_mutation(jsonb) IS
  'Applies one protocol-v1 allowlisted entity mutation or returns a typed conflict/rejection receipt.';
COMMENT ON FUNCTION public.atlas_pull_workspace_changes(uuid, bigint, integer, boolean) IS
  'Returns a stable-watermark change page; a durable SQLite baseline marker is mandatory even when the numeric cursor is zero.';
COMMENT ON FUNCTION public.atlas_get_workspace_sync_snapshot(uuid, bigint, text, uuid, integer) IS
  'Returns a keyset page from the protocol-v1 workspace snapshot at a captured change-feed watermark; replay changes after that watermark.';

NOTIFY pgrst, 'reload schema';
