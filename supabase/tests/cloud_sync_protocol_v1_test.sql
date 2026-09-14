BEGIN;

INSERT INTO public.keys (key_name, key_value)
VALUES
  ('admin', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  ('staff', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
  ('viewer', 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')
ON CONFLICT (key_name) DO UPDATE
SET
  key_value = EXCLUDED.key_value,
  updated_at = pg_catalog.now();

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

INSERT INTO public.workspaces (
  id,
  name,
  subscription_expires_at,
  data_mode
)
VALUES (
  'ac000000-0000-4000-8000-000000000001',
  'Cloud Sync protocol v1 test',
  pg_catalog.now() + INTERVAL '10 days',
  'cloud'
);

SELECT is(
  (
    SELECT data_mode::text
    FROM public.workspaces
    WHERE id = 'ac000000-0000-4000-8000-000000000001'
  ),
  'hybrid',
  'legacy cloud workspace writes normalize to hybrid'
);

SELECT is(
  (
    SELECT sync_protocol_version
    FROM public.workspaces
    WHERE id = 'ac000000-0000-4000-8000-000000000001'
  ),
  0,
  'workspaces remain on the compatibility protocol until explicit cutover'
);

INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'ac000000-0000-4000-8000-000000000002',
  'authenticated',
  'authenticated',
  'cloud-sync-admin@example.test',
  '',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Cloud Sync Admin","role":"admin","workspace_id":"ac000000-0000-4000-8000-000000000001","passkey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'::jsonb,
  pg_catalog.now(),
  pg_catalog.now()
);

UPDATE public.profiles
SET
  role = 'admin',
  workspace_id = 'ac000000-0000-4000-8000-000000000001',
  current_workspace = 'ac000000-0000-4000-8000-000000000001'
WHERE id = 'ac000000-0000-4000-8000-000000000002';

SELECT ok(
  (
    SELECT relrowsecurity
    FROM pg_catalog.pg_class
    WHERE oid = 'private.atlas_mutation_receipts'::regclass
  ),
  'mutation receipts have RLS enabled in the private schema'
);

SELECT ok(
  NOT pg_catalog.has_table_privilege(
    'authenticated',
    'private.atlas_mutation_receipts',
    'SELECT'
  ),
  'authenticated clients cannot read mutation receipts directly'
);

SELECT ok(
  NOT pg_catalog.has_table_privilege(
    'authenticated',
    'private.atlas_workspace_change_log',
    'SELECT'
  ),
  'authenticated clients cannot read the private change log directly'
);

SELECT ok(
  NOT (
    SELECT index_row.indisunique
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid =
      'private.atlas_workspace_change_log_mutation_idx'::regclass
  ),
  'a mutation id can correlate the multiple change rows emitted by one command'
);

SELECT ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.atlas_apply_sync_mutation(jsonb)',
    'EXECUTE'
  ),
  'authenticated clients can invoke the sync mutation gateway'
);

SELECT ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.atlas_pull_workspace_changes(uuid,bigint,integer,boolean)',
    'EXECUTE'
  ),
  'authenticated clients can invoke the change-feed gateway'
);

SELECT ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.atlas_get_workspace_sync_snapshot(uuid,bigint,text,uuid,integer)',
    'EXECUTE'
  ),
  'authenticated clients can invoke the scoped snapshot gateway'
);

SELECT ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.atlas_get_workspace_offline_entitlement(uuid)',
    'EXECUTE'
  ),
  'authenticated clients can request an offline entitlement snapshot'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'anon',
    'public.atlas_get_workspace_offline_entitlement(uuid)',
    'EXECUTE'
  ),
  'anonymous clients cannot request an offline entitlement snapshot'
);

SELECT results_eq(
  $$
    SELECT entity_type
    FROM private.atlas_sync_entity_registry
    WHERE enabled
    ORDER BY entity_type
  $$,
  $$VALUES
    ('categories'::text),
    ('category_discounts'::text),
    ('price_book_items'::text),
    ('price_books'::text),
    ('product_barcodes'::text),
    ('product_discounts'::text),
    ('reorder_transfer_rules'::text),
    ('units'::text)
  $$,
  'the version-one generic dispatcher has an exact static entity allowlist'
);

SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"ac000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

SELECT results_eq(
  $$
    SELECT
      entitlement->>'workspace_id',
      pg_catalog.jsonb_typeof(entitlement->'server_verified_at'),
      pg_catalog.jsonb_typeof(entitlement->'locked_workspace'),
      pg_catalog.jsonb_typeof(entitlement->'has_usage_limits'),
      pg_catalog.jsonb_typeof(entitlement->'payment_access_locked')
    FROM (
      SELECT public.atlas_get_workspace_offline_entitlement(
        'ac000000-0000-4000-8000-000000000001'
      ) AS entitlement
    ) AS response
  $$,
  $$VALUES (
    'ac000000-0000-4000-8000-000000000001'::text,
    'string'::text,
    'boolean'::text,
    'boolean'::text,
    'boolean'::text
  )$$,
  'offline entitlement has the complete stable client envelope'
);

SELECT ok(
  (
    public.atlas_get_workspace_offline_entitlement(
      'ac000000-0000-4000-8000-000000000001'
    )->>'server_verified_at'
  )::timestamptz BETWEEN
    pg_catalog.statement_timestamp() - INTERVAL '5 seconds'
    AND pg_catalog.clock_timestamp() + INTERVAL '5 seconds',
  'offline entitlement verification time is generated by the server'
);

SELECT throws_ok(
  $$
    SELECT public.atlas_get_workspace_offline_entitlement(
      'ac000000-0000-4000-8000-000000000099'
    )
  $$,
  '42501',
  'workspace_access_denied',
  'offline entitlement cannot be requested for another workspace'
);

SELECT throws_ok(
  $$
    UPDATE public.workspaces
    SET sync_protocol_version = 1
    WHERE id = 'ac000000-0000-4000-8000-000000000001'
  $$,
  '42501',
  'Sync protocol version must be changed through the activation RPC',
  'authenticated clients cannot bypass the activation gateway'
);

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"ac000000-0000-4000-8000-000000000002","role":"service_role"}',
  true
);
SELECT pg_catalog.set_config('atlas.sync_protocol_activation', '1', true);

SELECT throws_ok(
  $$
    UPDATE public.workspaces
    SET sync_protocol_version = 1
    WHERE id = 'ac000000-0000-4000-8000-000000000001'
  $$,
  '42501',
  'Sync protocol version must be changed through the activation RPC',
  'client-controlled request claims and custom settings cannot spoof protocol activation'
);

SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"ac000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
SELECT pg_catalog.set_config('atlas.sync_protocol_activation', '', true);

SELECT is(
  public.atlas_activate_workspace_sync_protocol(
    'ac000000-0000-4000-8000-000000000001',
    1
  )#>>'{error,code}',
  'rollout_incomplete',
  'tenant administrators cannot cut over an incomplete pilot protocol'
);

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"ac000000-0000-4000-8000-000000000002","role":"service_role"}',
  true
);

SELECT is(
  public.atlas_activate_workspace_sync_protocol(
    'ac000000-0000-4000-8000-000000000001',
    1
  )#>>'{error,code}',
  'rollout_incomplete',
  'service role cannot bypass the incomplete rollout gate'
);

SELECT throws_ok(
  $$
    UPDATE public.workspaces
    SET sync_protocol_version = 1
    WHERE id = 'ac000000-0000-4000-8000-000000000001'
  $$,
  '42501',
  'Sync protocol version must be changed through the activation RPC',
  'service role cannot bypass the incomplete rollout gate with direct DML'
);

SELECT throws_ok(
  $$
    INSERT INTO public.workspaces (id, name, data_mode, sync_protocol_version)
    VALUES (
      'ac000000-0000-4000-8000-000000000099',
      'Forbidden v1 workspace',
      'hybrid',
      1
    )
  $$,
  '42501',
  'Sync protocol version must be changed through the activation RPC',
  'service role cannot create a workspace already opted into the incomplete protocol'
);

RESET ROLE;
SELECT pg_catalog.set_config('request.jwt.claim.role', '', true);
SELECT pg_catalog.set_config('request.jwt.claims', '{}', true);

SELECT is(
  (
    SELECT sync_protocol_version
    FROM public.workspaces
    WHERE id = 'ac000000-0000-4000-8000-000000000001'
  ),
  0,
  'failed activation leaves the workspace on the compatibility protocol'
);

-- Migration-owner setup exercises the dormant protocol foundation without
-- exposing any production activation path.
UPDATE public.workspaces
SET sync_protocol_version = 1
WHERE id = 'ac000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"ac000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

SELECT is(
  (
    SELECT sync_protocol_version
    FROM public.workspaces
    WHERE id = 'ac000000-0000-4000-8000-000000000001'
  ),
  1,
  'migration-owner test setup enables the dormant protocol foundation'
);

SELECT results_eq(
  $$
    SELECT
      response->>'status',
      (response->>'snapshot_required')::boolean,
      response#>>'{error,code}',
      (response->>'snapshot_watermark')::bigint
    FROM (
      SELECT public.atlas_pull_workspace_changes(
        'ac000000-0000-4000-8000-000000000001',
        0,
        100,
        false
      ) AS response
    ) AS pull
  $$,
  $$VALUES ('snapshot_required'::text, true, 'baseline_required'::text, 0::bigint)$$,
  'a fresh SQLite cursor zero must install a baseline even at server watermark zero'
);

SELECT results_eq(
  $$
    SELECT
      response->>'status',
      (response->>'snapshot_watermark')::bigint,
      pg_catalog.jsonb_array_length(response->'rows')
    FROM (
      SELECT public.atlas_get_workspace_sync_snapshot(
        'ac000000-0000-4000-8000-000000000001',
        0,
        '',
        NULL,
        100
      ) AS response
    ) AS snapshot
  $$,
  $$VALUES ('ok'::text, 0::bigint, 0)$$,
  'a zero-watermark baseline is valid and gives the client a durable marker'
);

SELECT is(
  public.atlas_sync_payload_hash('{"a":{"x":1,"z":0},"b":2}'),
  '9cb580a086503ee3b933190f5da78e27f63d1fdc1778e2684c05ea43e43db5b3',
  'payload hashing uses the exact UTF-8 canonical JSON bytes'
);

SELECT is(
  (
    public.atlas_apply_sync_mutation(
      pg_catalog.jsonb_build_object(
        'protocol_version', 1,
        'mutation_id', 'ac000000-0000-4000-8000-000000000008',
        'workspace_id', 'ac000000-0000-4000-8000-000000000001',
        'actor_id', 'ac000000-0000-4000-8000-000000000002',
        'mutation_type', 'entity.upsert',
        'entity_type', 'categories',
        'entity_id', 'ac000000-0000-4000-8000-000000000018',
        'payload_schema_version', 1,
        'base_version', 0,
        'payload_hash', public.atlas_sync_payload_hash('{"name":"Canonical B"}'),
        'payload_canonical', '{"name":"Canonical B"}',
        'payload', '{"name":"Payload A"}'::jsonb
      )
    )#>>'{error,code}'
  ),
  'payload_canonical_mismatch',
  'the canonical text must parse to the supplied payload'
);

SELECT is(
  (
    public.atlas_apply_sync_mutation(
      pg_catalog.jsonb_build_object(
        'protocol_version', 1,
        'mutation_id', 'ac000000-0000-4000-8000-000000000009',
        'workspace_id', 'ac000000-0000-4000-8000-000000000001',
        'actor_id', 'ac000000-0000-4000-8000-000000000002',
        'mutation_type', 'entity.upsert',
        'entity_type', 'categories',
        'entity_id', 'ac000000-0000-4000-8000-000000000019',
        'payload_schema_version', 1,
        'base_version', 0,
        'payload_hash', pg_catalog.repeat('0', 64),
        'payload_canonical', '{"name":"Hash mismatch"}',
        'payload', '{"name":"Hash mismatch"}'::jsonb
      )
    )#>>'{error,code}'
  ),
  'payload_hash_mismatch',
  'the server verifies SHA-256 against the exact canonical UTF-8 bytes'
);

CREATE TEMP TABLE cloud_sync_protocol_results (
  name text PRIMARY KEY,
  result jsonb NOT NULL
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'create_category',
  public.atlas_apply_sync_mutation(
    pg_catalog.jsonb_build_object(
      'protocol_version', 1,
      'mutation_id', 'ac000000-0000-4000-8000-000000000010',
      'workspace_id', 'ac000000-0000-4000-8000-000000000001',
      'actor_id', 'ac000000-0000-4000-8000-000000000002',
      'mutation_type', 'entity.upsert',
      'entity_type', 'categories',
      'entity_id', 'ac000000-0000-4000-8000-000000000020',
      'payload_schema_version', 1,
      'base_version', 0,
      'payload_hash', public.atlas_sync_payload_hash(
        '{"description":"Created offline","name":"Protocol category"}'
      ),
      'payload_canonical', '{"description":"Created offline","name":"Protocol category"}',
      'payload', '{"name":"Protocol category","description":"Created offline"}'::jsonb
    )
  );

SELECT is(
  (SELECT result->>'status' FROM cloud_sync_protocol_results WHERE name = 'create_category'),
  'acknowledged',
  'an allowlisted category create is acknowledged'
);

SELECT is(
  (
    SELECT (result->>'server_version')::integer
    FROM cloud_sync_protocol_results
    WHERE name = 'create_category'
  ),
  1,
  'a new server entity starts at version one'
);

SELECT is(
  (
    SELECT (result->>'change_seq')::bigint
    FROM cloud_sync_protocol_results
    WHERE name = 'create_category'
  ),
  1::bigint,
  'the first workspace mutation receives change sequence one'
);

SELECT results_eq(
  $$
    SELECT name::text, description::text, version, is_deleted
    FROM public.categories
    WHERE id = 'ac000000-0000-4000-8000-000000000020'
  $$,
  $$VALUES ('Protocol category'::text, 'Created offline'::text, 1, false)$$,
  'the server persists the authoritative entity snapshot'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'replay_category',
  public.atlas_apply_sync_mutation(
    pg_catalog.jsonb_build_object(
      'protocol_version', 1,
      'mutation_id', 'ac000000-0000-4000-8000-000000000010',
      'workspace_id', 'ac000000-0000-4000-8000-000000000001',
      'actor_id', 'ac000000-0000-4000-8000-000000000002',
      'mutation_type', 'entity.upsert',
      'entity_type', 'categories',
      'entity_id', 'ac000000-0000-4000-8000-000000000020',
      'payload_schema_version', 1,
      'base_version', 0,
      'payload_hash', public.atlas_sync_payload_hash(
        '{"description":"Created offline","name":"Protocol category"}'
      ),
      'payload_canonical', '{"description":"Created offline","name":"Protocol category"}',
      'payload', '{"name":"Protocol category","description":"Created offline"}'::jsonb
    )
  );

SELECT ok(
  (
    SELECT (result#>>'{receipt,replayed}')::boolean
    FROM cloud_sync_protocol_results
    WHERE name = 'replay_category'
  ),
  'an identical uncertain-response replay returns the committed receipt'
);

SELECT is(
  (
    SELECT pg_catalog.count(*)::integer
    FROM public.categories
    WHERE id = 'ac000000-0000-4000-8000-000000000020'
  ),
  1,
  'an idempotent replay does not duplicate the entity'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'mutation_id_reuse',
  public.atlas_apply_sync_mutation(
    pg_catalog.jsonb_build_object(
      'protocol_version', 1,
      'mutation_id', 'ac000000-0000-4000-8000-000000000010',
      'workspace_id', 'ac000000-0000-4000-8000-000000000001',
      'actor_id', 'ac000000-0000-4000-8000-000000000002',
      'mutation_type', 'entity.upsert',
      'entity_type', 'categories',
      'entity_id', 'ac000000-0000-4000-8000-000000000020',
      'payload_schema_version', 1,
      'base_version', 0,
      'payload_hash', public.atlas_sync_payload_hash(
        '{"name":"Different payload"}'
      ),
      'payload_canonical', '{"name":"Different payload"}',
      'payload', '{"name":"Different payload"}'::jsonb
    )
  );

SELECT is(
  (
    SELECT result#>>'{error,code}'
    FROM cloud_sync_protocol_results
    WHERE name = 'mutation_id_reuse'
  ),
  'mutation_id_reused',
  'a mutation id cannot be rebound to different content'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'update_category',
  public.atlas_apply_sync_mutation(
    pg_catalog.jsonb_build_object(
      'protocol_version', 1,
      'mutation_id', 'ac000000-0000-4000-8000-000000000011',
      'workspace_id', 'ac000000-0000-4000-8000-000000000001',
      'actor_id', 'ac000000-0000-4000-8000-000000000002',
      'mutation_type', 'entity.upsert',
      'entity_type', 'categories',
      'entity_id', 'ac000000-0000-4000-8000-000000000020',
      'payload_schema_version', 1,
      'base_version', 1,
      'payload_hash', public.atlas_sync_payload_hash(
        '{"description":"Updated offline"}'
      ),
      'payload_canonical', '{"description":"Updated offline"}',
      'payload', '{"description":"Updated offline"}'::jsonb
    )
  );

SELECT results_eq(
  $$
    SELECT name::text, description::text, version
    FROM public.categories
    WHERE id = 'ac000000-0000-4000-8000-000000000020'
  $$,
  $$VALUES ('Protocol category'::text, 'Updated offline'::text, 2)$$,
  'a partial entity payload preserves omitted fields and advances the version'
);

SELECT is(
  (
    SELECT (result->>'change_seq')::bigint
    FROM cloud_sync_protocol_results
    WHERE name = 'update_category'
  ),
  2::bigint,
  'the category update receives the next workspace change sequence'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'stale_category',
  public.atlas_apply_sync_mutation(
    pg_catalog.jsonb_build_object(
      'protocol_version', 1,
      'mutation_id', 'ac000000-0000-4000-8000-000000000012',
      'workspace_id', 'ac000000-0000-4000-8000-000000000001',
      'actor_id', 'ac000000-0000-4000-8000-000000000002',
      'mutation_type', 'entity.upsert',
      'entity_type', 'categories',
      'entity_id', 'ac000000-0000-4000-8000-000000000020',
      'payload_schema_version', 1,
      'base_version', 1,
      'payload_hash', public.atlas_sync_payload_hash(
        '{"description":"Stale edit"}'
      ),
      'payload_canonical', '{"description":"Stale edit"}',
      'payload', '{"description":"Stale edit"}'::jsonb
    )
  );

SELECT results_eq(
  $$
    SELECT result->>'status', result#>>'{error,code}', (result->>'server_version')::bigint
    FROM cloud_sync_protocol_results
    WHERE name = 'stale_category'
  $$,
  $$VALUES ('conflict'::text, 'version_conflict'::text, 2::bigint)$$,
  'a stale base version returns a typed conflict and current server version'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'unsupported_command',
  public.atlas_apply_sync_mutation(
    pg_catalog.jsonb_build_object(
      'protocol_version', 1,
      'mutation_id', 'ac000000-0000-4000-8000-000000000013',
      'workspace_id', 'ac000000-0000-4000-8000-000000000001',
      'actor_id', 'ac000000-0000-4000-8000-000000000002',
      'mutation_type', 'command.complete_sale',
      'entity_type', 'sales',
      'entity_id', 'ac000000-0000-4000-8000-000000000030',
      'payload_schema_version', 1,
      'payload_hash', public.atlas_sync_payload_hash('{}'),
      'payload_canonical', '{}',
      'payload', '{}'::jsonb
    )
  );

SELECT is(
  (
    SELECT result#>>'{error,code}'
    FROM cloud_sync_protocol_results
    WHERE name = 'unsupported_command'
  ),
  'unsupported_command',
  'transactional workflows fail deterministically until a domain adapter exists'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'id_only_absent_delete',
  public.atlas_apply_sync_mutation(
    pg_catalog.jsonb_build_object(
      'protocol_version', 1,
      'mutation_id', 'ac000000-0000-4000-8000-000000000014',
      'workspace_id', 'ac000000-0000-4000-8000-000000000001',
      'actor_id', 'ac000000-0000-4000-8000-000000000002',
      'mutation_type', 'entity.delete',
      'entity_type', 'categories',
      'entity_id', 'ac000000-0000-4000-8000-000000000022',
      'payload_schema_version', 1,
      'base_version', 0,
      'payload_hash', public.atlas_sync_payload_hash(
        '{"id":"ac000000-0000-4000-8000-000000000022"}'
      ),
      'payload_canonical', '{"id":"ac000000-0000-4000-8000-000000000022"}',
      'payload', '{"id":"ac000000-0000-4000-8000-000000000022"}'::jsonb
    )
  );

SELECT results_eq(
  $$
    SELECT
      result->>'status',
      (result#>>'{result,already_absent}')::boolean,
      (result->>'server_version')::bigint
    FROM cloud_sync_protocol_results
    WHERE name = 'id_only_absent_delete'
  $$,
  $$VALUES ('acknowledged'::text, true, 0::bigint)$$,
  'an ID-only delete with base zero is idempotently acknowledged when absent'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'legacy_hard_delete_normalized',
  public.atlas_apply_sync_mutation(
    pg_catalog.jsonb_build_object(
      'protocol_version', 1,
      'mutation_id', 'ac000000-0000-4000-8000-000000000015',
      'workspace_id', 'ac000000-0000-4000-8000-000000000001',
      'actor_id', 'ac000000-0000-4000-8000-000000000002',
      'mutation_type', 'entity.delete',
      'entity_type', 'categories',
      'entity_id', 'ac000000-0000-4000-8000-000000000020',
      'payload_schema_version', 1,
      'base_version', 2,
      'payload_hash', public.atlas_sync_payload_hash(
        '{"hard_delete":true,"id":"ac000000-0000-4000-8000-000000000020"}'
      ),
      'payload_canonical', '{"hard_delete":true,"id":"ac000000-0000-4000-8000-000000000020"}',
      'payload', '{"id":"ac000000-0000-4000-8000-000000000020","hard_delete":true}'::jsonb
    )
  );

SELECT results_eq(
  $$
    SELECT
      result->>'status',
      result#>>'{result,delete_mode}',
      (result#>>'{result,entity,is_deleted}')::boolean,
      (result->>'server_version')::bigint,
      (result->>'change_seq')::bigint
    FROM cloud_sync_protocol_results
    WHERE name = 'legacy_hard_delete_normalized'
  $$,
  $$VALUES ('acknowledged'::text, 'soft'::text, true, 3::bigint, 3::bigint)$$,
  'legacy hard-delete markers normalize to an optimistic soft delete'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'first_pull_page',
  public.atlas_pull_workspace_changes(
    'ac000000-0000-4000-8000-000000000001',
    0,
    1,
    true
  );

SELECT results_eq(
  $$
    SELECT
      result->>'status',
      (result->>'next_cursor')::bigint,
      (result->>'watermark')::bigint,
      (result->>'has_more')::boolean,
      pg_catalog.jsonb_array_length(result->'changes')
    FROM cloud_sync_protocol_results
    WHERE name = 'first_pull_page'
  $$,
  $$VALUES ('ok'::text, 1::bigint, 3::bigint, true, 1)$$,
  'pull uses a stable watermark and keyset cursor pagination'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'second_pull_page',
  public.atlas_pull_workspace_changes(
    'ac000000-0000-4000-8000-000000000001',
    1,
    10,
    true
  );

SELECT results_eq(
  $$
    SELECT
      (result->>'next_cursor')::bigint,
      (result->>'has_more')::boolean,
      result#>>'{changes,0,operation}',
      (result#>>'{changes,0,entity_version}')::bigint
    FROM cloud_sync_protocol_results
    WHERE name = 'second_pull_page'
  $$,
  $$VALUES (3::bigint, false, 'upsert'::text, 2::bigint)$$,
  'the next pull page resumes strictly after the prior cursor'
);

INSERT INTO public.categories (
  id,
  workspace_id,
  name,
  description,
  version,
  is_deleted,
  created_by
)
VALUES (
  'ac000000-0000-4000-8000-000000000021',
  'ac000000-0000-4000-8000-000000000001',
  'Legacy compatibility category',
  'Direct write during phased cutover',
  1,
  false,
  'ac000000-0000-4000-8000-000000000002'
);

SELECT is(
  (
    public.atlas_pull_workspace_changes(
      'ac000000-0000-4000-8000-000000000001',
      3,
      10,
      true
    )#>>'{changes,0,entity_id}'
  ),
  'ac000000-0000-4000-8000-000000000021',
  'allowlisted legacy direct writes enter the change feed during phased cutover'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'snapshot_page_1',
  public.atlas_get_workspace_sync_snapshot(
    'ac000000-0000-4000-8000-000000000001',
    NULL,
    '',
    NULL,
    1
  );

SELECT results_eq(
  $$
    SELECT
      result->>'status',
      (result->>'snapshot_watermark')::bigint,
      (result->>'has_more')::boolean,
      result#>>'{rows,0,entity_type}',
      pg_catalog.jsonb_array_length(result->'entity_types')
    FROM cloud_sync_protocol_results
    WHERE name = 'snapshot_page_1'
  $$,
  $$VALUES ('ok'::text, 4::bigint, true, 'categories'::text, 8)$$,
  'the snapshot captures one watermark and advertises the exact v1 entity contract'
);

INSERT INTO cloud_sync_protocol_results (name, result)
SELECT
  'snapshot_page_2',
  public.atlas_get_workspace_sync_snapshot(
    'ac000000-0000-4000-8000-000000000001',
    (first_page.result->>'snapshot_watermark')::bigint,
    first_page.result->>'next_entity_type',
    (first_page.result->>'next_entity_id')::uuid,
    100
  )
FROM cloud_sync_protocol_results AS first_page
WHERE first_page.name = 'snapshot_page_1';

SELECT results_eq(
  $$
    SELECT
      result->>'status',
      (result->>'snapshot_watermark')::bigint,
      (result->>'has_more')::boolean,
      result#>>'{rows,0,entity_id}'
    FROM cloud_sync_protocol_results
    WHERE name = 'snapshot_page_2'
  $$,
  $$VALUES (
    'ok'::text,
    4::bigint,
    false,
    'ac000000-0000-4000-8000-000000000021'::text
  )$$,
  'snapshot pagination resumes after the composite entity cursor without changing watermark'
);

RESET ROLE;

UPDATE private.atlas_workspace_change_log
SET changed_at = pg_catalog.now() - INTERVAL '181 days'
WHERE workspace_id = 'ac000000-0000-4000-8000-000000000001';

SELECT is(
  private.atlas_prune_workspace_change_log(
    pg_catalog.now() - INTERVAL '180 days',
    100
  ),
  4,
  'the retention job prunes change rows older than 180 days'
);

SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"ac000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

SELECT results_eq(
  $$
    SELECT
      response->>'status',
      (response->>'snapshot_required')::boolean,
      response#>>'{error,code}',
      (response->>'snapshot_watermark')::bigint
    FROM (
      SELECT public.atlas_pull_workspace_changes(
        'ac000000-0000-4000-8000-000000000001',
        0,
        100,
        true
      ) AS response
    ) AS pull
  $$,
  $$VALUES ('snapshot_required'::text, true, 'cursor_expired'::text, 4::bigint)$$,
  'an expired cursor requires a consistent snapshot at the returned watermark'
);

SELECT is(
  (
    public.atlas_pull_workspace_changes(
      'ac000000-0000-4000-8000-000000000001',
      4,
      100,
      true
    )->>'status'
  ),
  'ok',
  'the latest cursor remains valid after retained history is pruned'
);

SELECT is(
  (
    public.atlas_get_workspace_sync_snapshot(
      'ac000000-0000-4000-8000-000000000001',
      4,
      '',
      NULL,
      100
    )->>'status'
  ),
  'ok',
  'the snapshot watermark remains replayable at the retained feed boundary'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
