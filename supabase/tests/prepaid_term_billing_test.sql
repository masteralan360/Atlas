BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT is(
  billing.prepaid_term_paid_through('2026-08-01'::date, 5),
  '2027-01-01 00:00:00+00'::timestamptz,
  'five prepaid monthly cycles from August 1 are paid through January 1'
);
SELECT is(
  billing.prepaid_term_paid_through('2024-01-31'::date, 1),
  '2024-02-29 00:00:00+00'::timestamptz,
  'month-end prepaid terms clamp to leap-day'
);

INSERT INTO public.workspaces (id, name, subscription_expires_at, data_mode)
VALUES (
  '95000000-0000-0000-0000-000000000001',
  'Prepaid term workspace',
  now() + interval '1 year',
  'cloud'
);

SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT throws_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term(%L::uuid, %L, %L, %s, %L, %L, %L)',
    '95000000-0000-0000-0000-000000000001',
    '10000',
    '15',
    5,
    '50000',
    current_date::text,
    'Unauthorized prepaid term caller'
  ),
  '42501',
  'workspace_payment_admin_required',
  'prepaid-term activation requires the platform service role'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

SELECT is(
  (
    SELECT count(*)
    FROM pg_constraint
    WHERE conrelid = 'billing.payment_transactions'::regclass
      AND conname IN (
        'payment_transactions_provider_check',
        'workspace_payment_transactions_provider_check'
      )
  ),
  1::bigint,
  'upgraded databases retain exactly one consolidated payment-provider constraint'
);
SELECT ok(
  COALESCE((
    SELECT pg_get_constraintdef(oid) LIKE '%manual%'
    FROM pg_constraint
    WHERE conrelid = 'billing.payment_transactions'::regclass
      AND conname = 'workspace_payment_transactions_provider_check'
  ), false),
  'the consolidated provider constraint permits service-role manual activation'
);

SELECT lives_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term(%L::uuid, %L, %L, %s, %L, %L, %L)',
    '95000000-0000-0000-0000-000000000001',
    '10000',
    '15',
    5,
    '50000',
    current_date::text,
    'Prepaid term test administrator'
  ),
  'an administrator can record and activate the 50,000 IQD five-month prepaid term'
);

SELECT results_eq(
  $$
    SELECT
      billing_interval,
      subscription_amount,
      monthly_allowance_gb,
      prepaid_cycles,
      prepaid_allowance_mode,
      term_allowance_gb,
      prepaid_amount,
      prepaid_term_started_at,
      renewal_due_at,
      usage_enabled,
      payg_enabled
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '95000000-0000-0000-0000-000000000001'
  $$,
  format(
    $$VALUES ('prepaid_term'::text, 10000::numeric, 15::numeric, 5::smallint, 'term_pool'::text, 75::numeric, 50000::numeric, %L::date, billing.prepaid_term_paid_through(%L::date, 5), true, false)$$,
    current_date::text,
    current_date::text
  ),
  'the active configuration keeps monthly price, allowance, cycles, amount paid, and paid-through date separate'
);

SELECT results_eq(
  $$
    SELECT
      provider,
      payment_type,
      amount,
      monthly_list_price,
      monthly_allowance_gb,
      prepaid_cycles,
      prepaid_allowance_mode,
      term_allowance_gb,
      status
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '95000000-0000-0000-0000-000000000001'
  $$,
  $$VALUES ('manual'::text, 'prepaid_term'::text, 50000::numeric, 10000::numeric, 15::numeric, 5::smallint, 'term_pool'::text, 75::numeric, 'approved'::text)$$,
  'the incoming payment is one immutable approved prepaid-term transaction'
);
SELECT throws_ok(
  $$
    UPDATE billing.payment_transactions
    SET prepaid_allowance_mode = 'monthly_reset'
    WHERE billing_workspace_id = '95000000-0000-0000-0000-000000000001'
      AND payment_type = 'prepaid_term'
  $$,
  '23514',
  'workspace_payment_transaction_snapshot_is_immutable',
  'approved prepaid-term financial snapshots cannot be edited'
);

SELECT results_eq(
  $$
    SELECT monthly_data_transfer_limit_bytes, tracking_only
    FROM public.workspace_usage_limits
    WHERE workspace_id = '95000000-0000-0000-0000-000000000001'
  $$,
  $$VALUES (75000000000::bigint, false)$$,
  'the complete five-cycle allowance is enforced as one 75 GB term pool'
);
SELECT results_eq(
  $$
    SELECT data_transfer_bytes, purchased_credit_bytes
    FROM public.workspace_usage
    WHERE workspace_id = '95000000-0000-0000-0000-000000000001'
  $$,
  $$VALUES (0::bigint, 0::bigint)$$,
  'term activation starts with no charged usage and no carry-forward credit'
);

UPDATE public.workspace_usage
SET data_transfer_bytes = 1000000000
WHERE workspace_id = '95000000-0000-0000-0000-000000000001';

-- Simulate stale Admin Usage data from before prepaid-term activation. An
-- idempotent activation must repair the billing-managed allowance without
-- erasing usage recorded after the original activation.
UPDATE public.workspace_usage_limits
SET
  monthly_data_transfer_limit_bytes = 0,
  tracking_only = true,
  notes = 'Stale manually managed allowance'
WHERE workspace_id = '95000000-0000-0000-0000-000000000001';

SELECT lives_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term(%L::uuid, %L, %L, %s, %L, %L, %L)',
    '95000000-0000-0000-0000-000000000001',
    '10000',
    '15',
    5,
    '50000',
    current_date::text,
    'Prepaid term test administrator'
  ),
  'repeating the exact activation request is idempotent'
);
SELECT is(
  (SELECT count(*) FROM billing.payment_transactions
   WHERE billing_workspace_id = '95000000-0000-0000-0000-000000000001'
     AND payment_type = 'prepaid_term'),
  1::bigint,
  'idempotency keeps exactly one payment transaction'
);
SELECT is(
  (SELECT data_transfer_bytes FROM public.workspace_usage
   WHERE workspace_id = '95000000-0000-0000-0000-000000000001'),
  1000000000::bigint,
  'an idempotent retry does not erase usage recorded after activation'
);
SELECT results_eq(
  $$
    SELECT monthly_data_transfer_limit_bytes, tracking_only, notes
    FROM public.workspace_usage_limits
    WHERE workspace_id = '95000000-0000-0000-0000-000000000001'
  $$,
  $$VALUES (75000000000::bigint, false, 'Non-rollover allowance pool for the complete approved prepaid term.'::text)$$,
  'an idempotent retry repairs the billing-managed term pool'
);

SELECT throws_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term(%L::uuid, %L, %L, %s, %L, %L, %L)',
    '95000000-0000-0000-0000-000000000001',
    '10000',
    '15',
    5,
    '50001',
    current_date::text,
    'Prepaid term test administrator'
  ),
  '23514',
  'invalid_prepaid_term_configuration',
  'amount paid cannot exceed monthly list price multiplied by prepaid cycles'
);
SELECT throws_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term(%L::uuid, %L, %L, %s, %L, %L, %L)',
    '95000000-0000-0000-0000-000000000001',
    '10000',
    '16',
    5,
    '50000',
    current_date::text,
    'Prepaid term test administrator'
  ),
  '23514',
  'prepaid_term_overlaps_existing_term',
  'a different prepaid term cannot overlap an approved active term'
);

UPDATE public.workspace_usage
SET
  data_transfer_bytes = 7000000000,
  purchased_credit_bytes = 3000000000,
  transfer_period_start = public.workspace_usage_period_start(workspace_id)
WHERE workspace_id = '95000000-0000-0000-0000-000000000001';
SELECT public.sync_workspace_usage_periods('95000000-0000-0000-0000-000000000001');
SELECT results_eq(
  $$
    SELECT data_transfer_bytes, purchased_credit_bytes, transfer_period_start
    FROM public.workspace_usage
    WHERE workspace_id = '95000000-0000-0000-0000-000000000001'
  $$,
  $$VALUES (7000000000::bigint, 3000000000::bigint, public.workspace_usage_period_start('95000000-0000-0000-0000-000000000001'::uuid))$$,
  'a full-term pool retains charged usage because it has no monthly reset boundary'
);

INSERT INTO public.workspaces (id, name, subscription_expires_at, data_mode)
VALUES (
  '95000000-0000-0000-0000-000000000002',
  'Monthly reset prepaid workspace',
  now() + interval '1 year',
  'cloud'
);

SELECT lives_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term_v2(%L::uuid, %L, %L, %s, %L, %L, %L, %L)',
    '95000000-0000-0000-0000-000000000002',
    '10000',
    '15',
    5,
    '50000',
    current_date::text,
    'monthly_reset',
    'Prepaid term test administrator'
  ),
  'an administrator can explicitly retain monthly-reset allowance delivery'
);
SELECT results_eq(
  $$
    SELECT prepaid_allowance_mode, term_allowance_gb
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '95000000-0000-0000-0000-000000000002'
  $$,
  $$VALUES ('monthly_reset'::text, 75::numeric)$$,
  'monthly-reset configuration still snapshots the complete purchased allowance'
);
SELECT is(
  (
    SELECT monthly_data_transfer_limit_bytes
    FROM public.workspace_usage_limits
    WHERE workspace_id = '95000000-0000-0000-0000-000000000002'
  ),
  15000000000::bigint,
  'monthly-reset mode enforces only the current 15 GB cycle'
);

UPDATE public.workspace_usage
SET
  data_transfer_bytes = 7000000000,
  purchased_credit_bytes = 3000000000,
  transfer_period_start = public.workspace_usage_period_start(workspace_id) - 1
WHERE workspace_id = '95000000-0000-0000-0000-000000000002';
SELECT public.sync_workspace_usage_periods('95000000-0000-0000-0000-000000000002');
SELECT results_eq(
  $$
    SELECT data_transfer_bytes, purchased_credit_bytes, transfer_period_start
    FROM public.workspace_usage
    WHERE workspace_id = '95000000-0000-0000-0000-000000000002'
  $$,
  $$VALUES (0::bigint, 0::bigint, public.workspace_usage_period_start('95000000-0000-0000-0000-000000000002'::uuid))$$,
  'monthly-reset mode still resets charged usage at a new monthly boundary'
);

SELECT throws_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term_v2(%L::uuid, %L, %L, %s, %L, %L, %L, %L)',
    '95000000-0000-0000-0000-000000000002',
    '10000',
    '15',
    5,
    '50000',
    current_date::text,
    'invalid-mode',
    'Prepaid term test administrator'
  ),
  '22023',
  'invalid_prepaid_allowance_mode',
  'prepaid activation rejects an unknown allowance mode'
);

UPDATE public.workspace_usage
SET data_transfer_bytes = 1000000000
WHERE workspace_id = '95000000-0000-0000-0000-000000000002';

SELECT throws_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term_v3(%L::uuid, %L, %L, %s, %L, %L, %L, false, NULL::uuid, %L)',
    '95000000-0000-0000-0000-000000000002',
    '10000', '16', 5, '40000', current_date::text, 'term_pool',
    'Prepaid term test administrator'
  ),
  '23514',
  'prepaid_term_overlaps_existing_term',
  'an overlapping change still requires explicit replacement'
);

SELECT throws_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term_v3(%L::uuid, %L, %L, %s, %L, %L, %L, true, %L::uuid, %L)',
    '95000000-0000-0000-0000-000000000002',
    '10000', '16', 5, '40000', current_date::text, 'term_pool',
    '95000000-0000-0000-0000-000000000099',
    'Prepaid term test administrator'
  ),
  '23514',
  'prepaid_term_replacement_stale',
  'replacement rejects a stale approved payment ID'
);

SELECT lives_ok(
  format(
    'SELECT public.admin_activate_workspace_prepaid_term_v3(%L::uuid, %L, %L, %s, %L, %L, %L, true, %L::uuid, %L)',
    '95000000-0000-0000-0000-000000000002',
    '10000', '16', 5, '40000', current_date::text, 'term_pool',
    (SELECT prepaid_term_payment_transaction_id
     FROM billing.workspace_payment_configurations
     WHERE workspace_id = '95000000-0000-0000-0000-000000000002'),
    'Prepaid term test administrator'
  ),
  'explicit replacement edits the current approved manual term'
);
SELECT is(
  (SELECT count(*) FROM billing.payment_transactions
   WHERE billing_workspace_id = '95000000-0000-0000-0000-000000000002'
     AND payment_type = 'prepaid_term'),
  1::bigint,
  'replacement keeps a single approved payment transaction'
);
SELECT results_eq(
  $$
    SELECT transaction_row.amount, transaction_row.monthly_allowance_gb,
      transaction_row.prepaid_allowance_mode, transaction_row.term_allowance_gb
    FROM billing.payment_transactions transaction_row
    JOIN billing.workspace_payment_configurations configuration_row
      ON configuration_row.prepaid_term_payment_transaction_id = transaction_row.id
    WHERE configuration_row.workspace_id = '95000000-0000-0000-0000-000000000002'
  $$,
  $$VALUES (40000::numeric, 16::numeric, 'term_pool'::text, 80::numeric)$$,
  'replacement updates the existing payment and its configuration'
);
SELECT is(
  (SELECT count(*) FROM billing.prepaid_term_replacement_audit
   WHERE billing_workspace_id = '95000000-0000-0000-0000-000000000002'
     AND old_record->>'prepaid_allowance_mode' = 'monthly_reset'
     AND new_record->>'prepaid_allowance_mode' = 'term_pool'),
  1::bigint,
  'replacement preserves the previous approved values in audit history'
);
SELECT is(
  (SELECT data_transfer_bytes FROM public.workspace_usage
   WHERE workspace_id = '95000000-0000-0000-0000-000000000002'),
  1000000000::bigint,
  'replacement retains usage already consumed'
);

SELECT * FROM finish();
ROLLBACK;
