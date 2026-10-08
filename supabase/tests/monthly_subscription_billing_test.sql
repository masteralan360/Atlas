BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.workspaces'::regclass
      AND attname = 'subscription_expires_at'
      AND NOT attisdropped
  ),
  'workspace expiry is no longer stored on public.workspaces'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_proc AS routine
    JOIN pg_namespace AS routine_schema ON routine_schema.oid = routine.pronamespace
    WHERE routine_schema.nspname IN ('public', 'billing')
      AND routine.prokind IN ('f', 'p')
      AND pg_get_functiondef(routine.oid) ILIKE '%subscription_expires_at%'
  ),
  0::bigint,
  'no active public or billing routine references the removed workspace expiry'
);

INSERT INTO public.workspaces (id, name, data_mode)
VALUES
  ('97000000-0000-0000-0000-000000000001', 'Monthly billing lifecycle test', 'cloud'),
  ('97000000-0000-0000-0000-000000000002', 'PAYG mode guard test', 'cloud');

SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT throws_ok(
  $$SELECT public.admin_set_workspace_monthly_subscription_expiry(
    '97000000-0000-0000-0000-000000000001', NULL, 'Unauthorized test caller'
  )$$,
  '42501',
  'workspace_payment_admin_required',
  'monthly expiry management remains restricted to the service role'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  $$SELECT public.admin_set_workspace_monthly_subscription_expiry(
    '97000000-0000-0000-0000-000000000001', NULL, 'Monthly billing test'
  )$$,
  'a monthly subscription can be created with a NULL renewal date'
);
SELECT ok(
  (
    SELECT configuration.renewal_due_at IS NULL
      AND NOT workspace.locked_workspace
      AND NOT workspace.subscription_expiry_locked
    FROM billing.workspace_payment_configurations AS configuration
    JOIN public.workspaces AS workspace ON workspace.id = configuration.workspace_id
    WHERE configuration.workspace_id = '97000000-0000-0000-0000-000000000001'
  ),
  'a NULL monthly renewal date does not expire or lock the workspace'
);

SELECT lives_ok(
  $$SELECT public.admin_set_workspace_monthly_subscription_expiry(
    '97000000-0000-0000-0000-000000000001', now() - interval '1 second', 'Monthly billing test'
  )$$,
  'an expired monthly renewal date is accepted and reconciled'
);
SELECT ok(
  (
    SELECT workspace.locked_workspace AND workspace.subscription_expiry_locked
      AND configuration.renewal_due_at <= now()
    FROM billing.workspace_payment_configurations AS configuration
    JOIN public.workspaces AS workspace ON workspace.id = configuration.workspace_id
    WHERE configuration.workspace_id = '97000000-0000-0000-0000-000000000001'
  ),
  'monthly expiration locks access with the subscription expiry marker'
);

SELECT lives_ok(
  $$SELECT public.admin_set_workspace_monthly_subscription_expiry(
    '97000000-0000-0000-0000-000000000001', now() + interval '30 days', 'Monthly billing test'
  )$$,
  'an administrator can extend the centralized monthly renewal date'
);
SELECT ok(
  (
    SELECT configuration.renewal_due_at > now() + interval '29 days'
      AND NOT workspace.locked_workspace
      AND NOT workspace.subscription_expiry_locked
    FROM billing.workspace_payment_configurations AS configuration
    JOIN public.workspaces AS workspace ON workspace.id = configuration.workspace_id
    WHERE configuration.workspace_id = '97000000-0000-0000-0000-000000000001'
  ),
  'extending a monthly renewal date unlocks only the expiry-owned lock'
);

SELECT lives_ok(
  $$SELECT public.admin_upsert_workspace_payment_configuration_v2(
    '97000000-0000-0000-0000-000000000002', '0', true, false, true,
    '0', (now() + interval '90 days')::text, 'Monthly billing test'
  )$$,
  'the PAYG guard fixture can be configured through the existing billing RPC'
);
SELECT throws_ok(
  $$SELECT public.admin_set_workspace_monthly_subscription_expiry(
    '97000000-0000-0000-0000-000000000002', now() + interval '30 days', 'Monthly billing test'
  )$$,
  '23514',
  'workspace_is_not_monthly_subscription_billing',
  'the monthly expiry RPC refuses to alter a PAYG workspace'
);
SELECT ok(
  (
    SELECT configuration.payg_enabled
      AND configuration.renewal_due_at > now() + interval '89 days'
    FROM billing.workspace_payment_configurations AS configuration
    WHERE configuration.workspace_id = '97000000-0000-0000-0000-000000000002'
  ),
  'the rejected monthly operation leaves PAYG billing configuration unchanged'
);

SELECT * FROM finish();
ROLLBACK;
