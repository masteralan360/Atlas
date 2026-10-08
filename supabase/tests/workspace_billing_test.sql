BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT no_plan();

-- Fixed, test-only UUIDs make cross-query assertions readable. Everything in
-- this file is rolled back, including auth users and audit rows.
INSERT INTO public.workspaces (id, name)
VALUES
  ('91000000-0000-0000-0000-000000000001', 'Billing test - disabled'),
  ('91000000-0000-0000-0000-000000000002', 'Billing test - future subscription'),
  ('91000000-0000-0000-0000-000000000003', 'Billing test - expired subscription'),
  ('91000000-0000-0000-0000-000000000004', 'Billing test - usage'),
  ('91000000-0000-0000-0000-000000000005', 'Billing test - rejection'),
  ('91000000-0000-0000-0000-000000000006', 'Billing test - legacy usage'),
  ('91000000-0000-0000-0000-000000000007', 'Billing test - usage branch'),
  ('91000000-0000-0000-0000-000000000008', 'Billing test - family root'),
  ('91000000-0000-0000-0000-000000000009', 'Billing test - family branch'),
  ('91000000-0000-0000-0000-000000000010', 'Billing test - nested family branch'),
  ('91000000-0000-0000-0000-000000000011', 'Billing test - future nested branch'),
  ('91000000-0000-0000-0000-000000000012', 'Billing test - attachment root'),
  ('91000000-0000-0000-0000-000000000013', 'Billing test - preconfigured usage branch'),
  ('91000000-0000-0000-0000-000000000014', 'Billing test - conflicting branch'),
  ('91000000-0000-0000-0000-000000000015', 'Billing test - restore root'),
  ('91000000-0000-0000-0000-000000000016', 'Billing test - archived branch'),
  ('91000000-0000-0000-0000-000000000017', 'Billing test - legacy usage attachment root'),
  ('91000000-0000-0000-0000-000000000018', 'Billing test - legacy usage attachment target'),
  ('91000000-0000-0000-0000-000000000019', 'Billing test - renewal attachment root'),
  ('91000000-0000-0000-0000-000000000020', 'Billing test - renewal attachment target');

UPDATE public.workspaces
SET deleted_at = now()
WHERE id = '91000000-0000-0000-0000-000000000016';

UPDATE public.workspaces
SET plan = 'enterprise'
WHERE id IN (
  '91000000-0000-0000-0000-000000000004',
  '91000000-0000-0000-0000-000000000008',
  '91000000-0000-0000-0000-000000000009',
  '91000000-0000-0000-0000-000000000010',
  '91000000-0000-0000-0000-000000000012',
  '91000000-0000-0000-0000-000000000015',
  '91000000-0000-0000-0000-000000000017',
  '91000000-0000-0000-0000-000000000019'
);

INSERT INTO public.workspace_branches (
  source_workspace_id,
  branch_workspace_id,
  name
)
VALUES
  (
    '91000000-0000-0000-0000-000000000004',
    '91000000-0000-0000-0000-000000000007',
    'Billing test branch'
  ),
  (
    '91000000-0000-0000-0000-000000000008',
    '91000000-0000-0000-0000-000000000009',
    'Billing family branch'
  ),
  (
    '91000000-0000-0000-0000-000000000009',
    '91000000-0000-0000-0000-000000000010',
    'Billing nested family branch'
  ),
  (
    '91000000-0000-0000-0000-000000000015',
    '91000000-0000-0000-0000-000000000016',
    'Billing archived branch'
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
VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    '92000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'billing-disabled@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Disabled User","role":"admin","workspace_id":"91000000-0000-0000-0000-000000000001"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '92000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'billing-future@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Future User","role":"admin","workspace_id":"91000000-0000-0000-0000-000000000002"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '92000000-0000-0000-0000-000000000003',
    'authenticated', 'authenticated', 'billing-expired@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Expired User","role":"admin","workspace_id":"91000000-0000-0000-0000-000000000003"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '92000000-0000-0000-0000-000000000004',
    'authenticated', 'authenticated', 'billing-usage@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Usage User","role":"admin","workspace_id":"91000000-0000-0000-0000-000000000004"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '92000000-0000-0000-0000-000000000005',
    'authenticated', 'authenticated', 'billing-reject@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Reject User","role":"admin","workspace_id":"91000000-0000-0000-0000-000000000005"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '92000000-0000-0000-0000-000000000006',
    'authenticated', 'authenticated', 'billing-legacy-usage@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Legacy Usage User","role":"admin","workspace_id":"91000000-0000-0000-0000-000000000006"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '92000000-0000-0000-0000-000000000007',
    'authenticated', 'authenticated', 'billing-future-second@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Future Second User","role":"member","workspace_id":"91000000-0000-0000-0000-000000000002"}'::jsonb,
    now(), now()
  );

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000001', '10000', false, false, '0', 'Billing test admin'
  )$$,
  'an administrator can create a disabled workspace payment configuration'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000002', '25000.125', true, false, '0', 'Billing test admin'
  )$$,
  'an administrator can create a subscription configuration with three-decimal precision'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000002', '26000.250', true, false, '0', 'Billing test editor'
  )$$,
  'an administrator can edit an existing configuration'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() + INTERVAL '10 days'
WHERE workspace_id = '91000000-0000-0000-0000-000000000002';

SELECT is(
  (
    SELECT subscription_amount
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000002'
  ),
  26000.250::numeric,
  'configuration edits persist the validated amount'
);

SELECT ok(
  (
    SELECT count(*) >= 2
    FROM billing.workspace_payment_configuration_audit
    WHERE workspace_id = '91000000-0000-0000-0000-000000000002'
  ),
  'configuration creation and editing are audited'
);

SELECT ok(
  jsonb_array_length(public.admin_list_workspace_payment_configurations()) >= 6,
  'the admin configuration list includes configured and unconfigured active workspaces'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000008', '18000', true, false, '0', 'Billing family admin'
  )$$,
  'configuring a family root provisions every existing nested branch'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE public.workspace_usage_owner_id(configuration_row.workspace_id)
      = '91000000-0000-0000-0000-000000000008'
  ),
  3::bigint,
  'root, branch, and nested branch each receive a workspace-specific configuration'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000009', '18123', false, false, '2.75', 'Billing branch editor'
  )$$,
  'a sibling can retain independent price, availability, and GB defaults'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000010', '19000', true, true, '1.25', 'Billing family admin'
  )$$,
  'changing a nested branch to usage billing changes the whole family atomically'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE public.workspace_usage_owner_id(configuration_row.workspace_id)
        = '91000000-0000-0000-0000-000000000008'
      AND configuration_row.usage_enabled
      AND configuration_row.gb_per_payment > 0
  ),
  3::bigint,
  'the family-wide usage mode and a usable GB value are applied to every member'
);

SELECT results_eq(
  $$
    SELECT subscription_amount, is_payment_enabled, gb_per_payment
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000009'
  $$,
  $$VALUES (18123::numeric, false, 2.75::numeric)$$,
  'family-mode conversion preserves a sibling configuration snapshot'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = CASE
  WHEN workspace_id = '91000000-0000-0000-0000-000000000008'
    THEN now() - INTERVAL '2 days'
  ELSE now() + INTERVAL '20 days'
END
WHERE public.workspace_usage_owner_id(workspace_id)
  = '91000000-0000-0000-0000-000000000008';

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000009', '18123', false, true, '2.75', 'Billing branch editor'
  )$$,
  'saving a branch uses the billing-owner renewal boundary'
);

SELECT ok(
  (
    SELECT count(DISTINCT renewal_due_at) = 1
      AND max(renewal_due_at) < now()
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE public.workspace_usage_owner_id(configuration_row.workspace_id)
      = '91000000-0000-0000-0000-000000000008'
  ),
  'a future sibling cannot waive an overdue owner renewal when a branch is saved'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() + INTERVAL '20 days'
WHERE workspace_id IS DISTINCT FROM '91000000-0000-0000-0000-000000000008'
  AND public.workspace_usage_owner_id(workspace_id)
    = '91000000-0000-0000-0000-000000000008';

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000008', '18000', true, true, '1.25', 'Billing family admin'
  )$$,
  'saving the billing owner keeps the same authoritative overdue renewal boundary'
);

SELECT ok(
  (
    SELECT count(DISTINCT renewal_due_at) = 1
      AND max(renewal_due_at) < now()
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE public.workspace_usage_owner_id(configuration_row.workspace_id)
      = '91000000-0000-0000-0000-000000000008'
  ),
  'renewal authority is independent of which family workspace is edited'
);

SELECT throws_ok(
  $$
    UPDATE billing.workspace_payment_configurations
    SET usage_enabled = false
    WHERE workspace_id = '91000000-0000-0000-0000-000000000009'
  $$,
  '23514',
  'workspace_payment_family_usage_mode_mismatch',
  'a direct partial family-mode change remains blocked after the admin RPC returns'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000009', '18500', true, false, '0', 'Billing family admin'
  )$$,
  'a family without usage limits can return to subscription billing atomically'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE public.workspace_usage_owner_id(configuration_row.workspace_id)
        = '91000000-0000-0000-0000-000000000008'
      AND configuration_row.usage_enabled = false
  ),
  3::bigint,
  'the subscription-mode conversion reaches every nested family member'
);

SELECT lives_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '91000000-0000-0000-0000-000000000010',
      '91000000-0000-0000-0000-000000000011',
      'Billing future nested branch'
    )
  $$,
  'adding a nested branch to a configured family provisions it automatically'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000011'
      AND usage_enabled = false
  ),
  'the newly attached nested branch receives the family payment mode'
);

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '91000000-0000-0000-0000-000000000011',
      '91000000-0000-0000-0000-000000000008',
      'Billing cycle attempt'
    )
  $$,
  '23514',
  'workspace_branch_cycle_or_same_family',
  'a sequential opposite attachment cannot create a workspace family cycle'
);

SELECT throws_ok(
  $$
    UPDATE public.workspace_branches
    SET source_workspace_id = '91000000-0000-0000-0000-000000000012'
    WHERE source_workspace_id = '91000000-0000-0000-0000-000000000010'
      AND branch_workspace_id = '91000000-0000-0000-0000-000000000011'
  $$,
  '23514',
  'workspace_branch_relationship_ids_are_immutable',
  'renaming or restoring a branch cannot silently reparent its billing owner'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000013', '22000', true, true, '4', 'Billing attachment admin'
  )$$,
  'a standalone workspace can be configured before it becomes a branch'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000014', '23000', true, false, '0', 'Billing attachment admin'
  )$$,
  'a conflicting standalone branch fixture can be configured'
);

SELECT lives_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '91000000-0000-0000-0000-000000000012',
      '91000000-0000-0000-0000-000000000013',
      'Billing preconfigured branch attachment'
    )
  $$,
  'attaching a preconfigured branch provisions its previously unconfigured owner'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000012'
      AND usage_enabled
      AND gb_per_payment = 4
  ),
  'the owner inherits a safe payment configuration from its first configured branch'
);

INSERT INTO billing.payment_transactions (
  workspace_id,
  billing_workspace_id,
  provider,
  payment_type,
  amount,
  currency
)
VALUES (
  '91000000-0000-0000-0000-000000000014',
  '91000000-0000-0000-0000-000000000014',
  'fib',
  'subscription',
  23000,
  'IQD'
);

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '91000000-0000-0000-0000-000000000012',
      '91000000-0000-0000-0000-000000000014',
      'Billing pending branch attachment'
    )
  $$,
  '23514',
  'workspace_branch_pending_payment_conflict',
  'a branch cannot change billing owner while either family has a pending payment snapshot'
);

SELECT lives_ok(
  $$
    SELECT public.admin_review_workspace_payment_transaction(
      (
        SELECT id
        FROM billing.payment_transactions
        WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000014'
          AND status = 'pending'
      ),
      'rejected',
      'Rejected attachment fixture',
      'Billing attachment reviewer',
      NULL
    )
  $$,
  'the pending attachment fixture can reach a terminal review state'
);

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '91000000-0000-0000-0000-000000000012',
      '91000000-0000-0000-0000-000000000014',
      'Billing reviewed branch attachment'
    )
  $$,
  '23514',
  'workspace_branch_payment_history_conflict',
  'terminal payment history cannot be stranded beneath a new billing owner'
);

DELETE FROM billing.payment_transactions
WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000014';

DELETE FROM billing.payment_transaction_status_audit
WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000014';

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '91000000-0000-0000-0000-000000000012',
      '91000000-0000-0000-0000-000000000014',
      'Billing conflicting branch attachment'
    )
  $$,
  '23514',
  'workspace_payment_family_usage_mode_mismatch',
  'attaching a preconfigured workspace cannot create a mixed-mode family'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000018', '24000', true, true, '2', 'Billing legacy attachment admin'
  )$$,
  'a legacy usage attachment target can be configured'
);

INSERT INTO public.workspace_usage_limits (
  workspace_id,
  monthly_data_transfer_limit_bytes,
  notes
)
VALUES (
  '91000000-0000-0000-0000-000000000018',
  5000000000,
  'Legacy attachment safety fixture'
);

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '91000000-0000-0000-0000-000000000017',
      '91000000-0000-0000-0000-000000000018',
      'Billing legacy usage attachment'
    )
  $$,
  '23514',
  'workspace_branch_usage_state_conflict',
  'owner-keyed legacy usage allowances cannot be stranded by an attachment'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000019', '25000', true, true, '2', 'Billing renewal attachment admin'
  )$$,
  'the first usage-renewal attachment family can be configured'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000020', '26000', true, true, '3', 'Billing renewal target admin'
  )$$,
  'the second usage-renewal attachment family can be configured'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = CASE workspace_id
  WHEN '91000000-0000-0000-0000-000000000019'::uuid
    THEN '2027-01-15T00:00:00Z'::timestamptz
  ELSE '2027-02-15T00:00:00Z'::timestamptz
END
WHERE workspace_id IN (
  '91000000-0000-0000-0000-000000000019',
  '91000000-0000-0000-0000-000000000020'
);

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '91000000-0000-0000-0000-000000000019',
      '91000000-0000-0000-0000-000000000020',
      'Billing renewal mismatch attachment'
    )
  $$,
  '23514',
  'workspace_payment_family_renewal_due_mismatch',
  'usage families with different paid-through dates cannot be merged silently'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000015', '17000', true, false, '0', 'Billing restore admin'
  )$$,
  'configuring a family also provisions its archived branches'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000016'
  ),
  'an archived branch has payment configuration ready before restoration'
);

UPDATE public.workspaces
SET deleted_at = NULL
WHERE id = '91000000-0000-0000-0000-000000000016';

SELECT ok(
  EXISTS (
    SELECT 1
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000016'
  ),
  'restoring the branch preserves its workspace-specific payment configuration'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.admin_review_workspace_payment_transaction(uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated workspace users cannot execute the admin review RPC'
);

SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    'public.workspace_branches',
    'INSERT'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.workspace_branches',
    'DELETE'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.workspace_branches',
    'TRUNCATE'
  ),
  'workspace users cannot bypass service-mediated branch topology checks'
);

SELECT ok(
  NOT has_table_privilege(
    'service_role',
    'billing.workspace_payment_configurations',
    'INSERT'
  )
  AND NOT has_table_privilege(
    'service_role',
    'billing.workspace_payment_configurations',
    'UPDATE'
  )
  AND NOT has_table_privilege(
    'service_role',
    'billing.workspace_payment_configurations',
    'DELETE'
  ),
  'service-role billing configuration writes are restricted to validated RPCs'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('atlas.trusted_workspace_lock_update', 'off', true);
SELECT throws_ok(
  $$
    UPDATE public.workspaces
    SET usage_limit_locked = true
    WHERE id = '91000000-0000-0000-0000-000000000002'
  $$,
  'P0001',
  'Restricted workspace fields cannot be updated from the client',
  'workspace users cannot forge automatic lock provenance'
);
RESET ROLE;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- Disabled payment submission and provider validation are enforced by the
-- server; amount/GB values are never accepted from this user-facing RPC.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$SELECT public.submit_workspace_payment('fib')$$,
  '42501',
  'workspace_payments_disabled',
  'disabled workspace payments cannot be submitted'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$SELECT public.submit_workspace_payment('cash')$$,
  '22023',
  'unsupported_workspace_payment_provider',
  'unsupported providers are rejected'
);
SELECT lives_ok(
  $$SELECT public.grant_workspace_subscription_extra_days(3)$$,
  'a subscription workspace can receive temporary extra days'
);
SELECT throws_ok(
  $$SELECT public.grant_workspace_subscription_extra_days(2)$$,
  '23505',
  'workspace_subscription_extra_days_already_pending',
  'a workspace cannot receive a second pending extra-days grant'
);
SELECT is(
  (
    SELECT extra_days
    FROM billing.workspace_subscription_extra_days
    WHERE workspace_id = '91000000-0000-0000-0000-000000000002'
  ),
  3::smallint,
  'the pending extra-days record stores the selected number of days'
);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payment('FIB')$$,
  'FIB is normalized and creates a pending payment'
);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payment('fib')$$,
  'repeating the same submission is idempotent for the submitting user'
);
RESET ROLE;

SELECT is(
  (
    SELECT count(*)
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000002'
      AND status = 'pending'
  ),
  1::bigint,
  'duplicate clicks produce only one pending transaction'
);

SELECT results_eq(
  $$
    SELECT provider, amount, currency, payment_type
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000002'
      AND status = 'pending'
  $$,
  $$VALUES ('fib'::text, 26000.250::numeric, 'IQD'::text, 'subscription'::text)$$,
  'the pending transaction stores provider and server-side configuration snapshots'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT throws_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000002', '27000', true, true, '1', 'Billing mode editor'
  )$$,
  '23514',
  'workspace_payment_pending_transaction_mode_conflict',
  'a family cannot switch payment type while an incompatible payment is pending'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000007","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$SELECT public.submit_workspace_payment('qicard')$$,
  '42501',
  'workspace_payment_workspace_admin_required',
  'a non-admin workspace user cannot submit a renewal'
);
SELECT throws_ok(
  $$SELECT public.grant_workspace_subscription_extra_days(1)$$,
  '42501',
  'workspace_subscription_extra_days_workspace_admin_required',
  'a non-admin workspace user cannot add extra days'
);
RESET ROLE;

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok(
  $$SELECT public.submit_workspace_payment('fib')$$,
  '42501',
  'permission denied for function submit_workspace_payment',
  'anonymous callers cannot submit workspace payments'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
SELECT throws_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, NULL, %L, NULL)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000002'
        AND status = 'pending'
    ),
    'approved',
    'Unauthorized reviewer'
  ),
  '42501',
  'permission denied for function admin_review_workspace_payment_transaction',
  'workspace users cannot approve transactions'
);
RESET ROLE;

-- Future subscription renewal extends from the existing future date.
CREATE TEMP TABLE workspace_billing_test_state (
  key text PRIMARY KEY,
  value text NOT NULL
) ON COMMIT DROP;

INSERT INTO workspace_billing_test_state (key, value)
SELECT 'future_expiry', renewal_due_at::text
FROM billing.workspace_payment_configurations
WHERE workspace_id = '91000000-0000-0000-0000-000000000002';

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, NULL, %L, %L)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000002'
        AND status = 'pending'
    ),
    'approved',
    'Billing test reviewer',
    'FIB-TEST-1'
  ),
  'an authorized administrator can approve a subscription transaction'
);

SELECT is(
  (
    SELECT renewal_due_at
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000002'
  ),
  (
    SELECT value::timestamptz + INTERVAL '1 month'
      - INTERVAL '3 days'
    FROM workspace_billing_test_state
    WHERE key = 'future_expiry'
  ),
  'a future subscription deducts its temporary extra days from the approved renewal period'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.workspace_subscription_extra_days
    WHERE workspace_id = '91000000-0000-0000-0000-000000000002'
  ),
  0::bigint,
  'the extra-days record is removed only after the adjusted subscription update succeeds'
);

SELECT ok(
  (
    SELECT status = 'approved'
      AND paid_at IS NOT NULL
      AND reviewed_by_label = 'Billing test reviewer'
      AND provider_payment_id = 'FIB-TEST-1'
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000002'
  ),
  'approval records payment and reviewer audit metadata'
);

SELECT throws_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, NULL, %L, NULL)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000002'
    ),
    'approved',
    'Second reviewer'
  ),
  '23514',
  'workspace_payment_transaction_already_reviewed',
  'an approved transaction cannot be applied again'
);

-- An already-expired subscription renews from approval time, not from its old
-- expiry. The bounded check avoids relying on a particular month length.
SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000003', '18000', true, false, '0', 'Billing test admin'
  )$$,
  'the expired subscription receives a payment configuration'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() - INTERVAL '5 days'
WHERE workspace_id = '91000000-0000-0000-0000-000000000003';

UPDATE public.workspaces
SET
  locked_workspace = true,
  subscription_expiry_locked = true
WHERE id = '91000000-0000-0000-0000-000000000003';

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000003', '18000', true, true, '1.5', 'Billing mode editor'
  )$$,
  'an expired subscription workspace can be converted to usage billing'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() + INTERVAL '30 days'
WHERE workspace_id = '91000000-0000-0000-0000-000000000003';
SELECT billing.reconcile_workspace_payment_renewal_lock('91000000-0000-0000-0000-000000000003');

SELECT ok(
  (
    SELECT NOT locked_workspace
      AND NOT subscription_expiry_locked
    FROM public.workspaces
    WHERE id = '91000000-0000-0000-0000-000000000003'
  ),
  'usage mode clears the obsolete subscription-expiry lock reason'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000003', '18000', true, false, '0', 'Billing mode editor'
  )$$,
  'the workspace can return to subscription billing when no usage limit exists'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() - INTERVAL '5 days'
WHERE workspace_id = '91000000-0000-0000-0000-000000000003';
SELECT billing.reconcile_workspace_payment_renewal_lock('91000000-0000-0000-0000-000000000003');

SELECT ok(
  (
    SELECT locked_workspace
      AND subscription_expiry_locked
    FROM public.workspaces
    WHERE id = '91000000-0000-0000-0000-000000000003'
  ),
  'returning to subscription mode reapplies the still-expired subscription lock'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
SELECT set_config('atlas.trusted_workspace_lock_update', 'off', true);
SELECT lives_ok(
  $$SELECT public.grant_workspace_subscription_extra_days(5)$$,
  'the trusted grant RPC can update an expired subscription with a five-day temporary extension'
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Model approval exactly two days into the temporary period. The workspace
-- expiry is also moved to the correct remaining three-day boundary, matching
-- what would have happened had the grant actually been made two days earlier.
UPDATE billing.workspace_subscription_extra_days
SET
  temporary_period_starts_at = now() - INTERVAL '2 days',
  consumed_duration_seconds = 0,
  last_consumption_recorded_at = NULL
WHERE workspace_id = '91000000-0000-0000-0000-000000000003';

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() + INTERVAL '3 days'
WHERE workspace_id = '91000000-0000-0000-0000-000000000003';

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payment('fib')$$,
  'a workspace using temporary days can submit a renewal payment'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, NULL, %L, NULL)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000003'
        AND status = 'pending'
    ),
    'approved',
    'Billing test reviewer'
  ),
  'an administrator can approve an expired subscription renewal'
);

SELECT is(
  (
    SELECT renewal_due_at
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000003'
  ),
  now() + INTERVAL '1 month',
  'approval after two temporary days deducts only the remaining three-day duration'
);

SELECT results_eq(
  $$
    SELECT day_number
    FROM billing.workspace_subscription_extra_day_consumption
    WHERE workspace_id = '91000000-0000-0000-0000-000000000003'
    ORDER BY day_number
  $$,
  $$VALUES (1::smallint), (2::smallint)$$,
  'each completed temporary day has an immutable consumption audit entry'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.workspace_subscription_extra_days
    WHERE workspace_id = '91000000-0000-0000-0000-000000000003'
  ),
  0::bigint,
  'the pending temporary-extension row is removed only after its fair settlement succeeds'
);

SELECT ok(
  (
    SELECT NOT locked_workspace AND NOT subscription_expiry_locked
    FROM public.workspaces
    WHERE id = '91000000-0000-0000-0000-000000000003'
  ),
  'subscription approval clears only the recorded expiry lock'
);

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_usage_limits (
      workspace_id,
      monthly_data_transfer_limit_bytes,
      notes
    )
    VALUES (
      '91000000-0000-0000-0000-000000000002',
      1000000000,
      'Invalid subscription-mode usage limit'
    )
  $$,
  '23514',
  'workspace_payment_configuration_usage_mode_required',
  'usage limits cannot be added while a family is configured for subscription payments'
);

-- Usage top-up: exhaust the recurring base, submit a 2.5 GB snapshot, change
-- configuration to 9 GB, then prove approval still applies exactly 2.5 GB.
INSERT INTO public.workspace_usage_limits (
  workspace_id,
  monthly_data_transfer_limit_bytes,
  notes
)
VALUES (
  '91000000-0000-0000-0000-000000000004',
  1000000000,
  'Billing pgTAP usage fixture'
);

SELECT public.ensure_workspace_usage_row('91000000-0000-0000-0000-000000000004');
UPDATE public.workspace_usage
SET
  data_transfer_bytes = 1000000000
WHERE workspace_id = '91000000-0000-0000-0000-000000000004';

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000004', '30000', true, true, '2.5', 'Billing test admin'
  )$$,
  'an administrator can create a usage-based payment configuration'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$SELECT public.grant_workspace_subscription_extra_days(1)$$,
  '23514',
  'workspace_subscription_extra_days_not_available_for_usage_billing',
  'usage-billed workspaces cannot receive subscription extra days'
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

SELECT throws_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000004', '30000', true, false, '0', 'Billing test admin'
  )$$,
  '23514',
  'workspace_usage_limits_require_usage_payment_configuration',
  'usage payments cannot be disabled while the shared usage limits still exist'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() - INTERVAL '1 day'
WHERE workspace_id = '91000000-0000-0000-0000-000000000004';

SELECT throws_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000007', '31000', true, false, '0', 'Billing test branch admin'
  )$$,
  '23514',
  'workspace_usage_limits_require_usage_payment_configuration',
  'a branch request cannot disable usage payments while the shared usage limits exist'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000007', '31000', true, true, '3', 'Billing test branch admin'
  )$$,
  'a branch usage configuration inherits the shared paid-through boundary'
);

SELECT is(
  (
    SELECT renewal_due_at
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000007'
  ),
  (
    SELECT renewal_due_at
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
  ),
  'source and branch configurations share one renewal due date'
);

SELECT ok(
  (
    SELECT source_workspace.payment_renewal_locked
      AND source_workspace.locked_workspace
      AND branch_workspace.payment_renewal_locked
      AND branch_workspace.locked_workspace
    FROM public.workspaces AS source_workspace
    INNER JOIN public.workspaces AS branch_workspace
      ON branch_workspace.id = '91000000-0000-0000-0000-000000000007'
    WHERE source_workspace.id = '91000000-0000-0000-0000-000000000004'
  ),
  'an overdue usage renewal is durably locked across the workspace family'
);

SELECT is(
  billing.next_workspace_usage_renewal_due(
    '91000000-0000-0000-0000-000000000004',
    '2027-02-28T00:00:00Z'
  ),
  '2027-03-31T00:00:00Z'::timestamptz,
  'usage renewal keeps a day-31 reset anchor after a short month'
);

INSERT INTO workspace_billing_test_state (key, value)
SELECT 'usage_due', renewal_due_at::text
FROM billing.workspace_payment_configurations
WHERE workspace_id = '91000000-0000-0000-0000-000000000004';

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payment('qicard')$$,
  'QiCard is supported for a usage payment'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000004', '99999', true, true, '9', 'Billing test editor'
  )$$,
  'usage configuration may change while an earlier payment is pending'
);

SELECT is(
  (
    SELECT renewal_due_at
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
  ),
  (
    SELECT value::timestamptz
    FROM workspace_billing_test_state
    WHERE key = 'usage_due'
  ),
  'ordinary configuration edits do not waive an overdue renewal'
);

SELECT results_eq(
  $$
    SELECT amount, gb_added, gb_added_bytes
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000004'
      AND status = 'pending'
  $$,
  $$VALUES (30000::numeric, 2.5::numeric, 2500000000::bigint)$$,
  'configuration changes do not mutate an existing transaction snapshot'
);

INSERT INTO workspace_billing_test_state (key, value)
VALUES (
  'expected_usage_due',
  billing.next_workspace_usage_renewal_due(
    '91000000-0000-0000-0000-000000000004',
    now()
  )::text
);

SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, NULL, %L, %L)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000004'
        AND status = 'pending'
    ),
    'approved',
    'Billing test reviewer',
    'QI-TEST-1'
  ),
  'an administrator can approve a usage transaction'
);

SELECT is(
  (
    SELECT purchased_credit_bytes
    FROM public.workspace_usage
    WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
  ),
  2500000000::bigint,
  'usage approval credits the exact transaction GB snapshot'
);

SELECT ok(
  (
    SELECT NOT locked_workspace
      AND NOT usage_limit_locked
      AND NOT payment_renewal_locked
    FROM public.workspaces
    WHERE id = '91000000-0000-0000-0000-000000000004'
  ),
  'approved usage credit restores an access lock caused by exhaustion'
);

SELECT is(
  (
    SELECT renewal_due_at
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
  ),
  (
    SELECT value::timestamptz
    FROM workspace_billing_test_state
    WHERE key = 'expected_usage_due'
  ),
  'usage approval confirms the next monthly renewal boundary'
);

SELECT is(
  (
    SELECT renewal_due_at
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000007'
  ),
  (
    SELECT value::timestamptz
    FROM workspace_billing_test_state
    WHERE key = 'expected_usage_due'
  ),
  'usage approval advances every branch configuration in the shared family'
);

-- Rejection changes status only and allows a new submission.
SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration(
    '91000000-0000-0000-0000-000000000005', '22000', true, false, '0', 'Billing test admin'
  )$$,
  'the rejection workspace receives a configuration'
);

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() + INTERVAL '15 days'
WHERE workspace_id = '91000000-0000-0000-0000-000000000005';

INSERT INTO workspace_billing_test_state (key, value)
SELECT 'rejection_expiry', renewal_due_at::text
FROM billing.workspace_payment_configurations
WHERE workspace_id = '91000000-0000-0000-0000-000000000005';

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000005","role":"authenticated"}',
  true
);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payment('qicard')$$,
  'a transaction can be submitted for later rejection'
);
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, %L, %L, NULL)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000005'
        AND status = 'pending'
    ),
    'rejected',
    'Receipt could not be verified',
    'Billing test reviewer'
  ),
  'an administrator can reject a pending transaction'
);

SELECT ok(
  (
    SELECT status = 'rejected'
      AND paid_at IS NULL
      AND review_note = 'Receipt could not be verified'
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000005'
  ),
  'rejection records status and reason without marking payment paid'
);

SELECT is(
  (
    SELECT renewal_due_at
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '91000000-0000-0000-0000-000000000005'
  ),
  (
    SELECT value::timestamptz
    FROM workspace_billing_test_state
    WHERE key = 'rejection_expiry'
  ),
  'rejection does not extend the subscription'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000005","role":"authenticated"}',
  true
);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payment('fib')$$,
  'the user can submit a new payment after rejection'
);
RESET ROLE;

SELECT is(
  (
    SELECT count(*)
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000005'
      AND status = 'pending'
  ),
  1::bigint,
  'a rejected transaction no longer blocks a new pending transaction'
);

DELETE FROM public.profiles
WHERE id = '92000000-0000-0000-0000-000000000005';

SELECT lives_ok(
  $$DELETE FROM auth.users WHERE id = '92000000-0000-0000-0000-000000000005'$$,
  'payment history does not break the existing administrator user-deletion flow'
);

SELECT ok(
  (
    SELECT bool_and(user_id IS NULL)
      AND bool_and(submitted_by_email = 'billing-reject@example.test')
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000005'
  ),
  'deleted submitters are detached by FK while immutable identity snapshots preserve the audit trail'
);

-- Legacy usage-limit workspaces may not have a payment config yet. Their
-- usage state must not be classified as a monthly subscription expiry.
INSERT INTO public.workspace_usage_limits (
  workspace_id,
  monthly_data_transfer_limit_bytes,
  notes
)
VALUES (
  '91000000-0000-0000-0000-000000000006',
  5000000000,
  'Billing pgTAP legacy usage fixture'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000006","role":"authenticated"}',
  true
);
SELECT is(
  (public.get_workspace_payment_summary() #>> '{eligibility,subscription_expired}')::boolean,
  false,
  'existing usage mode is not falsely classified as an expired subscription'
);
RESET ROLE;

SELECT ok(
  (
    SELECT count(*) = 1
    FROM billing.payment_transaction_status_audit
    WHERE billing_workspace_id = '91000000-0000-0000-0000-000000000004'
      AND to_status = 'approved'
  ),
  'an approved entitlement has one terminal audit transition'
);

-- Free usage is a non-credit reduction of the canonical charged counter. It
-- creates a normal unread inbox item for the workspace administrator.
UPDATE public.workspace_usage
SET data_transfer_bytes = 1000000000
WHERE workspace_id = '91000000-0000-0000-0000-000000000004';

SELECT lives_ok(
  $$SELECT public.admin_grant_workspace_free_usage(
    '91000000-0000-0000-0000-000000000004',
    1500000000
  )$$,
  'a free-usage grant can exceed current charged usage'
);

SELECT is(
  (
    SELECT data_transfer_bytes
    FROM public.workspace_usage
    WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
  ),
  0::bigint,
  'a free-usage grant clamps charged usage at zero and creates no carry-forward credit'
);

SELECT is(
  (
    SELECT count(*)
    FROM notifications.inbox
    WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
      AND user_id = '92000000-0000-0000-0000-000000000004'
      AND notification_type = 'workspace_free_usage_granted'
      AND read_at IS NULL
      AND payload ->> 'granted_bytes' = '1500000000'
  ),
  1::bigint,
  'the free-usage grant creates a normal unread notification for the workspace administrator'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
SELECT is(
  public.mark_notification_inbox_read(
    (
      SELECT id
      FROM notifications.inbox
      WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
        AND user_id = '92000000-0000-0000-0000-000000000004'
        AND notification_type = 'workspace_free_usage_granted'
      ORDER BY created_at DESC
      LIMIT 1
    )
  ),
  true,
  'the workspace administrator can acknowledge the free-usage notification'
);
RESET ROLE;

SELECT is(
  (
    SELECT count(*)
    FROM notifications.inbox
    WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
      AND user_id = '92000000-0000-0000-0000-000000000004'
      AND notification_type = 'workspace_free_usage_granted'
      AND read_at IS NOT NULL
  ),
  1::bigint,
  'acknowledging the free-usage notification marks the normal inbox item as seen'
);

-- Admin messages use the same existing inbox stream. Each workspace admin
-- receives an individually addressed unread notification without a new table.
SELECT lives_ok(
  $$SELECT public.admin_send_workspace_message(
    '91000000-0000-0000-0000-000000000004',
    'Your workspace has an important update.'
  )$$,
  'an admin-console message can be sent to a workspace'
);

SELECT is(
  (
    SELECT count(*)
    FROM notifications.inbox
    WHERE workspace_id = '91000000-0000-0000-0000-000000000004'
      AND user_id = '92000000-0000-0000-0000-000000000004'
      AND notification_type = 'admin_workspace_message'
      AND title = 'Message from Atlas Admin'
      AND body = 'Your workspace has an important update.'
      AND read_at IS NULL
  ),
  1::bigint,
  'an admin-console message creates a normal unread inbox notification for the workspace administrator'
);

SELECT throws_ok(
  $$SELECT public.admin_send_workspace_message(
    '91000000-0000-0000-0000-000000000004',
    '   '
  )$$,
  'P0001',
  'Message is required',
  'blank workspace messages are rejected'
);

SELECT * FROM finish();

ROLLBACK;
