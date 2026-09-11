BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

INSERT INTO public.workspaces (id, name, plan, subscription_expires_at, data_mode)
VALUES (
  'b1000000-0000-0000-0000-000000000001',
  'Financial void test',
  'enterprise',
  now() + interval '10 days',
  'cloud'
);

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    'b2000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'financial-void-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Financial Void Admin"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b2000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'financial-void-staff@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Financial Void Staff"}'::jsonb,
    now(), now()
  );

UPDATE public.profiles
SET role = 'admin',
    name = 'Financial Void Admin',
    workspace_id = 'b1000000-0000-0000-0000-000000000001',
    current_workspace = 'b1000000-0000-0000-0000-000000000001'
WHERE id = 'b2000000-0000-0000-0000-000000000001';

UPDATE public.profiles
SET role = 'staff',
    name = 'Financial Void Staff',
    workspace_id = 'b1000000-0000-0000-0000-000000000001',
    current_workspace = 'b1000000-0000-0000-0000-000000000001'
WHERE id = 'b2000000-0000-0000-0000-000000000002';

INSERT INTO budget.expense_series (
  id, workspace_id, name, amount, currency, due_day, recurrence, start_month
)
VALUES
  (
    'b3000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000001',
    'Mistaken expense', 100, 'usd', 30, 'one_time', '2026-08'
  ),
  (
    'b3000000-0000-0000-0000-000000000003',
    'b1000000-0000-0000-0000-000000000001',
    'Already deleted expense', 60, 'usd', 30, 'one_time', '2026-08'
  );

INSERT INTO budget.expense_items (
  id, workspace_id, series_id, month, due_date, amount, currency, status, paid_at
)
VALUES
  (
    'b3000000-0000-0000-0000-000000000002',
    'b1000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000001',
    '2026-08', '2026-08-30', 100, 'usd', 'pending', NULL
  ),
  (
    'b3000000-0000-0000-0000-000000000004',
    'b1000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000003',
    '2026-08', '2026-08-30', 60, 'usd', 'pending', NULL
  );

INSERT INTO payment_accounts.accounts (
  id, workspace_id, name, account_type, created_by
)
VALUES (
  'b4000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'Cash drawer', 'cash_drawer',
  'b2000000-0000-0000-0000-000000000001'
);

INSERT INTO public.payment_transactions (
  id, workspace_id, source_module, source_type, source_record_id,
  direction, amount, currency, payment_method, paid_at, created_by,
  account_id, account_name_snapshot
)
VALUES (
  'b5000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'payment_accounts', 'payment_account_opening_balance',
  'b4000000-0000-0000-0000-000000000001',
  'incoming', 500, 'usd', 'cash', '2026-08-01T09:00:00Z',
  'b2000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001', 'Cash drawer'
);

INSERT INTO public.payment_transactions (
  id, workspace_id, source_module, source_type, source_record_id, source_subrecord_id,
  direction, amount, currency, payment_method, paid_at, created_by,
  account_id, account_name_snapshot, reversal_of_transaction_id, reference_label
)
VALUES
  (
    'b5000000-0000-0000-0000-000000000002',
    'b1000000-0000-0000-0000-000000000001',
    'budget', 'expense_item',
    'b3000000-0000-0000-0000-000000000002',
    'b3000000-0000-0000-0000-000000000001',
    'outgoing', 100, 'usd', 'cash', '2026-08-30T12:00:00Z',
    'b2000000-0000-0000-0000-000000000001',
    'b4000000-0000-0000-0000-000000000001', 'Cash drawer', NULL, 'Mistaken expense'
  ),
  (
    'b5000000-0000-0000-0000-000000000003',
    'b1000000-0000-0000-0000-000000000001',
    'budget', 'expense_item',
    'b3000000-0000-0000-0000-000000000002',
    'b3000000-0000-0000-0000-000000000001',
    'outgoing', -100, 'usd', 'cash', '2026-09-02T12:00:00Z',
    'b2000000-0000-0000-0000-000000000001',
    'b4000000-0000-0000-0000-000000000001', 'Cash drawer',
    'b5000000-0000-0000-0000-000000000002', 'Mistaken expense reversal'
  ),
  (
    'b5000000-0000-0000-0000-000000000004',
    'b1000000-0000-0000-0000-000000000001',
    'budget', 'expense_item',
    'b3000000-0000-0000-0000-000000000004',
    'b3000000-0000-0000-0000-000000000003',
    'outgoing', 40, 'usd', 'cash', '2026-08-30T13:00:00Z',
    'b2000000-0000-0000-0000-000000000001',
    'b4000000-0000-0000-0000-000000000001', 'Cash drawer', NULL, 'Deleted expense payment'
  ),
  (
    'b5000000-0000-0000-0000-000000000005',
    'b1000000-0000-0000-0000-000000000001',
    'budget', 'expense_item',
    'b3000000-0000-0000-0000-000000000004',
    'b3000000-0000-0000-0000-000000000003',
    'outgoing', 20, 'usd', 'cash', '2026-08-30T14:00:00Z',
    'b2000000-0000-0000-0000-000000000001',
    'b4000000-0000-0000-0000-000000000001', 'Cash drawer', NULL, 'Unrelated payment chain'
  );

SELECT lives_ok(
  $$
    DELETE FROM budget.expense_items
    WHERE id = 'b3000000-0000-0000-0000-000000000004'
  $$,
  'an expense item can be deleted without deleting its payment history'
);

SELECT lives_ok(
  $$
    DELETE FROM budget.expense_series
    WHERE id = 'b3000000-0000-0000-0000-000000000003'
  $$,
  'an expense series can be deleted without deleting its payment history'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b2000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

SELECT throws_ok(
  $$
    SELECT public.void_financial_transaction(
      'b1000000-0000-0000-0000-000000000001',
      'b5000000-0000-0000-0000-000000000003',
      'This entry was invalid from the beginning.',
      'no_money_moved',
      'b6000000-0000-0000-0000-000000000001'
    )
  $$,
  '42501',
  'Only a workspace administrator can void a financial transaction',
  'staff cannot call the administrator void workflow'
);

SELECT is(
  (SELECT count(*) FROM public.financial_transaction_voids),
  0::bigint,
  'staff cannot read administrator void audits'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b2000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

SELECT lives_ok(
  $$
    SELECT public.void_financial_transaction(
      'b1000000-0000-0000-0000-000000000001',
      'b5000000-0000-0000-0000-000000000003',
      'This entry was invalid from the beginning.',
      'no_money_moved',
      'b6000000-0000-0000-0000-000000000001'
    )
  $$,
  'an administrator can select the reversal and void its complete chain'
);

SELECT results_eq(
  $$
    SELECT paid_at::date, void_id
    FROM public.payment_transactions
    WHERE id IN (
      'b5000000-0000-0000-0000-000000000002',
      'b5000000-0000-0000-0000-000000000003'
    )
    ORDER BY paid_at
  $$,
  $$ VALUES
    ('2026-08-30'::date, 'b6000000-0000-0000-0000-000000000001'::uuid),
    ('2026-09-02'::date, 'b6000000-0000-0000-0000-000000000001'::uuid)
  $$,
  'the August expense and September reversal reference one audit'
);

SELECT is(
  (
    SELECT requested_payment_transaction_id
    FROM public.financial_transaction_voids
    WHERE id = 'b6000000-0000-0000-0000-000000000001'
  ),
  'b5000000-0000-0000-0000-000000000003'::uuid,
  'the audit records the transaction the administrator selected'
);

SELECT results_eq(
  $$
    SELECT delta_amount
    FROM payment_accounts.account_movements
    WHERE payment_transaction_id IN (
      'b5000000-0000-0000-0000-000000000002',
      'b5000000-0000-0000-0000-000000000003'
    )
    ORDER BY occurred_at
  $$,
  $$ VALUES (0::numeric), (0::numeric) $$,
  'both derived account movements have zero effect'
);

SELECT ok(
  (SELECT void_id IS NOT NULL FROM budget.expense_items WHERE id = 'b3000000-0000-0000-0000-000000000002')
  AND (SELECT void_id IS NOT NULL FROM budget.expense_series WHERE id = 'b3000000-0000-0000-0000-000000000001'),
  'the remaining source and its one-time series are excluded from reporting'
);

SELECT lives_ok(
  $$
    SELECT public.void_financial_transaction(
      'b1000000-0000-0000-0000-000000000001',
      'b5000000-0000-0000-0000-000000000003',
      'This entry was invalid from the beginning.',
      'no_money_moved',
      'b6000000-0000-0000-0000-000000000001'
    )
  $$,
  'replaying the same idempotency key does not apply changes twice'
);

SELECT lives_ok(
  $$
    SELECT public.void_financial_transaction(
      'b1000000-0000-0000-0000-000000000001',
      'b5000000-0000-0000-0000-000000000002',
      'This entry was invalid from the beginning.',
      'no_money_moved',
      'b6000000-0000-0000-0000-000000000002'
    )
  $$,
  'selecting another entry in an already voided chain returns the same audit'
);

SELECT lives_ok(
  $$
    SELECT public.void_financial_transaction(
      'b1000000-0000-0000-0000-000000000001',
      'b5000000-0000-0000-0000-000000000004',
      'The deleted source entry was invalid from the beginning.',
      'no_money_moved',
      'b6000000-0000-0000-0000-000000000003'
    )
  $$,
  'a payment remains voidable after its expense source was deleted'
);

SELECT ok(
  (
    SELECT source_unavailable
    FROM public.financial_transaction_voids
    WHERE id = 'b6000000-0000-0000-0000-000000000003'
  ),
  'the immutable audit records that the source was already unavailable'
);

SELECT is(
  (
    SELECT void_id
    FROM public.payment_transactions
    WHERE id = 'b5000000-0000-0000-0000-000000000005'
  ),
  NULL::uuid,
  'an unrelated payment chain sharing the deleted source remains untouched'
);

SELECT is(
  (
    SELECT balance_amount
    FROM payment_accounts.account_balances
    WHERE account_id = 'b4000000-0000-0000-0000-000000000001'
      AND currency = 'usd'
  ),
  480::numeric,
  'only the selected deleted-source chain is removed from the account balance'
);

SELECT throws_ok(
  $$
    SELECT public.void_financial_transaction(
      'b1000000-0000-0000-0000-000000000001',
      'b5000000-0000-0000-0000-000000000001',
      'The opening balance was entered incorrectly.',
      'no_money_moved',
      'b6000000-0000-0000-0000-000000000004'
    )
  $$,
  '0A000',
  'This transaction source does not support voiding yet',
  'unsupported sources fail closed until an adapter is implemented'
);

SELECT throws_ok(
  $$
    INSERT INTO public.payment_transactions (
      id, workspace_id, source_module, source_type, source_record_id, source_subrecord_id,
      direction, amount, currency, payment_method, paid_at, created_by,
      reversal_of_transaction_id
    ) VALUES (
      'b5000000-0000-0000-0000-000000000006',
      'b1000000-0000-0000-0000-000000000001',
      'budget', 'expense_item',
      'b3000000-0000-0000-0000-000000000002',
      'b3000000-0000-0000-0000-000000000001',
      'outgoing', -100, 'usd', 'cash', '2026-09-03T12:00:00Z',
      'b2000000-0000-0000-0000-000000000001',
      'b5000000-0000-0000-0000-000000000002'
    )
  $$,
  '23514',
  'Voided payment transactions cannot be reversed',
  'a voided payment chain cannot receive another reversal'
);

SELECT set_config('atlas.allow_financial_void', 'on', true);

SELECT throws_ok(
  $$ UPDATE public.payment_transactions
     SET void_id = NULL
     WHERE id = 'b5000000-0000-0000-0000-000000000002' $$,
  '42501',
  'Financial void references can only be changed by the administrator void workflow',
  'even an administrator cannot spoof the workflow flag to tamper with void references'
);

RESET ROLE;

SELECT throws_ok(
  $$ UPDATE public.financial_transaction_voids
     SET reason = 'A different reason that is still sufficiently long.'
     WHERE id = 'b6000000-0000-0000-0000-000000000001' $$,
  '23514',
  'Financial transaction void audits are immutable',
  'audit rows cannot be changed'
);

SELECT throws_ok(
  $$ DELETE FROM public.payment_transactions
     WHERE id = 'b5000000-0000-0000-0000-000000000003' $$,
  '23514',
  'Voided payment transactions cannot be deleted',
  'voided payment history cannot be hard deleted'
);

SELECT * FROM finish();
ROLLBACK;
