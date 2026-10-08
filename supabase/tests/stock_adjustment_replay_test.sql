BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

INSERT INTO public.workspaces (id, name, data_mode)
VALUES (
  'a6000000-0000-0000-0000-000000000001',
  'Stock adjustment replay test',
  'cloud'
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
  'a6000000-0000-0000-0000-000000000002',
  'authenticated',
  'authenticated',
  'stock-adjustment-admin@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Stock Adjustment Admin","role":"admin","workspace_id":"a6000000-0000-0000-0000-000000000001"}'::jsonb,
  now(),
  now()
);

UPDATE public.profiles
SET
  role = 'admin',
  workspace_id = 'a6000000-0000-0000-0000-000000000001',
  current_workspace = 'a6000000-0000-0000-0000-000000000001'
WHERE id = 'a6000000-0000-0000-0000-000000000002';

INSERT INTO public.products (
  id,
  workspace_id,
  sku,
  name,
  price,
  cost_price,
  quantity,
  min_stock_level,
  unit,
  currency
)
VALUES (
  'a6000000-0000-0000-0000-000000000003',
  'a6000000-0000-0000-0000-000000000001',
  'STOCK-ADJUSTMENT-RPC-TEST',
  'Stock Adjustment RPC Test',
  10,
  5,
  0,
  0,
  'pcs',
  'usd'
);

INSERT INTO public.storages (
  id,
  workspace_id,
  name,
  is_primary
)
VALUES (
  'a6000000-0000-0000-0000-000000000004',
  'a6000000-0000-0000-0000-000000000001',
  'Stock Adjustment Test Storage',
  true
);

INSERT INTO public.inventory (
  id,
  workspace_id,
  product_id,
  storage_id,
  quantity
)
VALUES (
  'a6000000-0000-0000-0000-000000000005',
  'a6000000-0000-0000-0000-000000000001',
  'a6000000-0000-0000-0000-000000000003',
  'a6000000-0000-0000-0000-000000000004',
  80
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a6000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

SELECT lives_ok(
  $$
    SELECT public.apply_stock_adjustment(jsonb_build_object(
      'id', 'a6000000-0000-0000-0000-000000000006',
      'workspace_id', 'a6000000-0000-0000-0000-000000000001',
      'product_id', 'a6000000-0000-0000-0000-000000000003',
      'storage_id', 'a6000000-0000-0000-0000-000000000004',
      'transaction_type', 'stock_adjustment',
      'quantity_delta', 20,
      'previous_quantity', 80,
      'new_quantity', 100,
      'adjustment_reason', 'correction',
      'reference_id', 'a6000000-0000-0000-0000-000000000006'
    ))
  $$,
  'a stock adjustment updates inventory and appends its ledger entry atomically'
);

SELECT is(
  (
    SELECT quantity
    FROM public.inventory
    WHERE workspace_id = 'a6000000-0000-0000-0000-000000000001'
      AND product_id = 'a6000000-0000-0000-0000-000000000003'
      AND storage_id = 'a6000000-0000-0000-0000-000000000004'
  ),
  100::numeric,
  'the adjustment raises inventory from 80 to 100'
);

SELECT results_eq(
  $$
    SELECT quantity_delta, previous_quantity, new_quantity
    FROM public.inventory_transactions
    WHERE id = 'a6000000-0000-0000-0000-000000000006'
  $$,
  $$VALUES (20::numeric, 80::numeric, 100::numeric)$$,
  'the ledger stores server-authoritative before and after quantities'
);

SELECT is(
  (
    public.apply_stock_adjustment(jsonb_build_object(
      'id', 'a6000000-0000-0000-0000-000000000006',
      'workspace_id', 'a6000000-0000-0000-0000-000000000001',
      'product_id', 'a6000000-0000-0000-0000-000000000003',
      'storage_id', 'a6000000-0000-0000-0000-000000000004',
      'transaction_type', 'stock_adjustment',
      'quantity_delta', 20,
      'adjustment_reason', 'correction'
    ))->>'already_applied'
  )::boolean,
  true,
  'retrying the same operation reports that it was already applied'
);

SELECT results_eq(
  $$
    SELECT quantity, (
      SELECT count(*)::numeric
      FROM public.inventory_transactions
      WHERE id = 'a6000000-0000-0000-0000-000000000006'
    )
    FROM public.inventory
    WHERE id = 'a6000000-0000-0000-0000-000000000005'
  $$,
  $$VALUES (100::numeric, 1::numeric)$$,
  'an idempotent retry neither moves inventory nor duplicates the ledger row'
);

SELECT public.apply_stock_adjustment(jsonb_build_object(
  'id', 'a6000000-0000-0000-0000-000000000007',
  'workspace_id', 'a6000000-0000-0000-0000-000000000001',
  'product_id', 'a6000000-0000-0000-0000-000000000003',
  'storage_id', 'a6000000-0000-0000-0000-000000000004',
  'transaction_type', 'stock_adjustment',
  'quantity_delta', -0.1234567,
  'adjustment_reason', 'correction'
));

SELECT is(
  (
    SELECT quantity
    FROM public.inventory
    WHERE id = 'a6000000-0000-0000-0000-000000000005'
  ),
  99.876543::numeric,
  'fractional adjustment quantities round to six decimal places'
);

SELECT throws_ok(
  $$
    SELECT public.apply_stock_adjustment(jsonb_build_object(
      'id', 'a6000000-0000-0000-0000-000000000008',
      'workspace_id', 'a6000000-0000-0000-0000-000000000001',
      'product_id', 'a6000000-0000-0000-0000-000000000003',
      'storage_id', 'a6000000-0000-0000-0000-000000000004',
      'transaction_type', 'stock_adjustment',
      'quantity_delta', -100,
      'adjustment_reason', 'damage'
    ))
  $$,
  '23514',
  'Insufficient inventory for this stock adjustment',
  'an adjustment cannot make inventory negative'
);

SELECT throws_ok(
  $$
    SELECT public.apply_stock_adjustment(jsonb_build_object(
      'id', 'a6000000-0000-0000-0000-000000000006',
      'workspace_id', 'a6000000-0000-0000-0000-000000000001',
      'product_id', 'a6000000-0000-0000-0000-000000000003',
      'storage_id', 'a6000000-0000-0000-0000-000000000004',
      'transaction_type', 'stock_adjustment',
      'quantity_delta', 21,
      'adjustment_reason', 'correction'
    ))
  $$,
  '23505',
  'Stock adjustment id is already used by another operation',
  'an operation id cannot be reused with a different stock movement'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
