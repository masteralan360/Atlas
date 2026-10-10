BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

INSERT INTO public.workspaces (id, name, data_mode)
VALUES
  ('98100000-0000-0000-0000-000000000001', 'Billing operations owner test', 'cloud'),
  ('98100000-0000-0000-0000-000000000002', 'Billing operations prepaid test', 'cloud'),
  ('98100000-0000-0000-0000-000000000003', 'Billing operations branch test', 'cloud');

SELECT public.ensure_workspace_usage_row('98100000-0000-0000-0000-000000000002');
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

CREATE TEMP TABLE billing_operation_test_snapshots (
  name text PRIMARY KEY,
  payload jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO billing_operation_test_snapshots (name, payload)
VALUES
  ('monthly_first', jsonb_build_object(
    'billing_mode', 'monthly_subscription', 'currency', 'IQD',
    'subscription_amount', '10000', 'is_payment_enabled', true,
    'usage_enabled', false, 'payg_enabled', false, 'gb_per_payment', '0',
    'renewal_due_at', (now() + interval '30 days')::text,
    'record_payment', false
  )),
  ('monthly_second', jsonb_build_object(
    'billing_mode', 'monthly_subscription', 'currency', 'IQD',
    'subscription_amount', '12000', 'is_payment_enabled', true,
    'usage_enabled', false, 'payg_enabled', false, 'gb_per_payment', '0',
    'renewal_due_at', (now() + interval '35 days')::text,
    'record_payment', false
  )),
  ('monthly_adjustment_one', jsonb_build_object(
    'billing_mode', 'monthly_subscription', 'currency', 'IQD',
    'subscription_amount', '15000', 'is_payment_enabled', true,
    'usage_enabled', false, 'payg_enabled', false, 'gb_per_payment', '0',
    'renewal_due_at', (now() + interval '40 days')::text,
    'record_payment', false
  )),
  ('monthly_adjustment_two', jsonb_build_object(
    'billing_mode', 'monthly_subscription', 'currency', 'IQD',
    'subscription_amount', '16000', 'is_payment_enabled', true,
    'usage_enabled', false, 'payg_enabled', false, 'gb_per_payment', '0',
    'renewal_due_at', (now() + interval '45 days')::text,
    'record_payment', false
  )),
  ('monthly_paid', jsonb_build_object(
    'billing_mode', 'monthly_subscription', 'currency', 'IQD',
    'subscription_amount', '16000', 'is_payment_enabled', true,
    'usage_enabled', false, 'payg_enabled', false, 'gb_per_payment', '0',
    'renewal_due_at', (now() + interval '50 days')::text,
    'record_payment', true, 'payment_amount', '5000'
  )),
  ('prepaid_first', jsonb_build_object(
    'billing_mode', 'prepaid_term', 'currency', 'IQD',
    'subscription_amount', '10000', 'monthly_allowance_gb', '10',
    'gb_per_payment', '10', 'is_payment_enabled', true,
    'usage_enabled', true, 'payg_enabled', false,
    'usage_start_date', current_date::text,
    'renewal_due_at', billing.prepaid_term_paid_through(current_date, 2)::text,
    'prepaid_cycles', 2, 'prepaid_allowance_mode', 'term_pool',
    'prepaid_amount', '20000', 'record_payment', true
  ));

CREATE TEMP TABLE billing_operation_test_results (
  name text PRIMARY KEY,
  result jsonb NOT NULL
) ON COMMIT DROP;

SELECT is(
  (SELECT count(*) FROM billing.workspace_billing_live_transactions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000001'),
  1::bigint,
  'a workspace receives exactly one nonfinancial live baseline'
);
SELECT is(
  (SELECT revision.billing_mode
   FROM billing.workspace_billing_live_transactions AS live
   JOIN billing.admin_billing_revisions AS revision ON revision.id = live.current_revision_id
   WHERE live.billing_workspace_id = '98100000-0000-0000-0000-000000000001'),
  'unconfigured'::text,
  'the baseline records an unconfigured workspace without inventing payment terms'
);

INSERT INTO billing_operation_test_results
SELECT 'first', public.admin_create_billing_operation(
  '98100000-0000-0000-0000-000000000001', 'monthly_subscription', payload,
  '98100000-0000-0000-0000-000000000101', 'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'monthly_first';

SELECT ok(
  (SELECT result->>'voucher_code' ~ '^BL-[0-9]{4}-[A-F0-9]{8}$'
   FROM billing_operation_test_results WHERE name = 'first'),
  'a new transaction receives a permanent base voucher'
);
SELECT is(
  (SELECT (result->>'current_live')::boolean
   FROM billing_operation_test_results WHERE name = 'first'),
  true,
  'the committed transaction becomes the current live revision'
);
SELECT is(
  (SELECT count(*) FROM billing.payment_transactions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000001'),
  0::bigint,
  'an unpaid transaction does not create a pending or approved payment'
);

INSERT INTO billing_operation_test_results
SELECT 'first_retry', public.admin_create_billing_operation(
  '98100000-0000-0000-0000-000000000001', 'monthly_subscription', payload,
  '98100000-0000-0000-0000-000000000101', 'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'monthly_first';
SELECT is(
  (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'first_retry'),
  (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'first'),
  'an idempotent create retry returns the original voucher'
);

INSERT INTO billing_operation_test_results
SELECT 'second', public.admin_create_billing_operation(
  '98100000-0000-0000-0000-000000000001', 'monthly_subscription', payload,
  '98100000-0000-0000-0000-000000000102', 'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'monthly_second';
SELECT ok(
  (SELECT first.result->>'voucher_code' <> second.result->>'voucher_code'
   FROM billing_operation_test_results AS first, billing_operation_test_results AS second
   WHERE first.name = 'first' AND second.name = 'second'),
  'a replacement transaction receives a new base voucher instead of a suffix'
);
SELECT is(
  (SELECT count(*) FROM billing.admin_billing_revisions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000001'
     AND revision_type = 'create'),
  2::bigint,
  'the superseded transaction remains preserved in history'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM billing.workspace_billing_live_transactions
    WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000001'
      AND current_revision_id = ((SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'first'))::uuid
  )
  AND EXISTS (
    SELECT 1 FROM billing.workspace_billing_live_transactions
    WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000001'
      AND current_revision_id = ((SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'second'))::uuid
  ),
  'the previous transaction becomes historical when a new base voucher is committed'
);

INSERT INTO billing_operation_test_results
SELECT 'adjustment_one', public.admin_adjust_billing_operation(
  (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'second'),
  ((SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'second'))::uuid,
  payload,
  'Adjust the current monthly subscription price',
  '98100000-0000-0000-0000-000000000103',
  'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'monthly_adjustment_one';
SELECT is(
  (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'adjustment_one'),
  (SELECT result->>'voucher_code' || '-1' FROM billing_operation_test_results WHERE name = 'second'),
  'the first adjustment uses suffix 1 from the base voucher'
);

INSERT INTO billing_operation_test_results
SELECT 'adjustment_two', public.admin_adjust_billing_operation(
  (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'adjustment_one'),
  ((SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'adjustment_one'))::uuid,
  payload,
  'Adjust the current monthly subscription price again',
  '98100000-0000-0000-0000-000000000104',
  'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'monthly_adjustment_two';
SELECT is(
  (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'adjustment_two'),
  (SELECT result->>'voucher_code' || '-2' FROM billing_operation_test_results WHERE name = 'second'),
  'adjusting an adjustment increments from the original base voucher'
);
SELECT is(
  (SELECT live.current_revision_id
   FROM billing.workspace_billing_live_transactions AS live
   WHERE live.billing_workspace_id = '98100000-0000-0000-0000-000000000001'),
  ((SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'adjustment_two'))::uuid,
  'the latest adjustment atomically replaces the live revision'
);
SELECT throws_ok(
  format(
    'UPDATE billing.admin_billing_revisions SET reason = %L WHERE id = %L::uuid',
    'changed',
    (SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'adjustment_one')
  ),
  '23514',
  'admin_billing_revision_is_immutable',
  'historical revision records cannot be edited'
);
SELECT throws_ok(
  format(
    'SELECT public.admin_adjust_billing_operation(%L, %L::uuid, %L::jsonb, %L, %L, %L)',
    (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'second'),
    (SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'adjustment_one'),
    (SELECT payload::text FROM billing_operation_test_snapshots WHERE name = 'monthly_adjustment_two'),
    'Stale adjustment', '98100000-0000-0000-0000-000000000105', 'Billing operations test administrator'
  ),
  '40001',
  'billing_operation_stale_revision',
  'a stale adjustment cannot overwrite newer live values'
);
SELECT throws_ok(
  format(
    'SELECT public.admin_adjust_billing_operation(%L, %L::uuid, %L::jsonb, %L, %L, %L)',
    (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'first'),
    (SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'adjustment_two'),
    (SELECT payload::text FROM billing_operation_test_snapshots WHERE name = 'monthly_adjustment_two'),
    'Historical adjustment attempt', '98100000-0000-0000-0000-000000000106', 'Billing operations test administrator'
  ),
  '23514',
  'billing_operation_superseded',
  'a historical voucher cannot replace a newer live transaction family'
);

INSERT INTO public.workspace_branches (source_workspace_id, branch_workspace_id, name)
VALUES ('98100000-0000-0000-0000-000000000001', '98100000-0000-0000-0000-000000000003', 'Billing operations test branch');
SELECT is(
  public.workspace_usage_owner_id('98100000-0000-0000-0000-000000000003'),
  '98100000-0000-0000-0000-000000000001'::uuid,
  'a branch resolves to its source billing owner'
);
SELECT is(
  (SELECT count(*) FROM billing.workspace_billing_live_transactions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000003'),
  0::bigint,
  'a branch does not create a competing live billing reference'
);
DELETE FROM public.workspace_branches
WHERE branch_workspace_id = '98100000-0000-0000-0000-000000000003';
SELECT is(
  (SELECT count(*) FROM billing.workspace_billing_live_transactions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000003'),
  1::bigint,
  'detaching a branch establishes its independent nonfinancial live baseline'
);

INSERT INTO billing_operation_test_results
SELECT 'paid', public.admin_create_billing_operation(
  '98100000-0000-0000-0000-000000000001', 'monthly_subscription', payload,
  '98100000-0000-0000-0000-000000000107', 'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'monthly_paid';
INSERT INTO billing_operation_test_results
SELECT 'paid_retry', public.admin_create_billing_operation(
  '98100000-0000-0000-0000-000000000001', 'monthly_subscription', payload,
  '98100000-0000-0000-0000-000000000107', 'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'monthly_paid';
SELECT is(
  (SELECT count(*) FROM billing.payment_transactions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000001'),
  1::bigint,
  'an explicitly confirmed payment is recorded once even when its submission is retried'
);
SELECT is(
  (SELECT status FROM billing.payment_transactions
   WHERE id = ((SELECT result->>'payment_transaction_id' FROM billing_operation_test_results WHERE name = 'paid'))::uuid),
  'approved'::text,
  'an explicitly confirmed monthly payment uses the existing approval workflow'
);
SELECT is(
  (public.admin_get_billing_operation(
    (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'paid')
  )->>'current_live_payment_status'),
  'approved'::text,
  'transaction details show the live cycle payment status from the payment ledger'
);

INSERT INTO billing_operation_test_results
SELECT 'prepaid', public.admin_create_billing_operation(
  '98100000-0000-0000-0000-000000000002', 'prepaid_term', payload,
  '98100000-0000-0000-0000-000000000201', 'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'prepaid_first';

INSERT INTO billing_operation_test_results
SELECT 'prepaid_adjustment', public.admin_adjust_billing_operation(
  (SELECT result->>'voucher_code' FROM billing_operation_test_results WHERE name = 'prepaid'),
  ((SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'prepaid'))::uuid,
  jsonb_set(payload, '{prepaid_amount}', '"18000"'::jsonb),
  'Correct the manually approved prepaid amount',
  '98100000-0000-0000-0000-000000000202',
  'Billing operations test administrator'
)
FROM billing_operation_test_snapshots WHERE name = 'prepaid_first';
SELECT is(
  (SELECT count(*) FROM billing.payment_transactions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000002'
     AND payment_type = 'prepaid_term'),
  1::bigint,
  'an audited prepaid correction preserves the original payment transaction identity'
);
SELECT is(
  (SELECT amount FROM billing.payment_transactions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000002'
     AND payment_type = 'prepaid_term'),
  18000::numeric,
  'the existing prepaid correction workflow updates the approved amount'
);
SELECT is(
  (SELECT count(*) FROM billing.prepaid_term_replacement_audit
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000002'),
  1::bigint,
  'the previous prepaid payment facts remain in the replacement audit history'
);
SELECT ok(
  (SELECT current_revision_id = ((SELECT result->>'revision_id' FROM billing_operation_test_results WHERE name = 'prepaid_adjustment'))::uuid
   FROM billing.workspace_billing_live_transactions
   WHERE billing_workspace_id = '98100000-0000-0000-0000-000000000002'),
  'the audited prepaid correction creates a new live voucher revision'
);

SELECT set_config('atlas.admin_billing_operation_write', 'off', true);
UPDATE billing.workspace_payment_configurations
SET updated_by_label = 'Existing billing control test administrator'
WHERE workspace_id = '98100000-0000-0000-0000-000000000002';
SELECT is(
  (SELECT revision.revision_type
   FROM billing.workspace_billing_live_transactions AS live
   JOIN billing.admin_billing_revisions AS revision ON revision.id = live.current_revision_id
   WHERE live.billing_workspace_id = '98100000-0000-0000-0000-000000000002'),
  'configuration_override'::text,
  'existing billing configuration controls remain authoritative and update the live reference'
);
SELECT is(
  (SELECT revision.payment_transaction_id
   FROM billing.workspace_billing_live_transactions AS live
   JOIN billing.admin_billing_revisions AS revision ON revision.id = live.current_revision_id
   WHERE live.billing_workspace_id = '98100000-0000-0000-0000-000000000002'),
  ((SELECT result->>'payment_transaction_id' FROM billing_operation_test_results WHERE name = 'prepaid'))::uuid,
  'a prepaid configuration override keeps its existing payment linked to the live reference'
);

SELECT * FROM finish();
ROLLBACK;
