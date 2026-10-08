-- Move monthly subscription state into the existing billing configuration.
-- payment_transactions and billing configuration audit history remain intact.
BEGIN;

-- Snapshot and migrate only non-branch billing owners in cloud/local/hybrid
-- workspaces that are not configured for usage, prepaid-term, or PAYG billing.
CREATE TEMP TABLE monthly_subscription_migration_snapshot
ON COMMIT DROP AS
SELECT
  workspace_row.id AS workspace_id,
  workspace_row.subscription_expires_at AS old_renewal_due_at,
  workspace_row.locked_workspace,
  workspace_row.usage_limit_locked,
  workspace_row.payment_renewal_locked,
  workspace_row.subscription_expiry_locked
FROM public.workspaces AS workspace_row
LEFT JOIN billing.workspace_payment_configurations AS configuration_row
  ON configuration_row.workspace_id = public.workspace_usage_owner_id(workspace_row.id)
LEFT JOIN public.workspace_usage_limits AS limits
  ON limits.workspace_id = public.workspace_usage_owner_id(workspace_row.id)
WHERE workspace_row.deleted_at IS NULL
  AND workspace_row.data_mode::text IN ('cloud', 'hybrid', 'local')
  AND public.workspace_usage_owner_id(workspace_row.id) = workspace_row.id
  AND limits.workspace_id IS NULL
  AND (
    configuration_row.id IS NULL
    OR (
      configuration_row.usage_enabled = false
      AND configuration_row.payg_enabled = false
      AND configuration_row.billing_interval = 'monthly'
    )
  );

-- The backfill must not ask the old reconciler to reinterpret lock state while
-- rows are being copied. It still reads the old column at this point, but could
-- normalize stale markers and change access. Dates and existing lock markers
-- are asserted below; normal reconciliation resumes after this transaction.
ALTER TABLE billing.workspace_payment_configurations
  DISABLE TRIGGER reconcile_workspace_payment_renewal_lock_on_configuration;

-- Existing rows retain price, currency, payment eligibility, and all other
-- billing settings. Legacy-only rows receive a monthly configuration with
-- payments disabled until an administrator configures their payment terms.
INSERT INTO billing.workspace_payment_configurations (
  workspace_id,
  subscription_amount,
  currency,
  is_payment_enabled,
  usage_enabled,
  gb_per_payment,
  renewal_due_at,
  created_by_label,
  updated_by_label,
  created_via,
  updated_via
)
SELECT
  snapshot.workspace_id,
  0,
  'IQD',
  false,
  false,
  0,
  snapshot.old_renewal_due_at,
  'Monthly subscription billing migration',
  'Monthly subscription billing migration',
  'monthly-subscription-migration',
  'monthly-subscription-migration'
FROM monthly_subscription_migration_snapshot AS snapshot
WHERE NOT EXISTS (
  SELECT 1
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = snapshot.workspace_id
)
ON CONFLICT (workspace_id) DO NOTHING;

UPDATE billing.workspace_payment_configurations AS configuration_row
SET
  renewal_due_at = snapshot.old_renewal_due_at,
  updated_by_label = 'Monthly subscription billing migration',
  updated_via = 'monthly-subscription-migration'
FROM monthly_subscription_migration_snapshot AS snapshot
WHERE configuration_row.workspace_id = snapshot.workspace_id
  AND configuration_row.renewal_due_at IS DISTINCT FROM snapshot.old_renewal_due_at;

-- Active branch workspaces share the source workspace's billing owner. Verify
-- their old access boundary matched before making the source configuration
-- authoritative, then keep each branch configuration aligned with that owner.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.workspace_branches AS branch
    JOIN public.workspaces AS branch_workspace
      ON branch_workspace.id = branch.branch_workspace_id
    JOIN public.workspaces AS source_workspace
      ON source_workspace.id = branch.source_workspace_id
    JOIN billing.workspace_payment_configurations AS source_configuration
      ON source_configuration.workspace_id = public.workspace_usage_owner_id(source_workspace.id)
    WHERE branch.archived_at IS NULL
      AND branch_workspace.deleted_at IS NULL
      AND source_workspace.deleted_at IS NULL
      AND source_configuration.usage_enabled = false
      AND source_configuration.payg_enabled = false
      AND source_configuration.billing_interval = 'monthly'
      AND branch_workspace.subscription_expires_at
        IS DISTINCT FROM source_workspace.subscription_expires_at
  ) THEN
    RAISE EXCEPTION 'monthly_branch_expiry_mismatch_requires_review';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.workspace_branches AS branch
    JOIN public.workspaces AS source_workspace
      ON source_workspace.id = branch.source_workspace_id
    JOIN billing.workspace_payment_configurations AS source_configuration
      ON source_configuration.workspace_id = public.workspace_usage_owner_id(source_workspace.id)
    JOIN billing.workspace_payment_configurations AS branch_configuration
      ON branch_configuration.workspace_id = branch.branch_workspace_id
    WHERE branch.archived_at IS NULL
      AND source_workspace.deleted_at IS NULL
      AND source_configuration.usage_enabled = false
      AND source_configuration.payg_enabled = false
      AND source_configuration.billing_interval = 'monthly'
      AND (
        branch_configuration.usage_enabled
        OR branch_configuration.payg_enabled
        OR branch_configuration.billing_interval <> 'monthly'
      )
  ) THEN
    RAISE EXCEPTION 'monthly_branch_billing_mode_mismatch_requires_review';
  END IF;

  INSERT INTO billing.workspace_payment_configurations (
    workspace_id,
    subscription_amount,
    currency,
    is_payment_enabled,
    usage_enabled,
    gb_per_payment,
    renewal_due_at,
    created_by_label,
    updated_by_label,
    created_via,
    updated_via
  )
  SELECT
    branch.branch_workspace_id,
    source_configuration.subscription_amount,
    source_configuration.currency,
    source_configuration.is_payment_enabled,
    false,
    source_configuration.gb_per_payment,
    source_configuration.renewal_due_at,
    'Monthly subscription branch migration',
    'Monthly subscription branch migration',
    'monthly-subscription-migration',
    'monthly-subscription-migration'
  FROM public.workspace_branches AS branch
  JOIN public.workspaces AS source_workspace
    ON source_workspace.id = branch.source_workspace_id
  JOIN billing.workspace_payment_configurations AS source_configuration
    ON source_configuration.workspace_id = public.workspace_usage_owner_id(source_workspace.id)
  WHERE branch.archived_at IS NULL
    AND source_configuration.usage_enabled = false
    AND source_configuration.payg_enabled = false
    AND source_configuration.billing_interval = 'monthly'
    AND NOT EXISTS (
      SELECT 1
      FROM billing.workspace_payment_configurations AS branch_configuration
      WHERE branch_configuration.workspace_id = branch.branch_workspace_id
    )
  ON CONFLICT (workspace_id) DO NOTHING;

  UPDATE billing.workspace_payment_configurations AS branch_configuration
  SET
    renewal_due_at = source_configuration.renewal_due_at,
    updated_by_label = 'Monthly subscription branch migration',
    updated_via = 'monthly-subscription-migration'
  FROM public.workspace_branches AS branch
  JOIN billing.workspace_payment_configurations AS source_configuration
    ON source_configuration.workspace_id = public.workspace_usage_owner_id(branch.source_workspace_id)
  WHERE branch.archived_at IS NULL
    AND branch_configuration.workspace_id = branch.branch_workspace_id
    AND source_configuration.usage_enabled = false
    AND source_configuration.payg_enabled = false
    AND source_configuration.billing_interval = 'monthly'
    AND branch_configuration.usage_enabled = false
    AND branch_configuration.payg_enabled = false
    AND branch_configuration.billing_interval = 'monthly'
    AND branch_configuration.renewal_due_at IS DISTINCT FROM source_configuration.renewal_due_at;
END;
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM monthly_subscription_migration_snapshot AS snapshot
    LEFT JOIN billing.workspace_payment_configurations AS configuration_row
      ON configuration_row.workspace_id = snapshot.workspace_id
    WHERE configuration_row.id IS NULL
      OR configuration_row.renewal_due_at IS DISTINCT FROM snapshot.old_renewal_due_at
  ) THEN
    RAISE EXCEPTION 'monthly_subscription_billing_backfill_incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM monthly_subscription_migration_snapshot AS snapshot
    JOIN public.workspaces AS workspace_row ON workspace_row.id = snapshot.workspace_id
    WHERE workspace_row.locked_workspace IS DISTINCT FROM snapshot.locked_workspace
      OR workspace_row.usage_limit_locked IS DISTINCT FROM snapshot.usage_limit_locked
      OR workspace_row.payment_renewal_locked IS DISTINCT FROM snapshot.payment_renewal_locked
      OR workspace_row.subscription_expiry_locked IS DISTINCT FROM snapshot.subscription_expiry_locked
  ) THEN
    RAISE EXCEPTION 'monthly_subscription_migration_changed_access_markers';
  END IF;
END;
$migration$;

ALTER TABLE billing.workspace_payment_configurations
  ENABLE TRIGGER reconcile_workspace_payment_renewal_lock_on_configuration;

-- The monthly due date is now part of billing configuration. This RPC is only
-- reachable by the service-role Admin edge function, which performs the admin
-- authorization check before invoking it.
CREATE OR REPLACE FUNCTION public.admin_set_workspace_monthly_subscription_expiry(
  p_workspace_id uuid,
  p_renewal_due_at timestamptz,
  p_actor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_id uuid;
  v_configuration billing.workspace_payment_configurations;
  v_actor text := COALESCE(NULLIF(btrim(p_actor), ''), 'Platform administrator');
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;

  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-branch-payment-owner:' || p_workspace_id::text, 0)
  );

  SELECT public.workspace_usage_owner_id(workspace_row.id)
  INTO v_owner_id
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = p_workspace_id
    AND workspace_row.deleted_at IS NULL
  FOR UPDATE;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_owner_id::text, 0));

  SELECT configuration_row.*
  INTO v_configuration
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = v_owner_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.workspace_usage_limits AS limits WHERE limits.workspace_id = v_owner_id
  ) OR (
    v_configuration.id IS NOT NULL AND (
      v_configuration.usage_enabled
      OR v_configuration.payg_enabled
      OR v_configuration.billing_interval <> 'monthly'
    )
  ) THEN
    RAISE EXCEPTION 'workspace_is_not_monthly_subscription_billing'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM billing.workspace_payment_configurations AS branch_configuration
    WHERE branch_configuration.workspace_id <> v_owner_id
      AND public.workspace_usage_owner_id(branch_configuration.workspace_id) = v_owner_id
      AND (
        branch_configuration.usage_enabled
        OR branch_configuration.payg_enabled
        OR branch_configuration.billing_interval <> 'monthly'
      )
  ) THEN
    RAISE EXCEPTION 'workspace_payment_family_mode_mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF v_configuration.id IS NULL THEN
    INSERT INTO billing.workspace_payment_configurations (
      workspace_id,
      subscription_amount,
      currency,
      is_payment_enabled,
      usage_enabled,
      gb_per_payment,
      renewal_due_at,
      created_by_label,
      updated_by_label,
      created_via,
      updated_via
    ) VALUES (
      v_owner_id,
      0,
      'IQD',
      false,
      false,
      0,
      p_renewal_due_at,
      v_actor,
      v_actor,
      'admin-console',
      'admin-console'
    )
    RETURNING * INTO v_configuration;
  ELSE
    UPDATE billing.workspace_payment_configurations AS configuration_row
    SET
      renewal_due_at = p_renewal_due_at,
      updated_by = auth.uid(),
      updated_by_label = v_actor,
      updated_via = 'admin-console'
    WHERE configuration_row.workspace_id = v_owner_id
    RETURNING * INTO v_configuration;
  END IF;

  UPDATE billing.workspace_payment_configurations AS branch_configuration
  SET
    renewal_due_at = p_renewal_due_at,
    updated_by = auth.uid(),
    updated_by_label = v_actor,
    updated_via = 'admin-console'
  WHERE branch_configuration.workspace_id <> v_owner_id
    AND public.workspace_usage_owner_id(branch_configuration.workspace_id) = v_owner_id
    AND branch_configuration.usage_enabled = false
    AND branch_configuration.payg_enabled = false
    AND branch_configuration.billing_interval = 'monthly';

  PERFORM billing.reconcile_workspace_payment_renewal_lock(v_owner_id);

  RETURN jsonb_build_object(
    'workspace_id', p_workspace_id,
    'billing_workspace_id', v_owner_id,
    'renewal_due_at', v_configuration.renewal_due_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_workspace_monthly_subscription_expiry(uuid, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_workspace_monthly_subscription_expiry(uuid, timestamptz, text)
  TO service_role;

-- Preserve the established lock ownership and grace behavior, with monthly
-- expiry read from the central billing configuration.
CREATE OR REPLACE FUNCTION billing.reconcile_workspace_payment_renewal_lock_legacy(
  p_workspace_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_billing_workspace_id uuid := public.workspace_usage_owner_id(p_workspace_id);
  v_usage_enabled boolean := false;
  v_is_due boolean := false;
  v_subscription_expired boolean := false;
BEGIN
  IF v_billing_workspace_id IS NULL THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-payment-configuration:' || v_billing_workspace_id::text, 0)
  );

  SELECT
    (
      EXISTS (
        SELECT 1
        FROM billing.workspace_payment_configurations AS configuration_row
        WHERE configuration_row.usage_enabled = true
          AND public.workspace_usage_owner_id(configuration_row.workspace_id) = v_billing_workspace_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.workspace_usage_limits AS limits
        WHERE limits.workspace_id = v_billing_workspace_id
      )
    ),
    EXISTS (
      SELECT 1
      FROM billing.workspace_payment_configurations AS configuration_row
      WHERE configuration_row.usage_enabled = true
        AND configuration_row.renewal_due_at <= now()
        AND public.workspace_usage_owner_id(configuration_row.workspace_id) = v_billing_workspace_id
    )
  INTO v_usage_enabled, v_is_due;

  SELECT COALESCE((
    SELECT configuration_row.renewal_due_at <= now()
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE configuration_row.workspace_id = v_billing_workspace_id
      AND configuration_row.usage_enabled = false
      AND configuration_row.payg_enabled = false
      AND configuration_row.billing_interval = 'monthly'
  ), false)
  INTO v_subscription_expired;

  PERFORM set_config('atlas.trusted_workspace_lock_update', 'on', true);

  IF NOT v_usage_enabled THEN
    UPDATE public.workspaces AS workspace_row
    SET
      locked_workspace = CASE
        WHEN v_subscription_expired THEN true
        WHEN workspace_row.usage_limit_locked
          OR workspace_row.payment_renewal_locked
          OR workspace_row.subscription_expiry_locked THEN false
        ELSE workspace_row.locked_workspace
      END,
      usage_limit_locked = false,
      payment_renewal_locked = false,
      subscription_expiry_locked = CASE
        WHEN NOT v_subscription_expired THEN false
        WHEN workspace_row.locked_workspace = false
          OR workspace_row.usage_limit_locked
          OR workspace_row.payment_renewal_locked
          OR workspace_row.subscription_expiry_locked THEN true
        ELSE false
      END
    WHERE workspace_row.id = v_billing_workspace_id
      AND (
        workspace_row.usage_limit_locked
        OR workspace_row.payment_renewal_locked
        OR workspace_row.subscription_expiry_locked IS DISTINCT FROM CASE
          WHEN NOT v_subscription_expired THEN false
          WHEN workspace_row.locked_workspace = false
            OR workspace_row.usage_limit_locked
            OR workspace_row.payment_renewal_locked
            OR workspace_row.subscription_expiry_locked THEN true
          ELSE false
        END
        OR workspace_row.locked_workspace IS DISTINCT FROM CASE
          WHEN v_subscription_expired THEN true
          WHEN workspace_row.usage_limit_locked
            OR workspace_row.payment_renewal_locked
            OR workspace_row.subscription_expiry_locked THEN false
          ELSE workspace_row.locked_workspace
        END
      );
    RETURN;
  END IF;

  UPDATE public.workspaces AS workspace_row
  SET
    locked_workspace = workspace_row.usage_limit_locked OR workspace_row.payment_renewal_locked,
    subscription_expiry_locked = false
  WHERE workspace_row.id = v_billing_workspace_id
    AND workspace_row.subscription_expiry_locked = true;

  IF v_is_due THEN
    UPDATE public.workspaces AS workspace_row
    SET locked_workspace = true, payment_renewal_locked = true
    WHERE workspace_row.id = v_billing_workspace_id
      AND (
        workspace_row.locked_workspace IS DISTINCT FROM true
        OR workspace_row.payment_renewal_locked IS DISTINCT FROM true
      )
      AND (
        workspace_row.locked_workspace = false
        OR workspace_row.usage_limit_locked = true
        OR workspace_row.subscription_expiry_locked = true
        OR workspace_row.payment_renewal_locked = true
      );
  ELSIF EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace_row
    WHERE workspace_row.id = v_billing_workspace_id
      AND workspace_row.payment_renewal_locked = true
  ) THEN
    UPDATE public.workspaces AS workspace_row
    SET
      locked_workspace = workspace_row.usage_limit_locked,
      payment_renewal_locked = false
    WHERE workspace_row.id = v_billing_workspace_id;
  END IF;

  PERFORM public.reconcile_workspace_usage_limit_lock(v_billing_workspace_id);
END;
$function$;

-- Change the old monthly approval branch to extend billing configuration. The
-- rest of the established review flow continues to preserve transaction audit,
-- usage credits, row locks, and status transitions.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := replace(
    pg_get_functiondef('public.admin_review_workspace_payment_transaction_base(uuid,text,text,text,text)'::regprocedure),
    E'\r\n', E'\n'
  );
  v_definition := replace(v_definition, 'v_subscription_expires_at', 'v_monthly_renewal_due_at');

  v_old := $old$
  IF v_transaction.payment_type = 'subscription' THEN
    UPDATE public.workspaces AS workspace_row
    SET
      subscription_expires_at = GREATEST(
        COALESCE(workspace_row.subscription_expires_at, now()),
        now()
      ) + INTERVAL '1 month',
      locked_workspace = CASE
        WHEN workspace_row.subscription_expiry_locked THEN
          workspace_row.usage_limit_locked OR workspace_row.payment_renewal_locked
        ELSE workspace_row.locked_workspace
      END,
      subscription_expiry_locked = false
    WHERE workspace_row.id = v_transaction.billing_workspace_id
      AND workspace_row.deleted_at IS NULL
    RETURNING workspace_row.subscription_expires_at
    INTO v_monthly_renewal_due_at;

    IF v_monthly_renewal_due_at IS NULL THEN
      RAISE EXCEPTION 'billing_workspace_not_found'
        USING ERRCODE = 'P0002';
    END IF;
  ELSE
$old$;

  v_new := $new$
  IF v_transaction.payment_type = 'subscription' THEN
    SELECT configuration_row.renewal_due_at
    INTO v_current_renewal_due_at
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE configuration_row.workspace_id = v_transaction.billing_workspace_id
      AND configuration_row.usage_enabled = false
      AND configuration_row.payg_enabled = false
      AND configuration_row.billing_interval = 'monthly'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'monthly_subscription_configuration_not_found'
        USING ERRCODE = 'P0002';
    END IF;

    v_monthly_renewal_due_at := GREATEST(
      COALESCE(v_current_renewal_due_at, now()),
      now()
    ) + INTERVAL '1 month';

    UPDATE billing.workspace_payment_configurations AS configuration_row
    SET
      renewal_due_at = v_monthly_renewal_due_at,
      updated_by = auth.uid(),
      updated_by_label = v_reviewer_label,
      updated_via = 'payment-approval'
    WHERE configuration_row.workspace_id = v_transaction.billing_workspace_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'monthly_subscription_configuration_not_found'
        USING ERRCODE = 'P0002';
    END IF;

    PERFORM billing.reconcile_workspace_payment_renewal_lock(
      v_transaction.billing_workspace_id
    );
  ELSE
$new$;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'monthly_subscription_approval_branch_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_definition := replace(v_definition, '''subscription_expires_at''', '''renewal_due_at''');

  v_old := $old$
    SELECT workspace_row.subscription_expires_at
    INTO v_monthly_renewal_due_at
    FROM public.workspaces AS workspace_row
    WHERE workspace_row.id = v_transaction.billing_workspace_id;
$old$;
  v_new := $new$
    SELECT configuration_row.renewal_due_at
    INTO v_monthly_renewal_due_at
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE configuration_row.workspace_id = v_transaction.billing_workspace_id;
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'monthly_subscription_approval_return_date_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  IF v_definition ILIKE '%subscription_expires_at%' THEN
    RAISE EXCEPTION 'monthly_subscription_approval_legacy_reference_remains';
  END IF;
  EXECUTE v_definition;
END;
$migration$;

-- Temporary extra days now operate on the central monthly due date while
-- retaining their precise consumption and settlement behavior.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := replace(
    pg_get_functiondef('public.grant_workspace_subscription_extra_days_v1(integer)'::regprocedure),
    E'\r\n', E'\n'
  );
  v_definition := replace(v_definition, 'v_subscription_expires_at', 'v_renewal_due_at');

  v_old := $old$
  SELECT GREATEST(
    COALESCE(workspace_row.subscription_expires_at, now()),
    now()
  )
  INTO v_temporary_period_starts_at
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = v_billing_workspace_id
    AND workspace_row.deleted_at IS NULL
  FOR UPDATE;
$old$;
  v_new := $new$
  SELECT GREATEST(COALESCE(configuration_row.renewal_due_at, now()), now())
  INTO v_temporary_period_starts_at
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = v_billing_workspace_id
    AND configuration_row.usage_enabled = false
    AND configuration_row.payg_enabled = false
    AND configuration_row.billing_interval = 'monthly'
  FOR UPDATE;
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'monthly_extra_days_start_boundary_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
  UPDATE public.workspaces AS workspace_row
  SET
    subscription_expires_at = v_temporary_period_starts_at
      + make_interval(days => p_extra_days),
    locked_workspace = CASE
      WHEN workspace_row.subscription_expiry_locked THEN
        workspace_row.usage_limit_locked OR workspace_row.payment_renewal_locked
      ELSE workspace_row.locked_workspace
    END,
    subscription_expiry_locked = false
  WHERE workspace_row.id = v_billing_workspace_id
    AND workspace_row.deleted_at IS NULL
  RETURNING workspace_row.subscription_expires_at
  INTO v_renewal_due_at;

  IF v_renewal_due_at IS NULL THEN
    RAISE EXCEPTION 'billing_workspace_not_found'
      USING ERRCODE = 'P0002';
  END IF;
$old$;
  v_new := $new$
  UPDATE billing.workspace_payment_configurations AS configuration_row
  SET
    renewal_due_at = v_temporary_period_starts_at + make_interval(days => p_extra_days),
    updated_by = v_user_id,
    updated_by_label = 'Workspace administrator',
    updated_via = 'extra-days-grant'
  WHERE configuration_row.workspace_id = v_billing_workspace_id
  RETURNING configuration_row.renewal_due_at INTO v_renewal_due_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_workspace_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM billing.reconcile_workspace_payment_renewal_lock(v_billing_workspace_id);
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'monthly_extra_days_due_date_update_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_definition := replace(v_definition, '''subscription_expires_at''', '''renewal_due_at''');

  v_old := $old$
  IF v_configuration.usage_enabled THEN
$old$;
  v_new := $new$
  IF v_configuration.usage_enabled
    OR v_configuration.payg_enabled
    OR v_configuration.billing_interval <> 'monthly' THEN
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'monthly_extra_days_billing_mode_guard_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  IF v_definition ILIKE '%subscription_expires_at%' THEN
    RAISE EXCEPTION 'monthly_extra_days_legacy_reference_remains';
  END IF;
  EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := replace(
    pg_get_functiondef('public.admin_review_workspace_payment_transaction(uuid,text,text,text,text)'::regprocedure),
    E'\r\n', E'\n'
  );
  v_definition := replace(v_definition, 'v_adjusted_subscription_expires_at', 'v_adjusted_renewal_due_at');

  v_old := $old$
  UPDATE public.workspaces AS workspace_row
  SET subscription_expires_at = workspace_row.subscription_expires_at
    - make_interval(secs => v_remaining_duration_seconds)
  WHERE workspace_row.id = v_transaction.billing_workspace_id
    AND workspace_row.deleted_at IS NULL
  RETURNING workspace_row.subscription_expires_at
  INTO v_adjusted_renewal_due_at;

  IF v_adjusted_renewal_due_at IS NULL THEN
    RAISE EXCEPTION 'billing_workspace_not_found'
      USING ERRCODE = 'P0002';
  END IF;
$old$;
  v_new := $new$
  UPDATE billing.workspace_payment_configurations AS configuration_row
  SET
    renewal_due_at = configuration_row.renewal_due_at
      - make_interval(secs => v_remaining_duration_seconds),
    updated_by = auth.uid(),
    updated_by_label = 'Platform administrator',
    updated_via = 'extra-days-settlement'
  WHERE configuration_row.workspace_id = v_transaction.billing_workspace_id
  RETURNING configuration_row.renewal_due_at
  INTO v_adjusted_renewal_due_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_workspace_not_found'
      USING ERRCODE = 'P0002';
  END IF;
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'monthly_extra_days_settlement_due_date_update_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_definition := replace(v_definition, '''subscription_expires_at''', '''renewal_due_at''');

  IF v_definition ILIKE '%subscription_expires_at%' THEN
    RAISE EXCEPTION 'monthly_extra_days_settlement_legacy_reference_remains';
  END IF;
  EXECUTE v_definition;
END;
$migration$;

-- Keep the payment summary shape while sourcing monthly status from billing.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := replace(
    pg_get_functiondef('public.get_workspace_payment_summary_base()'::regprocedure),
    E'\r\n', E'\n'
  );
  v_definition := replace(v_definition, 'v_subscription_expires_at', 'v_monthly_renewal_due_at');

  v_old := $old$
  SELECT
    workspace_row.subscription_expires_at,
    workspace_row.usage_limit_locked
  INTO
    v_monthly_renewal_due_at,
    v_usage_limit_locked
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = v_billing_workspace_id;
$old$;
  v_new := $new$
  SELECT
    v_configuration.renewal_due_at,
    workspace_row.usage_limit_locked
  INTO
    v_monthly_renewal_due_at,
    v_usage_limit_locked
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = v_billing_workspace_id;
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'monthly_payment_summary_due_date_source_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_definition := replace(v_definition, '''subscription_expires_at''', '''renewal_due_at''');
  v_old := $old$
  IF v_is_usage_mode THEN
    v_usage_exhausted := v_effective_allowance IS NOT NULL
      AND COALESCE(v_usage.data_transfer_bytes, 0) >= v_effective_allowance;
    v_usage_renewal_due := COALESCE(v_configuration.usage_enabled, false)
      AND v_configuration.renewal_due_at <= now();
  ELSE
    v_subscription_expired := v_monthly_renewal_due_at IS NOT NULL
      AND v_monthly_renewal_due_at <= now();
  END IF;
$old$;
  v_new := $new$
  IF COALESCE(v_configuration.payg_enabled, false) THEN
    v_subscription_expired := false;
  ELSIF v_is_usage_mode THEN
    v_usage_exhausted := v_effective_allowance IS NOT NULL
      AND COALESCE(v_usage.data_transfer_bytes, 0) >= v_effective_allowance;
    v_usage_renewal_due := COALESCE(v_configuration.usage_enabled, false)
      AND v_configuration.renewal_due_at <= now();
  ELSE
    v_subscription_expired := v_monthly_renewal_due_at IS NOT NULL
      AND v_monthly_renewal_due_at <= now();
  END IF;
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'monthly_payment_summary_mode_branch_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  IF v_definition ILIKE '%subscription_expires_at%' THEN
    RAISE EXCEPTION 'monthly_payment_summary_legacy_reference_remains';
  END IF;
  EXECUTE v_definition;
END;
$migration$;

-- Keep workspace security and branch lock synchronization, removing only the
-- dropped expiry field from their definitions and trigger column lists.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := replace(pg_get_functiondef('public.prevent_restricted_workspace_client_updates()'::regprocedure), E'\r\n', E'\n');
  v_definition := replace(v_definition, '      OR NEW.subscription_expires_at IS DISTINCT FROM OLD.subscription_expires_at' || E'\n', '');
  IF v_definition ILIKE '%subscription_expires_at%' THEN RAISE EXCEPTION 'workspace_client_guard_legacy_reference_remains'; END IF;
  EXECUTE v_definition;

  v_definition := replace(pg_get_functiondef('public.restore_branch(uuid,uuid)'::regprocedure), E'\r\n', E'\n');
  v_definition := replace(v_definition, '      subscription_expires_at = v_source_workspace.subscription_expires_at' || E'\n', '');
  v_old := $old$
      locked_workspace = v_source_workspace.locked_workspace,
  WHERE id = p_branch_workspace_id;
$old$;
  v_new := $new$
      locked_workspace = v_source_workspace.locked_workspace
  WHERE id = p_branch_workspace_id;
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'restore_branch_workspace_update_anchor_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_old := $old$
  UPDATE public.workspace_branches
  SET archived_at = NULL,
$old$;
  v_new := $new$
  IF EXISTS (
    SELECT 1
    FROM billing.workspace_payment_configurations AS source_configuration
    JOIN billing.workspace_payment_configurations AS branch_configuration
      ON branch_configuration.workspace_id = p_branch_workspace_id
    WHERE source_configuration.workspace_id = public.workspace_usage_owner_id(p_source_workspace_id)
      AND source_configuration.usage_enabled = false
      AND source_configuration.payg_enabled = false
      AND source_configuration.billing_interval = 'monthly'
      AND (
        branch_configuration.usage_enabled
        OR branch_configuration.payg_enabled
        OR branch_configuration.billing_interval <> 'monthly'
      )
  ) THEN
    RAISE EXCEPTION 'branch_billing_mode_mismatch_requires_review';
  END IF;

  INSERT INTO billing.workspace_payment_configurations (
    workspace_id,
    subscription_amount,
    currency,
    is_payment_enabled,
    usage_enabled,
    gb_per_payment,
    renewal_due_at,
    billing_interval,
    payg_enabled,
    created_by,
    updated_by,
    created_by_label,
    updated_by_label,
    created_via,
    updated_via
  )
  SELECT
    p_branch_workspace_id,
    source_configuration.subscription_amount,
    source_configuration.currency,
    source_configuration.is_payment_enabled,
    false,
    source_configuration.gb_per_payment,
    source_configuration.renewal_due_at,
    'monthly',
    false,
    auth.uid(),
    auth.uid(),
    'Branch restoration',
    'Branch restoration',
    'branch-restoration',
    'branch-restoration'
  FROM billing.workspace_payment_configurations AS source_configuration
  WHERE source_configuration.workspace_id = public.workspace_usage_owner_id(p_source_workspace_id)
    AND source_configuration.usage_enabled = false
    AND source_configuration.payg_enabled = false
    AND source_configuration.billing_interval = 'monthly'
  ON CONFLICT (workspace_id) DO UPDATE
  SET
    renewal_due_at = EXCLUDED.renewal_due_at,
    updated_by = auth.uid(),
    updated_by_label = 'Branch restoration',
    updated_via = 'branch-restoration';

  UPDATE public.workspace_branches
  SET archived_at = NULL,
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'restore_branch_billing_sync_point_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  IF v_definition ILIKE '%subscription_expires_at%' THEN RAISE EXCEPTION 'restore_branch_legacy_reference_remains'; END IF;
  EXECUTE v_definition;

  v_definition := replace(pg_get_functiondef('public.sync_branch_workspace_status_from_source()'::regprocedure), E'\r\n', E'\n');
  v_definition := replace(v_definition, '    subscription_expires_at = NEW.subscription_expires_at' || E'\n', '');
  v_definition := replace(v_definition, '      OR branch_workspace.subscription_expires_at IS DISTINCT FROM NEW.subscription_expires_at' || E'\n', '');
  v_old := $old$
    subscription_expiry_locked = NEW.subscription_expiry_locked,
  WHERE branch_workspace.id IN (
$old$;
  v_new := $new$
    subscription_expiry_locked = NEW.subscription_expiry_locked
  WHERE branch_workspace.id IN (
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'branch_status_sync_workspace_update_anchor_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  IF v_definition ILIKE '%subscription_expires_at%' THEN RAISE EXCEPTION 'branch_status_sync_legacy_reference_remains'; END IF;
  EXECUTE v_definition;

  v_definition := replace(pg_get_functiondef('public.sync_new_branch_workspace_status_from_source()'::regprocedure), E'\r\n', E'\n');
  v_definition := replace(v_definition, '    subscription_expires_at = source_workspace.subscription_expires_at' || E'\n', '');
  v_definition := replace(v_definition, '      OR branch_workspace.subscription_expires_at IS DISTINCT FROM source_workspace.subscription_expires_at' || E'\n', '');
  v_old := $old$
    subscription_expiry_locked = source_workspace.subscription_expiry_locked,
  FROM public.workspaces AS source_workspace
$old$;
  v_new := $new$
    subscription_expiry_locked = source_workspace.subscription_expiry_locked
  FROM public.workspaces AS source_workspace
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'new_branch_status_sync_workspace_update_anchor_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  IF v_definition ILIKE '%subscription_expires_at%' THEN RAISE EXCEPTION 'new_branch_status_sync_legacy_reference_remains'; END IF;
  EXECUTE v_definition;
END;
$migration$;

DROP TRIGGER IF EXISTS trg_sync_branch_workspace_status_from_source ON public.workspaces;
CREATE TRIGGER trg_sync_branch_workspace_status_from_source
AFTER UPDATE OF locked_workspace, usage_limit_locked, payment_renewal_locked, subscription_expiry_locked
ON public.workspaces
FOR EACH ROW
WHEN (
  NEW.locked_workspace IS DISTINCT FROM OLD.locked_workspace
  OR NEW.usage_limit_locked IS DISTINCT FROM OLD.usage_limit_locked
  OR NEW.payment_renewal_locked IS DISTINCT FROM OLD.payment_renewal_locked
  OR NEW.subscription_expiry_locked IS DISTINCT FROM OLD.subscription_expiry_locked
)
EXECUTE FUNCTION public.sync_branch_workspace_status_from_source();

-- Demo workspaces have an independent server-side timer table. Keep the cleanup
-- job on that timer rather than treating a demo as a paid monthly subscription.
CREATE OR REPLACE FUNCTION public.cleanup_expired_demos()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE
  v_workspace record;
  v_user_ids uuid[];
  v_user_id uuid;
  v_cleaned integer := 0;
BEGIN
  FOR v_workspace IN
    SELECT demo.workspace_id
    FROM public.demos AS demo
    WHERE demo.expires_at <= now()
    ORDER BY demo.expires_at
    FOR UPDATE
  LOOP
    SELECT array_agg(profile.id) INTO v_user_ids
    FROM public.profiles AS profile
    WHERE profile.workspace_id = v_workspace.workspace_id;

    IF to_regprocedure('public.delete_demo_cascade(uuid)') IS NOT NULL THEN
      PERFORM public.delete_demo_cascade(v_workspace.workspace_id);
    ELSE
      -- Demo workspace data is local-only; without the legacy cascade helper
      -- there is no server workspace to delete. Remove only its timer row.
      NULL;
    END IF;

    IF v_user_ids IS NOT NULL THEN
      FOREACH v_user_id IN ARRAY v_user_ids LOOP
        DELETE FROM auth.users WHERE id = v_user_id;
      END LOOP;
    END IF;

    DELETE FROM public.demos WHERE workspace_id = v_workspace.workspace_id;
    v_cleaned := v_cleaned + 1;
  END LOOP;

  RETURN v_cleaned;
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_expired_demos() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_demos() TO service_role;

-- This obsolete RPC references a table that no longer exists and has no app
-- caller. Centralized payment_transactions is the supported payment history.
DROP FUNCTION IF EXISTS public.complete_subscription_payment(uuid, text, text, numeric, text, timestamptz, jsonb);

ALTER TABLE public.workspaces DROP COLUMN subscription_expires_at;

NOTIFY pgrst, 'reload schema';
COMMIT;
