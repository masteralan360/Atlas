BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT is(billing.calculate_payg_amount(
  (SELECT id FROM billing.payg_pricing_versions WHERE retired_at IS NULL),
  1000000000
), 0::numeric, 'one GB is free');
SELECT is(billing.calculate_payg_amount(
  (SELECT id FROM billing.payg_pricing_versions WHERE retired_at IS NULL),
  3000000000
), 1429::numeric, 'three exact decimal GB linearly interpolate to 1,429 IQD');
SELECT is(billing.calculate_payg_amount(
  (SELECT id FROM billing.payg_pricing_versions WHERE retired_at IS NULL),
  3002000000
), 1430::numeric, 'exact bytes are used and only the final IQD amount is rounded');
SELECT is(billing.calculate_payg_amount(
  (SELECT id FROM billing.payg_pricing_versions WHERE retired_at IS NULL),
  15000000000
), 10000::numeric, 'the protected 15 GB checkpoint is exact');
SELECT is(billing.calculate_payg_amount(
  (SELECT id FROM billing.payg_pricing_versions WHERE retired_at IS NULL),
  100000000000
), 40000::numeric, 'the protected 100 GB checkpoint is exact');

SELECT throws_ok(
  $$SELECT billing.validate_payg_checkpoints('[{"gb":1,"amount_iqd":1},{"gb":15,"amount_iqd":9999},{"gb":100,"amount_iqd":40000}]'::jsonb)$$,
  '23514', 'required_payg_pricing_checkpoints_missing',
  'the free 1 GB checkpoint cannot be edited'
);
SELECT throws_ok(
  $$SELECT billing.validate_payg_checkpoints('[{"gb":1,"amount_iqd":0},{"gb":15,"amount_iqd":10000},{"gb":20,"amount_iqd":9000},{"gb":100,"amount_iqd":40000}]'::jsonb)$$,
  '23514', 'invalid_payg_pricing_schedule',
  'pricing totals cannot decrease'
);

INSERT INTO public.workspaces (id, name, subscription_expires_at, data_mode)
VALUES
  ('93000000-0000-0000-0000-000000000001', 'PAYG family source', now() + interval '1 year', 'cloud'),
  ('93000000-0000-0000-0000-000000000002', 'PAYG family branch', now() + interval '1 year', 'hybrid'),
  ('93000000-0000-0000-0000-000000000003', 'PAYG free cycle', now() + interval '1 year', 'cloud'),
  ('93000000-0000-0000-0000-000000000004', 'PAYG local rejected', now() + interval '1 year', 'local'),
  ('93000000-0000-0000-0000-000000000005', 'PAYG staged monthly switch', now() + interval '1 year', 'cloud'),
  ('93000000-0000-0000-0000-000000000006', 'Existing free monthly subscription', now() + interval '1 year', 'cloud');

INSERT INTO public.workspace_branches (source_workspace_id, branch_workspace_id, name)
VALUES ('93000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000002', 'PAYG branch');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '94000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'payg-admin@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"PAYG Admin","role":"admin","workspace_id":"93000000-0000-0000-0000-000000000002"}'::jsonb,
  now(), now()
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  $$INSERT INTO billing.workspace_payment_configurations (
    workspace_id, subscription_amount, is_payment_enabled, usage_enabled, gb_per_payment
  ) VALUES (
    '93000000-0000-0000-0000-000000000006', 0, true, false, 0
  )$$,
  'enabled zero-IQD monthly subscriptions remain valid after adding PAYG'
);
SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration_v2(
    '93000000-0000-0000-0000-000000000001', '0', true, false, true,
    '0', (now() + interval '1 month')::text, 'PAYG test administrator'
  )$$,
  'PAYG can be activated on the family source'
);
SELECT throws_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration_v2(
    '93000000-0000-0000-0000-000000000004', '0', true, false, true,
    '0', (now() + interval '1 month')::text, 'PAYG test administrator'
  )$$,
  '23514', 'payg_requires_cloud_or_hybrid_workspace',
  'local workspaces cannot use PAYG'
);
SELECT throws_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration_v2(
    '93000000-0000-0000-0000-000000000002', '0', true, false, true,
    '0', (now() + interval '1 month')::text, 'PAYG test administrator'
  )$$,
  '23514', 'payg_is_managed_by_source_workspace',
  'a branch cannot own the family PAYG toggle'
);
SELECT is((SELECT count(*) FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open'), 1::bigint, 'activation creates exactly one open family cycle');
SELECT is((SELECT data_transfer_bytes FROM public.workspace_usage WHERE workspace_id = '93000000-0000-0000-0000-000000000001'), 0::bigint, 'activation starts the native charged counter clean');
SELECT results_eq(
  $$SELECT monthly_data_transfer_limit_bytes, tracking_only FROM public.workspace_usage_limits WHERE workspace_id = '93000000-0000-0000-0000-000000000001'$$,
  $$VALUES (NULL::bigint, true)$$,
  'PAYG tracks native charged usage without enforcing a transfer allowance'
);

SELECT is(
  public.apply_workspace_charged_usage(
    '93000000-0000-0000-0000-000000000002', 3000000000, 'tauri', 'payg-test', gen_random_uuid()
  ),
  3000000000::bigint,
  'a branch records PAYG usage through the app native charged-usage counter'
);
SELECT is(
  (SELECT data_transfer_bytes FROM public.workspace_usage WHERE workspace_id = '93000000-0000-0000-0000-000000000001'),
  3000000000::bigint,
  'branch usage accumulates on the source-owned family counter'
);
UPDATE billing.payg_cycles SET renewal_due_at = now() - interval '1 second'
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open';
UPDATE billing.workspace_payment_configurations SET renewal_due_at = now() - interval '1 second'
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
SELECT lives_ok(
  $$SELECT billing.close_due_payg_cycle('93000000-0000-0000-0000-000000000001')$$,
  'a due cycle closes atomically'
);
SELECT results_eq(
  $$SELECT charged_usage_bytes, amount_iqd, status FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'$$,
  $$VALUES (3000000000::bigint, 2000::numeric, 'awaiting_payment'::text)$$,
  'cycle closure freezes exact usage, rounded amount, and awaiting-payment state'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payg_payment('fib', 'PAYG TEST ADMIN')$$,
  'a branch workspace administrator can submit the shared exact PAYG payment'
);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payg_payment('fib', 'PAYG TEST ADMIN')$$,
  'duplicate PAYG submission is idempotent for the same administrator'
);
RESET ROLE;
SELECT is((SELECT count(*) FROM billing.payment_transactions WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'pending'), 1::bigint, 'family concurrency guard permits one pending payment');
SELECT results_eq(
  $$SELECT amount, billed_usage_bytes, billed_usage_gb, payment_type FROM billing.payment_transactions WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'$$,
  $$VALUES (2000::numeric, 3000000000::bigint, 3::numeric, 'payg'::text)$$,
  'the pending transaction is an immutable exact cycle snapshot'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction_v2(%L::uuid, %L, %L, %L, %L)',
    (SELECT id FROM billing.payment_transactions WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'),
    'approved', 'Verified', 'PAYG reviewer', 'PAYG-TEST-1'
  ),
  'approval settles the frozen PAYG cycle'
);
SELECT is((SELECT data_transfer_bytes FROM public.workspace_usage WHERE workspace_id = '93000000-0000-0000-0000-000000000001'), 0::bigint, 'approval resets only the native charged-usage counter');
SELECT is((SELECT count(*) FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'paid'), 1::bigint, 'paid history remains immutable');
SELECT is((SELECT count(*) FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open'), 1::bigint, 'approval starts one clean next cycle');
SELECT ok(
  (SELECT renewal_due_at > now() + interval '27 days' FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open'),
  'approval advances Renewal due by one month from the later of the old deadline or approval time'
);

-- Rejection leaves the frozen obligation open and permits a fresh exact submission.
UPDATE public.workspace_usage SET data_transfer_bytes = 2000000000
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
UPDATE billing.payg_cycles SET renewal_due_at = now() - interval '1 second'
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open';
UPDATE billing.workspace_payment_configurations SET renewal_due_at = now() - interval '1 second'
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
SELECT billing.close_due_payg_cycle('93000000-0000-0000-0000-000000000001');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT public.submit_workspace_payg_payment('qicard', 'PAYG TEST ADMIN');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction_v2(%L::uuid, %L, %L, %L, NULL)',
    (SELECT id FROM billing.payment_transactions WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'pending'),
    'rejected', 'Reference did not match', 'PAYG reviewer'
  ),
  'a PAYG payment can be rejected without changing the obligation'
);
SELECT is((SELECT status FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'awaiting_payment'), 'awaiting_payment', 'rejection keeps the closed cycle awaiting payment');
SELECT is((SELECT payment_transaction_id FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'awaiting_payment'), NULL::uuid, 'rejection unlinks the rejected submission');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payg_payment('fib', 'PAYG TEST ADMIN')$$,
  'a fresh exact submission is allowed after rejection'
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

CREATE TEMP TABLE payg_test_version AS
SELECT id, version_number FROM billing.payg_pricing_versions WHERE retired_at IS NULL;
SELECT throws_ok(
  $$UPDATE billing.payg_pricing_versions SET checkpoints = '[{"gb":1,"amount_iqd":0},{"gb":15,"amount_iqd":10000},{"gb":100,"amount_iqd":39999}]'::jsonb WHERE retired_at IS NULL$$,
  '23514', 'payg_pricing_version_is_immutable',
  'a published pricing version cannot be edited in place'
);
SELECT lives_ok(
  $$SELECT public.admin_publish_payg_pricing_schedule(
    '[{"gb":1,"amount_iqd":0},{"gb":5,"amount_iqd":8000},{"gb":15,"amount_iqd":10000},{"gb":100,"amount_iqd":40000}]'::jsonb,
    'PAYG pricing publisher'
  )$$,
  'a valid intermediate checkpoint publishes atomically as a new version'
);
SELECT is(
  (SELECT pricing_version_id FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'awaiting_payment'),
  (SELECT id FROM payg_test_version),
  'an already-opened cycle retains its frozen pricing version after publish'
);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction_v2(%L::uuid, %L, NULL, %L, %L)',
    (SELECT id FROM billing.payment_transactions WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'pending'),
    'approved', 'PAYG reviewer', 'PAYG-TEST-2'
  ),
  'the replacement submission can be approved'
);
SELECT is(
  (SELECT pricing_version_number FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open'),
  (SELECT version_number FROM billing.payg_pricing_versions WHERE retired_at IS NULL),
  'the next clean cycle uses the newly published pricing version'
);

SELECT lives_ok(
  $$SELECT public.admin_create_payg_profile(
    'Immediate PAYG test profile',
    '[{"gb":1,"amount_iqd":0},{"gb":2,"amount_iqd":2000},{"gb":100,"amount_iqd":100000}]'::jsonb,
    'PAYG pricing publisher'
  )$$,
  'a named PAYG profile can be created without changing existing profiles'
);
UPDATE public.workspace_usage SET data_transfer_bytes = 3000000000
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
SELECT lives_ok(
  format(
    'SELECT public.admin_upsert_workspace_payment_configuration_v3(%L::uuid, %L, true, false, true, %L, %L, %L, NULL, %L, %L::uuid, %L)',
    '93000000-0000-0000-0000-000000000001',
    '0', '0', (SELECT renewal_due_at::text FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open'),
    'PAYG test administrator', 'monthly',
    (SELECT id FROM billing.payg_profiles WHERE name = 'Immediate PAYG test profile'), 'immediate'
  ),
  'an open PAYG cycle can be repriced immediately'
);
SELECT is(
  (SELECT data_transfer_bytes FROM public.workspace_usage WHERE workspace_id = '93000000-0000-0000-0000-000000000001'),
  3000000000::bigint,
  'immediate repricing retains the metered usage'
);
SELECT is(
  (SELECT pricing_profile_name FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open'),
  'Immediate PAYG test profile',
  'the open cycle snapshots the immediately selected profile'
);
SELECT is(
  (SELECT billing.calculate_payg_amount_from_checkpoints(pricing_snapshot, 3000000000) FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001' AND status = 'open'),
  3000::numeric,
  'the retained metered usage is recalculated with the immediate profile'
);

-- A PAYG-to-monthly change with accrued usage is staged through settlement.
SELECT public.admin_upsert_workspace_payment_configuration_v2(
  '93000000-0000-0000-0000-000000000005', '0', true, false, true,
  '0', (now() + interval '1 month')::text, 'PAYG test administrator'
);
SELECT public.apply_workspace_charged_usage(
  '93000000-0000-0000-0000-000000000005', 2000000000, 'tauri', 'payg-test', gen_random_uuid()
);
SELECT public.admin_upsert_workspace_payment_configuration_v2(
  '93000000-0000-0000-0000-000000000005', '50000', true, false, false,
  '0', NULL, 'PAYG test administrator'
);
SELECT results_eq(
  $$SELECT payg_enabled, pending_billing_mode FROM billing.workspace_payment_configurations WHERE workspace_id = '93000000-0000-0000-0000-000000000005'$$,
  $$VALUES (true, 'monthly'::text)$$,
  'switching away with accrued usage keeps PAYG active and stages Monthly subscription'
);
UPDATE billing.payg_cycles SET renewal_due_at = now() - interval '1 second'
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000005' AND status = 'open';
UPDATE billing.workspace_payment_configurations SET renewal_due_at = now() - interval '1 second'
WHERE workspace_id = '93000000-0000-0000-0000-000000000005';
SELECT billing.close_due_payg_cycle('93000000-0000-0000-0000-000000000005');
UPDATE public.profiles SET workspace_id = '93000000-0000-0000-0000-000000000005'
WHERE id = '94000000-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT public.submit_workspace_payg_payment('fib', 'PAYG TEST ADMIN');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT public.admin_review_workspace_payment_transaction_v2(
  (SELECT id FROM billing.payment_transactions WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000005' AND status = 'pending'),
  'approved', 'Verified', 'PAYG reviewer', 'PAYG-TO-MONTHLY'
);
SELECT results_eq(
  $$SELECT payg_enabled, usage_enabled, subscription_amount FROM billing.workspace_payment_configurations WHERE workspace_id = '93000000-0000-0000-0000-000000000005'$$,
  $$VALUES (false, false, 50000::numeric)$$,
  'approval applies the staged 50,000 IQD Monthly subscription outside PAYG'
);
SELECT is((SELECT count(*) FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000005' AND status = 'open'), 0::bigint, 'a staged switch does not start another PAYG cycle');
SELECT is((SELECT data_transfer_bytes FROM public.workspace_usage WHERE workspace_id = '93000000-0000-0000-0000-000000000005'), 0::bigint, 'settlement leaves the audited native counter clean');

-- Immediate termination finalizes at the current meter and then stages the
-- no-PAYG state through the established payment settlement flow.
SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration_v3(
    '93000000-0000-0000-0000-000000000006', '0', true, false, true,
    '0', (now() + interval '1 month')::text, 'PAYG test administrator',
    NULL, 'monthly', NULL, 'next_cycle'
  )$$,
  'a workspace can be prepared for immediate PAYG termination'
);
SELECT is(
  public.apply_workspace_charged_usage(
    '93000000-0000-0000-0000-000000000006', 3000000000, 'tauri', 'payg-termination-test', gen_random_uuid()
  ),
  3000000000::bigint,
  'the final PAYG meter records exact charged usage before termination'
);
SELECT lives_ok(
  $$SELECT public.admin_terminate_workspace_payg(
    '93000000-0000-0000-0000-000000000006', 'PAYG test administrator'
  )$$,
  'an administrator can terminate an open PAYG cycle immediately'
);
SELECT results_eq(
  $$SELECT charged_usage_bytes, amount_iqd, status
    FROM billing.payg_cycles
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000006'$$,
  $$VALUES (3000000000::bigint, 2000::numeric, 'awaiting_payment'::text)$$,
  'immediate termination freezes the Standard PAYG amount and exact metered bytes'
);
SELECT results_eq(
  $$SELECT payg_enabled, pending_billing_mode, pending_payment_enabled
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '93000000-0000-0000-0000-000000000006'$$,
  $$VALUES (true, 'monthly'::text, false)$$,
  'chargeable termination keeps payment access while staging PAYG off'
);
SELECT is(
  public.apply_workspace_charged_usage(
    '93000000-0000-0000-0000-000000000006', 1000000000, 'tauri', 'payg-termination-test', gen_random_uuid()
  ),
  0::bigint,
  'a terminated awaiting-payment cycle accepts no additional PAYG usage'
);
SELECT is(
  (SELECT count(*) FROM billing.payment_transactions
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000006'),
  0::bigint,
  'termination creates an unpaid obligation but never fabricates a payment transaction'
);
UPDATE public.profiles SET workspace_id = '93000000-0000-0000-0000-000000000006'
WHERE id = '94000000-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT lives_ok(
  $$SELECT public.submit_workspace_payg_payment('fib', 'PAYG TEST ADMIN')$$,
  'the final termination charge remains payable through the regular PAYG payment flow'
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction_v2(%L::uuid, %L, %L, %L, %L)',
    (SELECT id FROM billing.payment_transactions WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000006' AND status = 'pending'),
    'approved', 'Verified', 'PAYG reviewer', 'PAYG-TERMINATION'
  ),
  'the ordinary approval flow settles an immediate termination payment'
);
SELECT results_eq(
  $$SELECT payg_enabled, is_payment_enabled, usage_enabled
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '93000000-0000-0000-0000-000000000006'$$,
  $$VALUES (false, false, false)$$,
  'settling an immediate termination disables PAYG without enabling another billing mode'
);
SELECT is(
  (SELECT count(*) FROM billing.payg_cycles
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000006' AND status = 'open'),
  0::bigint,
  'settling immediate termination does not start another PAYG cycle'
);
SELECT results_eq(
  $$SELECT payment_type, amount, status
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000006'$$,
  $$VALUES ('payg'::text, 2000::numeric, 'approved'::text)$$,
  'the actual final payment remains an immutable approved PAYG transaction'
);
SELECT throws_ok(
  $$SELECT public.admin_terminate_workspace_payg(
    '93000000-0000-0000-0000-000000000006', 'PAYG test administrator'
  )$$,
  '23514', 'payg_is_not_enabled',
  'a completed termination cannot be repeated'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration_v2(
    '93000000-0000-0000-0000-000000000003', '0', true, false, true,
    '0', (now() + interval '1 month')::text, 'PAYG test administrator'
  )$$,
  'a second PAYG family can be activated'
);
UPDATE public.workspace_usage SET data_transfer_bytes = 1000000000
WHERE workspace_id = '93000000-0000-0000-0000-000000000003';
UPDATE billing.payg_cycles SET renewal_due_at = now() - interval '1 second'
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000003' AND status = 'open';
UPDATE billing.workspace_payment_configurations SET renewal_due_at = now() - interval '1 second'
WHERE workspace_id = '93000000-0000-0000-0000-000000000003';
SELECT lives_ok(
  $$SELECT billing.close_due_payg_cycle('93000000-0000-0000-0000-000000000003')$$,
  'a free-threshold cycle auto-settles'
);
SELECT is((SELECT count(*) FROM billing.payg_cycles WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000003' AND status = 'no_payment_required'), 1::bigint, 'zero-IQD cycles retain no-payment-required audit history');
SELECT is((SELECT count(*) FROM billing.payment_transactions WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000003'), 0::bigint, 'zero-IQD cycles do not create payment submissions');
SELECT lives_ok(
  $$SELECT public.admin_terminate_workspace_payg(
    '93000000-0000-0000-0000-000000000003', 'PAYG test administrator'
  )$$,
  'a free open PAYG cycle can terminate immediately without waiting for a future renewal'
);
SELECT is(
  (SELECT status FROM billing.payg_cycles
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000003'
    ORDER BY closed_at DESC NULLS LAST
    LIMIT 1),
  'no_payment_required',
  'free immediate termination creates a settled immutable cycle'
);
SELECT results_eq(
  $$SELECT payg_enabled, is_payment_enabled, usage_enabled
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '93000000-0000-0000-0000-000000000003'$$,
  $$VALUES (false, false, false)$$,
  'a free immediate termination disables PAYG at once'
);

-- PAYG limiter configuration is owned by the existing billing workspace and
-- evaluates the values returned by the canonical PAYG summary.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration_v2(
    '93000000-0000-0000-0000-000000000006', '0', true, false, true,
    '0', (now() + interval '1 month')::text, 'PAYG limiter test'
  )$$,
  'PAYG can be re-enabled for limiter coverage'
);
UPDATE public.workspace_usage
SET data_transfer_bytes = 15000000000
WHERE workspace_id = '93000000-0000-0000-0000-000000000006';
UPDATE public.profiles
SET workspace_id = '93000000-0000-0000-0000-000000000006', role = 'admin'
WHERE id = '94000000-0000-0000-0000-000000000001';
INSERT INTO crm.customers (id, workspace_id, partner_name, name)
VALUES (
  '95000000-0000-0000-0000-000000000006',
  '93000000-0000-0000-0000-000000000006',
  'PAYG limiter customer',
  'PAYG limiter customer'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
SELECT is(
  public.admin_upsert_workspace_payg_limit('accrued_charge', 1)
    ->'payg_limit_state'->>'locked',
  'true',
  'the inclusive accrued-charge threshold locks at or above the configured value'
);
SELECT throws_ok(
  $$SELECT public.admin_upsert_workspace_payg_limit('accrued_charge', 'NaN'::numeric)$$,
  '22023', 'invalid_workspace_payg_limit_threshold',
  'non-finite thresholds are rejected by the backend'
);
SELECT throws_ok(
  $$SELECT public.admin_upsert_workspace_payg_limit('accrued_charge', 10000)$$,
  '23514', 'workspace_payg_limit_must_exceed_current_usage',
  'a locked admin cannot choose a threshold equal to current accrued charge'
);
SELECT is(
  public.admin_upsert_workspace_payg_limit('accrued_charge', 10001)
    ->'payg_limit_state'->>'locked',
  'false',
  'raising the accrued-charge threshold above current usage clears the lock'
);
SELECT is(
  public.admin_upsert_workspace_payg_limit('changed_usage', 16)
    ->'payg_limit_state'->>'locked',
  'false',
  'an unselected accrued charge above 16 does not lock the changed-usage metric'
);
SELECT is(
  public.admin_upsert_workspace_payg_limit('changed_usage', 15)
    ->'payg_limit_state'->>'locked',
  'true',
  'changed usage locks at equality when it is the selected metric'
);
SELECT throws_ok(
  $$UPDATE crm.customers
    SET name = name
    WHERE id = '95000000-0000-0000-0000-000000000006'$$,
  '42501', 'workspace_payg_limit_reached',
  'workspace business-data writes are rejected while the PAYG limit is reached'
);
SELECT lives_ok(
  $$SELECT public.apply_workspace_charged_usage(
    '93000000-0000-0000-0000-000000000006', 1, 'tauri', 'payg-limit-test', gen_random_uuid()
  )$$,
  'the PAYG metering counter continues to record usage after the lock is reached'
);

RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.profiles
SET role = 'staff'
WHERE id = '94000000-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$SELECT public.admin_upsert_workspace_payg_limit('changed_usage', 20)$$,
  '42501', 'workspace_payg_limit_admin_required',
  'staff cannot change the PAYG threshold through the backend RPC'
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.profiles
SET role = 'admin'
WHERE id = '94000000-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
SELECT lives_ok(
  $$SELECT public.admin_delete_workspace_payg_limit()$$,
  'an administrator can remove the active PAYG limit'
);
SELECT is(
  (public.get_workspace_payg_limit_state()->>'locked')::boolean,
  false,
  'removing a PAYG limit disables this lock condition'
);
SELECT is(
  (SELECT count(*) FROM billing.workspace_payg_limits
   WHERE workspace_id = '93000000-0000-0000-0000-000000000006'),
  0::bigint,
  'removal hard-deletes the PAYG limit row'
);
SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'billing.workspace_payg_limits'::regclass
     AND NOT tgisinternal
     AND tgname ILIKE '%audit%'),
  0::bigint,
  'PAYG limit changes have no audit trigger'
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  $$INSERT INTO billing.workspace_payg_limits (workspace_id, threshold)
    VALUES ('93000000-0000-0000-0000-000000000006', 100000)$$,
  'a new PAYG limit can omit its metric'
);
SELECT is(
  (SELECT metric FROM billing.workspace_payg_limits
   WHERE workspace_id = '93000000-0000-0000-0000-000000000006'),
  'accrued_charge',
  'Accrued Charge is the database default metric'
);
DELETE FROM billing.workspace_payg_limits
WHERE workspace_id = '93000000-0000-0000-0000-000000000006';

SELECT * FROM finish();
ROLLBACK;
