BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT no_plan();

-- Fixed, transaction-scoped fixtures keep the policy and validation checks
-- readable. ROLLBACK removes every row at the end of the test.
INSERT INTO public.workspaces (id, name, plan)
VALUES (
  'a1000000-0000-0000-0000-000000000001',
  'Capital pools test',
  'enterprise'
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
    'a2000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'capital-pools-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Capital Pools Admin","role":"admin","workspace_id":"a1000000-0000-0000-0000-000000000001"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a2000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'capital-pools-staff@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Capital Pools Staff","role":"staff","workspace_id":"a1000000-0000-0000-0000-000000000001"}'::jsonb,
    now(), now()
  );

INSERT INTO payment_accounts.accounts (
  id,
  workspace_id,
  name,
  account_type,
  created_by
)
VALUES
  (
    'a3000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'Capital account 1',
    'cash_drawer',
    'a2000000-0000-0000-0000-000000000001'
  ),
  (
    'a3000000-0000-0000-0000-000000000002',
    'a1000000-0000-0000-0000-000000000001',
    'Capital account 2',
    'bank_account',
    'a2000000-0000-0000-0000-000000000001'
  ),
  (
    'a3000000-0000-0000-0000-000000000003',
    'a1000000-0000-0000-0000-000000000001',
    'Capital account 3',
    'digital_wallet',
    'a2000000-0000-0000-0000-000000000001'
  ),
  (
    'a3000000-0000-0000-0000-000000000004',
    'a1000000-0000-0000-0000-000000000001',
    'Capital account 4',
    'other',
    'a2000000-0000-0000-0000-000000000001'
  );

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

SELECT ok(
  payment_accounts.can_manage_capital_pools('a1000000-0000-0000-0000-000000000001'),
  'workspace administrators can always manage capital pools'
);

SELECT lives_ok(
  $$
    INSERT INTO payment_accounts.capital_pools (
      id, workspace_id, name, currency, account_ids, created_by
    )
    VALUES (
      'a4000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000001',
      'Main Capital',
      'IQD',
      ARRAY[
        'a3000000-0000-0000-0000-000000000001'::uuid,
        'a3000000-0000-0000-0000-000000000002'::uuid
      ],
      'a2000000-0000-0000-0000-000000000001'
    )
  $$,
  'an administrator can create a pool from active accounts'
);

SELECT is(
  (
    SELECT currency
    FROM payment_accounts.capital_pools
    WHERE id = 'a4000000-0000-0000-0000-000000000001'
  ),
  'iqd'::text,
  'pool currency is normalized to lowercase'
);

SELECT throws_ok(
  $$
    INSERT INTO payment_accounts.capital_pools (
      id, workspace_id, name, currency, account_ids, created_by
    )
    VALUES (
      'a4000000-0000-0000-0000-000000000099',
      'a1000000-0000-0000-0000-000000000001',
      'Too Small',
      'iqd',
      ARRAY['a3000000-0000-0000-0000-000000000004'::uuid],
      'a2000000-0000-0000-0000-000000000001'
    )
  $$,
  '23514',
  'new row for relation "capital_pools" violates check constraint "capital_pools_minimum_accounts"',
  'a pool must contain at least two accounts'
);

RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

SELECT is(
  (
    SELECT count(*)
    FROM payment_accounts.capital_pools
    WHERE NOT is_deleted
  ),
  1::bigint,
  'staff with Payment Accounts access can read capital pools'
);

SELECT ok(
  NOT payment_accounts.can_manage_capital_pools('a1000000-0000-0000-0000-000000000001'),
  'enterprise staff without the dedicated grant cannot manage capital pools'
);

SELECT throws_ok(
  $$
    INSERT INTO payment_accounts.capital_pools (
      id, workspace_id, name, currency, account_ids, created_by
    )
    VALUES (
      'a4000000-0000-0000-0000-000000000002',
      'a1000000-0000-0000-0000-000000000001',
      'Staff Capital',
      'iqd',
      ARRAY[
        'a3000000-0000-0000-0000-000000000003'::uuid,
        'a3000000-0000-0000-0000-000000000004'::uuid
      ],
      'a2000000-0000-0000-0000-000000000002'
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "capital_pools"',
  'staff without the dedicated grant cannot create a pool'
);

RESET ROLE;

INSERT INTO public.workspace_permissions (workspace_id, user_uuid, key, module)
VALUES (
  'a1000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000002',
  'paymentAccounts.manageCapitalPools',
  'paymentAccounts'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

SELECT ok(
  payment_accounts.can_manage_capital_pools('a1000000-0000-0000-0000-000000000001'),
  'the dedicated staff permission enables capital-pool management'
);

SELECT lives_ok(
  $$
    INSERT INTO payment_accounts.capital_pools (
      id, workspace_id, name, currency, account_ids, created_by
    )
    VALUES (
      'a4000000-0000-0000-0000-000000000002',
      'a1000000-0000-0000-0000-000000000001',
      'Staff Capital',
      'iqd',
      ARRAY[
        'a3000000-0000-0000-0000-000000000003'::uuid,
        'a3000000-0000-0000-0000-000000000004'::uuid
      ],
      'a2000000-0000-0000-0000-000000000002'
    )
  $$,
  'staff with the dedicated grant can create a pool'
);

SELECT lives_ok(
  $$
    UPDATE payment_accounts.capital_pools
    SET name = 'Staff Capital Updated', updated_at = now()
    WHERE id = 'a4000000-0000-0000-0000-000000000002'
  $$,
  'staff with the dedicated grant can edit a pool'
);

SELECT lives_ok(
  $$
    UPDATE payment_accounts.capital_pools
    SET is_deleted = true, updated_at = now()
    WHERE id = 'a4000000-0000-0000-0000-000000000002'
  $$,
  'staff with the dedicated grant can delete a pool'
);

RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

SELECT throws_ok(
  $$
    INSERT INTO payment_accounts.capital_pools (
      id, workspace_id, name, currency, account_ids, created_by
    )
    VALUES (
      'a4000000-0000-0000-0000-000000000003',
      'a1000000-0000-0000-0000-000000000001',
      'Conflicting Capital',
      'iqd',
      ARRAY[
        'a3000000-0000-0000-0000-000000000001'::uuid,
        'a3000000-0000-0000-0000-000000000003'::uuid
      ],
      'a2000000-0000-0000-0000-000000000001'
    )
  $$,
  '23505',
  'CAPITAL_POOL_ACCOUNT_CONFLICT',
  'an account cannot belong to two pools in the same currency'
);

SELECT lives_ok(
  $$
    INSERT INTO payment_accounts.capital_pools (
      id, workspace_id, name, currency, account_ids, created_by
    )
    VALUES (
      'a4000000-0000-0000-0000-000000000004',
      'a1000000-0000-0000-0000-000000000001',
      'USD Capital',
      'usd',
      ARRAY[
        'a3000000-0000-0000-0000-000000000001'::uuid,
        'a3000000-0000-0000-0000-000000000003'::uuid
      ],
      'a2000000-0000-0000-0000-000000000001'
    )
  $$,
  'the same account may belong to a pool in another currency'
);

SELECT lives_ok(
  $$
    INSERT INTO payment_accounts.capital_pools (
      id, workspace_id, name, currency, account_ids, created_by
    )
    VALUES (
      'a4000000-0000-0000-0000-000000000005',
      'a1000000-0000-0000-0000-000000000001',
      'EUR Capital',
      'eur',
      ARRAY[
        'a3000000-0000-0000-0000-000000000003'::uuid,
        'a3000000-0000-0000-0000-000000000004'::uuid
      ],
      'a2000000-0000-0000-0000-000000000001'
    )
  $$,
  'a pool can be created in a workspace-enabled currency'
);

RESET ROLE;

INSERT INTO public.workspace_access_overrides (workspace_id, type, key, value)
VALUES (
  'a1000000-0000-0000-0000-000000000001',
  'currency',
  'eur',
  'deny'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

SELECT lives_ok(
  $$
    UPDATE payment_accounts.capital_pools
    SET name = 'EUR Capital Updated', updated_at = now()
    WHERE id = 'a4000000-0000-0000-0000-000000000005'
  $$,
  'an existing pool remains manageable after its currency is disabled'
);

SELECT throws_ok(
  $$
    INSERT INTO payment_accounts.capital_pools (
      id, workspace_id, name, currency, account_ids, created_by
    )
    VALUES (
      'a4000000-0000-0000-0000-000000000006',
      'a1000000-0000-0000-0000-000000000001',
      'Disabled EUR Capital',
      'eur',
      ARRAY[
        'a3000000-0000-0000-0000-000000000001'::uuid,
        'a3000000-0000-0000-0000-000000000002'::uuid
      ],
      'a2000000-0000-0000-0000-000000000001'
    )
  $$,
  '42501',
  'CAPITAL_POOL_CURRENCY_DISABLED',
  'a disabled currency cannot be selected for a new pool'
);

SELECT throws_ok(
  $$
    UPDATE payment_accounts.accounts
    SET is_active = false
    WHERE id = 'a3000000-0000-0000-0000-000000000001'
  $$,
  '23514',
  'CAPITAL_POOL_ACCOUNT_IN_USE',
  'a pooled account cannot be deactivated'
);

SELECT throws_ok(
  $$
    UPDATE payment_accounts.accounts
    SET is_deleted = true
    WHERE id = 'a3000000-0000-0000-0000-000000000001'
  $$,
  '23514',
  'CAPITAL_POOL_ACCOUNT_IN_USE',
  'a pooled account cannot be deleted'
);

SELECT lives_ok(
  $$
    UPDATE payment_accounts.capital_pools
    SET is_deleted = true, updated_at = now()
    WHERE id IN (
      'a4000000-0000-0000-0000-000000000001',
      'a4000000-0000-0000-0000-000000000004',
      'a4000000-0000-0000-0000-000000000005'
    )
  $$,
  'deleting the pools releases their memberships without a financial write'
);

SELECT lives_ok(
  $$
    UPDATE payment_accounts.accounts
    SET is_active = false
    WHERE id = 'a3000000-0000-0000-0000-000000000001'
  $$,
  'an account can be deactivated after its pools are deleted'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
