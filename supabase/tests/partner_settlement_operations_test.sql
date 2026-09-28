BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT plan(4);

INSERT INTO public.workspaces (id, name, plan, subscription_expires_at, data_mode)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'Settlement workspace one', 'enterprise', now() + interval '10 days', 'cloud'),
  ('c1000000-0000-0000-0000-000000000002', 'Settlement workspace two', 'enterprise', now() + interval '10 days', 'cloud');

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'c2000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'settlement-rls@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Settlement RLS Test"}'::jsonb,
  now(), now()
);

UPDATE public.profiles
SET role = 'admin',
    name = 'Settlement RLS Test',
    workspace_id = 'c1000000-0000-0000-0000-000000000001',
    current_workspace = 'c1000000-0000-0000-0000-000000000001'
WHERE id = 'c2000000-0000-0000-0000-000000000001';

INSERT INTO public.partner_settlement_operations (
  id, workspace_id, partner_id, partner_name_snapshot, direction, paid_at, payment_method, status
)
VALUES
  ('c3000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000001', 'Partner A', 'incoming', now(), 'cash', 'completed'),
  ('c3000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'c4000000-0000-0000-0000-000000000002', 'Partner B', 'outgoing', now(), 'cash', 'completed');

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"c2000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

SELECT results_eq(
  $$ SELECT id FROM public.partner_settlement_operations ORDER BY id $$,
  $$ VALUES ('c3000000-0000-0000-0000-000000000001'::uuid) $$,
  'authenticated users only read settlement operations in their current workspace'
);

SELECT throws_ok(
  $$
    INSERT INTO public.partner_settlement_operations (
      id, workspace_id, partner_id, partner_name_snapshot, direction, paid_at, payment_method
    )
    VALUES (
      'c3000000-0000-0000-0000-000000000003',
      'c1000000-0000-0000-0000-000000000002',
      'c4000000-0000-0000-0000-000000000003',
      'Partner C', 'incoming', now(), 'cash'
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "partner_settlement_operations"',
  'authenticated users cannot create a settlement operation for another workspace'
);

SELECT throws_ok(
  $$
    UPDATE public.partner_settlement_operations
    SET workspace_id = 'c1000000-0000-0000-0000-000000000002'
    WHERE id = 'c3000000-0000-0000-0000-000000000001'
  $$,
  '42501',
  'new row violates row-level security policy for table "partner_settlement_operations"',
  'authenticated users cannot move a settlement operation to another workspace'
);

RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$ SELECT count(*) FROM public.partner_settlement_operations $$,
  '42501',
  'permission denied for table partner_settlement_operations',
  'anonymous clients have no table privilege'
);

SELECT * FROM finish();
ROLLBACK;
