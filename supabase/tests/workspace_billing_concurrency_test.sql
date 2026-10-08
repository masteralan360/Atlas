-- This test intentionally uses a committed fixture: a second dblink session
-- must be able to see the same pending row in order to exercise the real row
-- lock. It deletes every fixed test row before and after execution.

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink;
SET search_path = public, extensions;

SELECT no_plan();

DELETE FROM billing.payment_transactions
WHERE billing_workspace_id IN (
    '93000000-0000-0000-0000-000000000002',
    '93000000-0000-0000-0000-000000000003',
    '93000000-0000-0000-0000-000000000004',
    '93000000-0000-0000-0000-000000000005',
    '93000000-0000-0000-0000-000000000006',
    '93000000-0000-0000-0000-000000000007',
    '93000000-0000-0000-0000-000000000008'
  )
  OR workspace_id IN (
    '93000000-0000-0000-0000-000000000002',
    '93000000-0000-0000-0000-000000000003',
    '93000000-0000-0000-0000-000000000004',
    '93000000-0000-0000-0000-000000000005',
    '93000000-0000-0000-0000-000000000006',
    '93000000-0000-0000-0000-000000000007',
    '93000000-0000-0000-0000-000000000008'
  );
DELETE FROM billing.payment_transaction_status_audit
WHERE billing_workspace_id IN (
  '93000000-0000-0000-0000-000000000002',
  '93000000-0000-0000-0000-000000000003',
  '93000000-0000-0000-0000-000000000004',
  '93000000-0000-0000-0000-000000000005',
  '93000000-0000-0000-0000-000000000006',
  '93000000-0000-0000-0000-000000000007',
  '93000000-0000-0000-0000-000000000008'
);
DELETE FROM billing.workspace_payment_configurations
WHERE workspace_id IN (
  '93000000-0000-0000-0000-000000000002',
  '93000000-0000-0000-0000-000000000003',
  '93000000-0000-0000-0000-000000000004',
  '93000000-0000-0000-0000-000000000005',
  '93000000-0000-0000-0000-000000000006',
  '93000000-0000-0000-0000-000000000007',
  '93000000-0000-0000-0000-000000000008'
);
DELETE FROM billing.workspace_payment_configuration_audit
WHERE workspace_id IN (
  '93000000-0000-0000-0000-000000000002',
  '93000000-0000-0000-0000-000000000003',
  '93000000-0000-0000-0000-000000000004',
  '93000000-0000-0000-0000-000000000005',
  '93000000-0000-0000-0000-000000000006',
  '93000000-0000-0000-0000-000000000007',
  '93000000-0000-0000-0000-000000000008'
);
DELETE FROM public.workspace_branches
WHERE source_workspace_id IN (
    '93000000-0000-0000-0000-000000000002',
    '93000000-0000-0000-0000-000000000003',
    '93000000-0000-0000-0000-000000000004',
    '93000000-0000-0000-0000-000000000005',
    '93000000-0000-0000-0000-000000000006',
    '93000000-0000-0000-0000-000000000007',
    '93000000-0000-0000-0000-000000000008'
  )
  OR branch_workspace_id IN (
    '93000000-0000-0000-0000-000000000002',
    '93000000-0000-0000-0000-000000000003',
    '93000000-0000-0000-0000-000000000004',
    '93000000-0000-0000-0000-000000000005',
    '93000000-0000-0000-0000-000000000006',
    '93000000-0000-0000-0000-000000000007',
    '93000000-0000-0000-0000-000000000008'
  );
DELETE FROM public.profiles
WHERE id = '94000000-0000-0000-0000-000000000002';
DELETE FROM auth.users
WHERE id = '94000000-0000-0000-0000-000000000002';
DELETE FROM public.app_permissions
WHERE key_name = 'user_94000000-0000-0000-0000-000000000002';
DELETE FROM public.workspaces
WHERE id IN (
  '93000000-0000-0000-0000-000000000002',
  '93000000-0000-0000-0000-000000000003',
  '93000000-0000-0000-0000-000000000004',
  '93000000-0000-0000-0000-000000000005',
  '93000000-0000-0000-0000-000000000006',
  '93000000-0000-0000-0000-000000000007',
  '93000000-0000-0000-0000-000000000008'
);

DELETE FROM billing.payment_transactions
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM billing.workspace_payment_configurations
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM billing.payment_transaction_status_audit
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM billing.workspace_payment_configuration_audit
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM public.profiles
WHERE id = '94000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
WHERE id = '94000000-0000-0000-0000-000000000001';
DELETE FROM public.app_permissions
WHERE key_name = 'user_94000000-0000-0000-0000-000000000001';
DELETE FROM public.workspace_usage_limits
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM public.workspaces
WHERE id = '93000000-0000-0000-0000-000000000001';

INSERT INTO public.workspaces (id, name)
VALUES (
  '93000000-0000-0000-0000-000000000001',
  'Billing concurrency test'
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
  '94000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'billing-concurrency@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Concurrency User","role":"admin","workspace_id":"93000000-0000-0000-0000-000000000001"}'::jsonb,
  now(),
  now()
);

INSERT INTO public.workspace_usage_limits (
  workspace_id,
  monthly_data_transfer_limit_bytes,
  notes
)
VALUES (
  '93000000-0000-0000-0000-000000000001',
  1000000000,
  'Billing concurrency fixture'
);

SELECT public.ensure_workspace_usage_row(
  '93000000-0000-0000-0000-000000000001'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT public.admin_upsert_workspace_payment_configuration(
  '93000000-0000-0000-0000-000000000001',
  '30000',
  true,
  true,
  '2',
  'Concurrency setup'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}',
  false
);
SELECT public.submit_workspace_payment('fib');

SELECT lives_ok(
  format(
    'SELECT dblink_connect(%L, %L)',
    'billing_concurrent_reviewer',
    'dbname=' || current_database()
  ),
  'a second database session can be opened for the approval race'
);

BEGIN;

-- Hold the owner/member lock and then the family advisory lock before the
-- transaction row, matching the production review order. The remote review
-- must wait on that order until this session commits.
SELECT pg_advisory_xact_lock(
  hashtextextended(
    'workspace-branch-payment-owner:' || '93000000-0000-0000-0000-000000000001',
    0
  )
);

SELECT pg_advisory_xact_lock(
  hashtextextended(
    'workspace-payment:' || '93000000-0000-0000-0000-000000000001',
    0
  )
);

DO $do$
BEGIN
  PERFORM 1
  FROM billing.payment_transactions
  WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
    AND status = 'pending'
  FOR UPDATE;
END;
$do$;

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    format(
      $remote$
        WITH auth_context AS MATERIALIZED (
          SELECT set_config(
            'request.jwt.claims',
            '{"role":"service_role"}',
            false
          )
        )
        SELECT public.admin_review_workspace_payment_transaction(
          %L::uuid,
          'approved',
          NULL,
          'Concurrent reviewer B',
          'CONCURRENT-B'
        )
        FROM auth_context
      $remote$,
      (
        SELECT id::text
        FROM billing.payment_transactions
        WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
          AND status = 'pending'
      )
    )
  ),
  1,
  'the competing approval query starts asynchronously'
);

SELECT is(
  dblink_is_busy('billing_concurrent_reviewer'),
  1,
  'the competing approval waits while the transaction row is locked'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, NULL, %L, %L)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
        AND status = 'pending'
    ),
    'approved',
    'Concurrent reviewer A',
    'CONCURRENT-A'
  ),
  'the lock-owning approval applies the entitlement'
);

COMMIT;

SELECT throws_ok(
  $$
    SELECT remote_result.result
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result jsonb)
  $$,
  '23514',
  'workspace_payment_transaction_already_reviewed',
  'the waiting approval observes the committed terminal state and is rejected'
);

SELECT is(
  (
    SELECT status
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
  ),
  'approved'::text,
  'the raced transaction has one approved terminal state'
);

SELECT is(
  (
    SELECT purchased_credit_bytes
    FROM public.workspace_usage
    WHERE workspace_id = '93000000-0000-0000-0000-000000000001'
  ),
  2000000000::bigint,
  'concurrent review applies the GB snapshot exactly once'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.payment_transaction_status_audit
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
      AND to_status = 'approved'
  ),
  1::bigint,
  'concurrent review records only one approval audit transition'
);

-- A repeated user submission and an administrator review use the same
-- owner/member then family advisory lock order before either side takes row
-- locks. Hold that order briefly in the remote submitter so the local review
-- is forced through the production wait path that previously deadlocked.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}',
  false
);
SELECT public.submit_workspace_payment('fib');

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    $remote$
      WITH auth_context AS MATERIALIZED (
        SELECT set_config(
          'request.jwt.claims',
          '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}',
          false
        )
      ),
      relationship_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'workspace-branch-payment-owner:' || '93000000-0000-0000-0000-000000000001',
            0
          )
        )
        FROM auth_context
      ),
      payment_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'workspace-payment:' || '93000000-0000-0000-0000-000000000001',
            0
          )
        )
        FROM relationship_lock
      ),
      delayed_submit AS MATERIALIZED (
        SELECT pg_sleep(0.5)
        FROM payment_lock
      )
      SELECT public.submit_workspace_payment('fib')
      FROM delayed_submit
    $remote$
  ),
  1,
  'a repeated user submission starts while an approval is pending'
);

DO $wait_for_remote_payment_lock$
DECLARE
  v_lock_id bigint := hashtextextended(
    'workspace-payment:' || '93000000-0000-0000-0000-000000000001',
    0
  );
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF NOT pg_try_advisory_lock(v_lock_id) THEN
      v_observed := true;
      EXIT;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_id);
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote submitter did not acquire the workspace payment lock';
  END IF;
END;
$wait_for_remote_payment_lock$;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, NULL, %L, %L)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
        AND status = 'pending'
    ),
    'approved',
    'Submit-review race reviewer',
    'SUBMIT-REVIEW-A'
  ),
  'approval waits for a repeated submit and completes without deadlocking'
);

SELECT is(
  (
    SELECT remote_result.result ->> 'status'
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result jsonb)
  ),
  'pending'::text,
  'the racing repeated submission returns the existing pending transaction'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
      AND status = 'approved'
  ),
  2::bigint,
  'submit-review concurrency leaves exactly two separately approved payments'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
      AND status = 'pending'
  ),
  0::bigint,
  'submit-review concurrency does not leave a duplicate pending payment'
);

SELECT is(
  (
    SELECT purchased_credit_bytes
    FROM public.workspace_usage
    WHERE workspace_id = '93000000-0000-0000-0000-000000000001'
  ),
  4000000000::bigint,
  'submit-review concurrency applies the second GB snapshot exactly once'
);

-- Metering owns the usage row before its AFTER trigger reconciles workspace
-- access. Usage approval must wait for that U -> W sequence before touching W,
-- then apply its immutable credit under the exclusive usage-writer barrier.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-0000-0000-000000000001","role":"authenticated"}',
  false
);
SELECT public.submit_workspace_payment('fib');

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    $remote$
      WITH usage_row AS MATERIALIZED (
        SELECT workspace_id
        FROM public.workspace_usage
        WHERE workspace_id = '93000000-0000-0000-0000-000000000001'
        FOR UPDATE
      ),
      row_lock_signal AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended('billing-test-meter-usage-row', 0)
        )
        FROM usage_row
      ),
      delayed_meter AS MATERIALIZED (
        SELECT pg_sleep(0.5)
        FROM row_lock_signal
      )
      UPDATE public.workspace_usage AS usage_state
      SET
        data_transfer_bytes = usage_state.data_transfer_bytes + 10,
        transfer_updated_at = now(),
        updated_at = now()
      FROM delayed_meter
      WHERE usage_state.workspace_id = '93000000-0000-0000-0000-000000000001'
      RETURNING usage_state.workspace_id
    $remote$
  ),
  1,
  'a metering write starts while a usage payment approval is attempted'
);

DO $wait_for_remote_meter_usage_row$
DECLARE
  v_lock_id bigint := hashtextextended(
    'billing-test-meter-usage-row',
    0
  );
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF NOT pg_try_advisory_lock(v_lock_id) THEN
      v_observed := true;
      EXIT;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_id);
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote meter did not lock the workspace usage row';
  END IF;
END;
$wait_for_remote_meter_usage_row$;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT lives_ok(
  format(
    'SELECT public.admin_review_workspace_payment_transaction(%L::uuid, %L, NULL, %L, %L)',
    (
      SELECT id::text
      FROM billing.payment_transactions
      WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
        AND status = 'pending'
    ),
    'approved',
    'Metering race reviewer',
    'METERING-RACE-APPROVED'
  ),
  'usage approval waits for metering and completes without a usage/workspace deadlock'
);

SELECT lives_ok(
  $$
    SELECT remote_result.result
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result uuid)
  $$,
  'the racing meter commits its charged counter'
);

SELECT is(
  (
    SELECT count(*)
    FROM billing.payment_transactions
    WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001'
      AND status = 'approved'
  ),
  3::bigint,
  'approval-versus-metering concurrency leaves one additional approved payment'
);

SELECT is(
  (
    SELECT purchased_credit_bytes
    FROM public.workspace_usage
    WHERE workspace_id = '93000000-0000-0000-0000-000000000001'
  ),
  6000000000::bigint,
  'approval-versus-metering concurrency applies the third GB snapshot exactly once'
);

SELECT is(
  (
    SELECT data_transfer_bytes
    FROM public.workspace_usage
    WHERE workspace_id = '93000000-0000-0000-0000-000000000001'
  ),
  10::bigint,
  'the racing meter preserves the charged transfer counter'
);

-- A reconciler that reads an overdue value and then waits on the workspace row
-- must not reapply that stale decision after another transaction advances the
-- paid-through boundary. The configuration-family lock makes it wait before
-- reading renewal_due_at instead.
UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() - INTERVAL '1 day'
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';

SELECT is(
  (
    SELECT payment_renewal_locked
    FROM public.workspaces
    WHERE id = '93000000-0000-0000-0000-000000000001'
  ),
  true,
  'an overdue usage renewal owns the workspace renewal lock before the race'
);

SELECT set_config(
  'atlas.billing_concurrency_remote_pid',
  remote_backend.pid::text,
  false
)
FROM dblink(
  'billing_concurrent_reviewer',
  'SELECT pg_backend_pid()'
) AS remote_backend(pid integer);

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtextextended(
    'workspace-payment-configuration:' || '93000000-0000-0000-0000-000000000001',
    0
  )
);

SELECT 1
FROM public.workspaces
WHERE id = '93000000-0000-0000-0000-000000000001'
FOR UPDATE;

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    $remote$
      SELECT billing.reconcile_workspace_payment_renewal_lock(
        '93000000-0000-0000-0000-000000000001'
      )
    $remote$
  ),
  1,
  'renewal-lock reconciliation starts while configuration advancement is pending'
);

DO $wait_for_remote_reconcile_lock$
DECLARE
  v_remote_pid integer := current_setting(
    'atlas.billing_concurrency_remote_pid'
  )::integer;
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_stat_activity AS activity
      WHERE activity.pid = v_remote_pid
        AND activity.state = 'active'
        AND activity.wait_event_type = 'Lock'
    )
    INTO v_observed;

    EXIT WHEN v_observed;
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote reconciler did not reach its lock wait';
  END IF;
END;
$wait_for_remote_reconcile_lock$;

UPDATE billing.workspace_payment_configurations
SET renewal_due_at = now() + INTERVAL '1 month'
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';

COMMIT;

SELECT lives_ok(
  $$
    SELECT remote_result.result
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result text)
  $$,
  'the waiting renewal-lock reconciliation completes after advancement commits'
);

SELECT is(
  (
    SELECT payment_renewal_locked
    FROM public.workspaces
    WHERE id = '93000000-0000-0000-0000-000000000001'
  ),
  false,
  'the waiting reconciler does not restore a stale payment-renewal lock'
);

-- A branch attachment must serialize before a submitter resolves its billing
-- owner. If the submitter wins, the pending immutable snapshot blocks the
-- attachment instead of being stranded under the former owner.
INSERT INTO public.workspaces (id, name, plan)
VALUES
  (
    '93000000-0000-0000-0000-000000000002',
    'Billing attachment concurrency root',
    'enterprise'
  ),
  (
    '93000000-0000-0000-0000-000000000003',
    'Billing attachment concurrency branch',
    'business'
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
  '94000000-0000-0000-0000-000000000002',
  'authenticated',
  'authenticated',
  'billing-attachment-concurrency@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Attachment Concurrency User","role":"admin","workspace_id":"93000000-0000-0000-0000-000000000003"}'::jsonb,
  now(),
  now()
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT public.admin_upsert_workspace_payment_configuration(
  '93000000-0000-0000-0000-000000000003',
  '16000',
  true,
  false,
  '0',
  'Attachment concurrency setup'
);

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    $remote$
      WITH auth_context AS MATERIALIZED (
        SELECT set_config(
          'request.jwt.claims',
          '{"sub":"94000000-0000-0000-0000-000000000002","role":"authenticated"}',
          false
        )
      ),
      relationship_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'workspace-branch-payment-owner:' || '93000000-0000-0000-0000-000000000003',
            0
          )
        )
        FROM auth_context
      ),
      delayed_submit AS MATERIALIZED (
        SELECT pg_sleep(0.5)
        FROM relationship_lock
      )
      SELECT public.submit_workspace_payment('fib')
      FROM delayed_submit
    $remote$
  ),
  1,
  'a workspace payment submit starts while branch attachment is pending'
);

DO $wait_for_remote_relationship_lock$
DECLARE
  v_lock_id bigint := hashtextextended(
    'workspace-branch-payment-owner:' || '93000000-0000-0000-0000-000000000003',
    0
  );
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF NOT pg_try_advisory_lock(v_lock_id) THEN
      v_observed := true;
      EXIT;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_id);
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote submitter did not acquire the branch relationship lock';
  END IF;
END;
$wait_for_remote_relationship_lock$;

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '93000000-0000-0000-0000-000000000002',
      '93000000-0000-0000-0000-000000000003',
      'Billing raced attachment'
    )
  $$,
  '23514',
  'workspace_branch_pending_payment_conflict',
  'a racing submit commits first and safely blocks the owner-changing attachment'
);

SELECT is(
  (
    SELECT remote_result.result ->> 'status'
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result jsonb)
  ),
  'pending'::text,
  'the racing submit remains a valid pending transaction under its original owner'
);

SELECT is(
  public.workspace_usage_owner_id(
    '93000000-0000-0000-0000-000000000003'
  ),
  '93000000-0000-0000-0000-000000000003'::uuid,
  'the rejected attachment leaves the transaction billing owner unchanged'
);

-- If review wins the family payment lock, the attachment must re-check all
-- history after waiting. An approved entitlement cannot be applied to the old
-- owner and then hidden by the relationship insert.
SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    format(
      $remote$
        WITH auth_context AS MATERIALIZED (
          SELECT set_config(
            'request.jwt.claims',
            '{"role":"service_role"}',
            false
          )
        ),
        relationship_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              'workspace-branch-payment-owner:' || '93000000-0000-0000-0000-000000000003',
              0
            )
          )
          FROM auth_context
        ),
        payment_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              'workspace-payment:' || '93000000-0000-0000-0000-000000000003',
              0
            )
          )
          FROM relationship_lock
        ),
        delayed_review AS MATERIALIZED (
          SELECT pg_sleep(0.5)
          FROM payment_lock
        )
        SELECT public.admin_review_workspace_payment_transaction(
          %L::uuid,
          'approved',
          'Approved during attachment race',
          'Attachment race reviewer',
          'ATTACHMENT-RACE-APPROVED'
        )
        FROM delayed_review
      $remote$,
      (
        SELECT id::text
        FROM billing.payment_transactions
        WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000003'
          AND status = 'pending'
      )
    )
  ),
  1,
  'an administrator approval starts while an owner-changing attachment is attempted'
);

DO $wait_for_remote_attachment_review_lock$
DECLARE
  v_lock_id bigint := hashtextextended(
    'workspace-payment:' || '93000000-0000-0000-0000-000000000003',
    0
  );
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF NOT pg_try_advisory_lock(v_lock_id) THEN
      v_observed := true;
      EXIT;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_id);
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote attachment reviewer did not acquire the workspace payment lock';
  END IF;
END;
$wait_for_remote_attachment_review_lock$;

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '93000000-0000-0000-0000-000000000002',
      '93000000-0000-0000-0000-000000000003',
      'Billing approval-raced attachment'
    )
  $$,
  '23514',
  'workspace_branch_payment_history_conflict',
  'an approval that wins the payment lock still blocks the waiting attachment'
);

SELECT is(
  (
    SELECT remote_result.result ->> 'status'
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result jsonb)
  ),
  'approved'::text,
  'the racing administrative review commits its approved terminal state'
);

SELECT is(
  public.workspace_usage_owner_id(
    '93000000-0000-0000-0000-000000000003'
  ),
  '93000000-0000-0000-0000-000000000003'::uuid,
  'the approved entitlement remains attached to its original billing owner'
);

-- Opposite branch inserts are serialized by one topology lock. The waiter
-- re-resolves after the winner and rejects the edge that would close a cycle.
INSERT INTO public.workspaces (id, name, plan)
VALUES
  (
    '93000000-0000-0000-0000-000000000004',
    'Billing opposite attachment A',
    'enterprise'
  ),
  (
    '93000000-0000-0000-0000-000000000005',
    'Billing opposite attachment B',
    'enterprise',
    now() + INTERVAL '10 days'
  );

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    $remote$
      WITH topology_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended('workspace-branch-payment-topology', 0)
        )
      ),
      delayed_insert AS MATERIALIZED (
        SELECT pg_sleep(0.5)
        FROM topology_lock
      )
      INSERT INTO public.workspace_branches (
        source_workspace_id,
        branch_workspace_id,
        name
      )
      SELECT
        '93000000-0000-0000-0000-000000000004'::uuid,
        '93000000-0000-0000-0000-000000000005'::uuid,
        'Billing remote opposite winner'
      FROM delayed_insert
      RETURNING id
    $remote$
  ),
  1,
  'the first of two opposite attachments starts asynchronously'
);

DO $wait_for_remote_topology_lock_opposite$
DECLARE
  v_lock_id bigint := hashtextextended(
    'workspace-branch-payment-topology',
    0
  );
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF NOT pg_try_advisory_lock(v_lock_id) THEN
      v_observed := true;
      EXIT;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_id);
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote opposite attachment did not acquire the topology lock';
  END IF;
END;
$wait_for_remote_topology_lock_opposite$;

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '93000000-0000-0000-0000-000000000005',
      '93000000-0000-0000-0000-000000000004',
      'Billing local opposite waiter'
    )
  $$,
  '23514',
  'workspace_branch_cycle_or_same_family',
  'the opposite waiter observes the committed family and cannot create a cycle'
);

SELECT lives_ok(
  $$
    SELECT remote_result.result
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result uuid)
  $$,
  'the winning opposite attachment commits normally'
);

SELECT is(
  public.workspace_usage_owner_id(
    '93000000-0000-0000-0000-000000000005'
  ),
  '93000000-0000-0000-0000-000000000004'::uuid,
  'opposite attachment concurrency leaves one acyclic owner relationship'
);

-- A usage-limit insert on a newly visible workspace takes the member lock
-- before resolving its owner. If it wins, the attachment sees the committed
-- owner-keyed state and refuses to strand it.
DELETE FROM public.workspace_branches
WHERE source_workspace_id = '93000000-0000-0000-0000-000000000004'
  AND branch_workspace_id = '93000000-0000-0000-0000-000000000005';

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT public.admin_upsert_workspace_payment_configuration(
  '93000000-0000-0000-0000-000000000005',
  '14000',
  true,
  true,
  '1',
  'Usage attachment race setup'
);

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    $remote$
      WITH relationship_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'workspace-branch-payment-owner:' || '93000000-0000-0000-0000-000000000005',
            0
          )
        )
      ),
      delayed_insert AS MATERIALIZED (
        SELECT pg_sleep(0.5)
        FROM relationship_lock
      )
      INSERT INTO public.workspace_usage_limits (
        workspace_id,
        monthly_data_transfer_limit_bytes,
        notes
      )
      SELECT
        '93000000-0000-0000-0000-000000000005'::uuid,
        5000000000::bigint,
        'Usage attachment concurrency fixture'
      FROM delayed_insert
      RETURNING workspace_id
    $remote$
  ),
  1,
  'a usage-limit insert starts while branch attachment is attempted'
);

DO $wait_for_remote_usage_attachment_lock$
DECLARE
  v_lock_id bigint := hashtextextended(
    'workspace-branch-payment-owner:' || '93000000-0000-0000-0000-000000000005',
    0
  );
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF NOT pg_try_advisory_lock(v_lock_id) THEN
      v_observed := true;
      EXIT;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_id);
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote usage insert did not acquire the branch owner lock';
  END IF;
END;
$wait_for_remote_usage_attachment_lock$;

SELECT throws_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '93000000-0000-0000-0000-000000000004',
      '93000000-0000-0000-0000-000000000005',
      'Billing usage-raced attachment'
    )
  $$,
  '23514',
  'workspace_branch_usage_state_conflict',
  'a committed usage allowance blocks the waiting owner-changing attachment'
);

SELECT lives_ok(
  $$
    SELECT remote_result.result
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result uuid)
  $$,
  'the racing usage-limit insert commits under its original owner'
);

SELECT is(
  public.workspace_usage_owner_id(
    '93000000-0000-0000-0000-000000000005'
  ),
  '93000000-0000-0000-0000-000000000005'::uuid,
  'the rejected usage-state attachment leaves the usage owner unchanged'
);

DELETE FROM public.workspace_usage
WHERE workspace_id = '93000000-0000-0000-0000-000000000005';
DELETE FROM public.workspace_usage_limits
WHERE workspace_id = '93000000-0000-0000-0000-000000000005';
DELETE FROM billing.workspace_payment_configurations
WHERE workspace_id = '93000000-0000-0000-0000-000000000005';
DELETE FROM billing.workspace_payment_configuration_audit
WHERE workspace_id = '93000000-0000-0000-0000-000000000005';

-- An overlapping waiter is valid, but it must resolve the source through the
-- winner rather than snapshotting the source as an independent owner.
INSERT INTO public.workspaces (id, name, plan)
VALUES
  (
    '93000000-0000-0000-0000-000000000006',
    'Billing overlapping attachment root',
    'enterprise'
  ),
  (
    '93000000-0000-0000-0000-000000000007',
    'Billing overlapping attachment middle',
    'enterprise',
    now() + INTERVAL '10 days'
  ),
  (
    '93000000-0000-0000-0000-000000000008',
    'Billing overlapping attachment leaf',
    'enterprise',
    now() + INTERVAL '10 days'
  );

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    $remote$
      WITH topology_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended('workspace-branch-payment-topology', 0)
        )
      ),
      delayed_insert AS MATERIALIZED (
        SELECT pg_sleep(0.5)
        FROM topology_lock
      )
      INSERT INTO public.workspace_branches (
        source_workspace_id,
        branch_workspace_id,
        name
      )
      SELECT
        '93000000-0000-0000-0000-000000000006'::uuid,
        '93000000-0000-0000-0000-000000000007'::uuid,
        'Billing remote overlapping winner'
      FROM delayed_insert
      RETURNING id
    $remote$
  ),
  1,
  'the first overlapping attachment starts asynchronously'
);

DO $wait_for_remote_topology_lock_overlap$
DECLARE
  v_lock_id bigint := hashtextextended(
    'workspace-branch-payment-topology',
    0
  );
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF NOT pg_try_advisory_lock(v_lock_id) THEN
      v_observed := true;
      EXIT;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_id);
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote overlapping attachment did not acquire the topology lock';
  END IF;
END;
$wait_for_remote_topology_lock_overlap$;

SELECT lives_ok(
  $$
    INSERT INTO public.workspace_branches (
      source_workspace_id,
      branch_workspace_id,
      name
    )
    VALUES (
      '93000000-0000-0000-0000-000000000007',
      '93000000-0000-0000-0000-000000000008',
      'Billing local overlapping waiter'
    )
  $$,
  'an overlapping attachment waits and then uses the winner''s resolved owner'
);

SELECT lives_ok(
  $$
    SELECT remote_result.result
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result uuid)
  $$,
  'the winning overlapping attachment commits normally'
);

SELECT is(
  public.workspace_usage_owner_id(
    '93000000-0000-0000-0000-000000000008'
  ),
  '93000000-0000-0000-0000-000000000006'::uuid,
  'the overlapping leaf resolves to the committed root instead of a stale middle owner'
);

-- Configuration saves on a nested leaf lock the complete family root-to-leaf.
-- A concurrent intermediate status update can therefore finish propagating to
-- the leaf before configuration reconciliation propagates from the root.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT public.admin_upsert_workspace_payment_configuration(
  '93000000-0000-0000-0000-000000000008',
  '17000',
  true,
  false,
  '0',
  'Nested configuration race setup'
);

UPDATE public.workspaces
SET
  locked_workspace = true,
  usage_limit_locked = false,
  payment_renewal_locked = false,
  subscription_expiry_locked = true
WHERE id = '93000000-0000-0000-0000-000000000006';

SELECT is(
  dblink_send_query(
    'billing_concurrent_reviewer',
    $remote$
      WITH middle_row AS MATERIALIZED (
        SELECT id
        FROM public.workspaces
        WHERE id = '93000000-0000-0000-0000-000000000007'
        FOR UPDATE
      ),
      row_lock_signal AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended('billing-test-nested-middle-row', 0)
        )
        FROM middle_row
      ),
      delayed_update AS MATERIALIZED (
        SELECT pg_sleep(0.5)
        FROM row_lock_signal
      )
      UPDATE public.workspaces AS workspace_row
      SET subscription_expiry_locked = NOT workspace_row.subscription_expiry_locked
      FROM delayed_update
      WHERE workspace_row.id = '93000000-0000-0000-0000-000000000007'
      RETURNING workspace_row.id
    $remote$
  ),
  1,
  'an intermediate branch status update starts while a leaf configuration is saved'
);

DO $wait_for_remote_nested_middle_row$
DECLARE
  v_lock_id bigint := hashtextextended(
    'billing-test-nested-middle-row',
    0
  );
  v_observed boolean := false;
BEGIN
  FOR v_attempt IN 1..500 LOOP
    IF NOT pg_try_advisory_lock(v_lock_id) THEN
      v_observed := true;
      EXIT;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_id);
    PERFORM pg_sleep(0.01);
  END LOOP;

  IF NOT v_observed THEN
    RAISE EXCEPTION 'remote intermediate update did not lock the middle workspace row';
  END IF;
END;
$wait_for_remote_nested_middle_row$;

SELECT lives_ok(
  $$
    SELECT public.admin_upsert_workspace_payment_configuration(
      '93000000-0000-0000-0000-000000000008',
      '17500',
      true,
      false,
      '0',
      'Nested configuration race editor'
    )
  $$,
  'a nested leaf configuration save waits root-to-leaf without deadlocking status propagation'
);

SELECT lives_ok(
  $$
    SELECT remote_result.result
    FROM dblink_get_result('billing_concurrent_reviewer')
      AS remote_result(result uuid)
  $$,
  'the intermediate status update completes after propagating to its leaf'
);

SELECT is(
  (
    SELECT subscription_amount
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = '93000000-0000-0000-0000-000000000008'
  ),
  17500::numeric,
  'the raced nested configuration edit commits its requested snapshot'
);

DELETE FROM billing.workspace_payment_configurations
WHERE workspace_id IN (
  '93000000-0000-0000-0000-000000000006',
  '93000000-0000-0000-0000-000000000007',
  '93000000-0000-0000-0000-000000000008'
);
DELETE FROM billing.workspace_payment_configuration_audit
WHERE workspace_id IN (
  '93000000-0000-0000-0000-000000000006',
  '93000000-0000-0000-0000-000000000007',
  '93000000-0000-0000-0000-000000000008'
);

DELETE FROM billing.payment_transactions
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000003';
DELETE FROM billing.payment_transaction_status_audit
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000003';
DELETE FROM billing.workspace_payment_configurations
WHERE workspace_id IN (
  '93000000-0000-0000-0000-000000000002',
  '93000000-0000-0000-0000-000000000003'
);
DELETE FROM billing.workspace_payment_configuration_audit
WHERE workspace_id IN (
  '93000000-0000-0000-0000-000000000002',
  '93000000-0000-0000-0000-000000000003'
);
DELETE FROM public.profiles
WHERE id = '94000000-0000-0000-0000-000000000002';
DELETE FROM auth.users
WHERE id = '94000000-0000-0000-0000-000000000002';
DELETE FROM public.app_permissions
WHERE key_name = 'user_94000000-0000-0000-0000-000000000002';
DELETE FROM public.workspaces
WHERE id IN (
  '93000000-0000-0000-0000-000000000002',
  '93000000-0000-0000-0000-000000000003',
  '93000000-0000-0000-0000-000000000004',
  '93000000-0000-0000-0000-000000000005',
  '93000000-0000-0000-0000-000000000006',
  '93000000-0000-0000-0000-000000000007',
  '93000000-0000-0000-0000-000000000008'
);

SELECT lives_ok(
  $$SELECT dblink_disconnect('billing_concurrent_reviewer')$$,
  'the concurrent reviewer connection closes cleanly'
);

DELETE FROM billing.payment_transactions
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM billing.workspace_payment_configurations
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM billing.payment_transaction_status_audit
WHERE billing_workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM billing.workspace_payment_configuration_audit
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM public.profiles
WHERE id = '94000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
WHERE id = '94000000-0000-0000-0000-000000000001';
DELETE FROM public.app_permissions
WHERE key_name = 'user_94000000-0000-0000-0000-000000000001';
DELETE FROM public.workspace_usage_limits
WHERE workspace_id = '93000000-0000-0000-0000-000000000001';
DELETE FROM public.workspaces
WHERE id = '93000000-0000-0000-0000-000000000001';

SELECT * FROM finish();
