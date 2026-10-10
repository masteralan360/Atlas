BEGIN;

ALTER TABLE billing.payment_transactions
  ADD COLUMN billing_snapshot jsonb NULL,
  ADD CONSTRAINT workspace_payment_billing_snapshot_object_check
    CHECK (billing_snapshot IS NULL OR jsonb_typeof(billing_snapshot) = 'object');

COMMENT ON COLUMN billing.payment_transactions.billing_snapshot IS
  'Server-captured billing terms and period at payment submission; kept immutable for approval and billing-operation audit.';

CREATE OR REPLACE FUNCTION billing.workspace_payment_configuration_terms(p_configuration jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'subscription_amount', p_configuration -> 'subscription_amount',
    'currency', p_configuration -> 'currency',
    'is_payment_enabled', p_configuration -> 'is_payment_enabled',
    'usage_enabled', p_configuration -> 'usage_enabled',
    'payg_enabled', p_configuration -> 'payg_enabled',
    'gb_per_payment', p_configuration -> 'gb_per_payment',
    'renewal_due_at', p_configuration -> 'renewal_due_at',
    'usage_start_date', p_configuration -> 'usage_start_date',
    'billing_interval', p_configuration -> 'billing_interval',
    'monthly_allowance_gb', p_configuration -> 'monthly_allowance_gb',
    'prepaid_cycles', p_configuration -> 'prepaid_cycles',
    'prepaid_amount', p_configuration -> 'prepaid_amount',
    'prepaid_term_started_at', p_configuration -> 'prepaid_term_started_at',
    'prepaid_allowance_mode', p_configuration -> 'prepaid_allowance_mode',
    'term_allowance_gb', p_configuration -> 'term_allowance_gb',
    'rollover_enabled', p_configuration -> 'rollover_enabled',
    'payg_profile_id', p_configuration -> 'payg_profile_id',
    'payg_cycle_started_at', p_configuration -> 'payg_cycle_started_at',
    'pending_billing_mode', p_configuration -> 'pending_billing_mode',
    'pending_billing_termination', p_configuration -> 'pending_billing_termination',
    'pending_subscription_amount', p_configuration -> 'pending_subscription_amount',
    'pending_gb_per_payment', p_configuration -> 'pending_gb_per_payment',
    'pending_payment_enabled', p_configuration -> 'pending_payment_enabled',
    'pending_renewal_due_at', p_configuration -> 'pending_renewal_due_at',
    'pending_usage_start_date', p_configuration -> 'pending_usage_start_date'
  ));
$function$;

CREATE OR REPLACE FUNCTION billing.capture_workspace_payment_billing_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_configuration jsonb;
  v_workspace_configuration jsonb;
  v_payg_cycle jsonb;
  v_billing_mode text;
BEGIN
  -- Workspace submissions use FIB or QiCard. Admin-created manual payments
  -- already have their own immutable Billing Operations request snapshot.
  IF NEW.status <> 'pending'
    OR NEW.user_id IS NULL
    OR NEW.provider NOT IN ('fib', 'qicard') THEN
    RETURN NEW;
  END IF;

  SELECT to_jsonb(configuration_row)
  INTO v_owner_configuration
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = NEW.billing_workspace_id;

  SELECT to_jsonb(configuration_row)
  INTO v_workspace_configuration
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = NEW.workspace_id;

  IF v_owner_configuration IS NULL THEN
    RAISE EXCEPTION 'workspace_payment_billing_configuration_missing'
      USING ERRCODE = 'P0002';
  END IF;

  IF NEW.payment_type = 'payg' THEN
    SELECT to_jsonb(cycle_row)
    INTO v_payg_cycle
    FROM billing.payg_cycles AS cycle_row
    WHERE cycle_row.id = NEW.payg_cycle_id;

    IF v_payg_cycle IS NULL THEN
      RAISE EXCEPTION 'workspace_payment_payg_cycle_snapshot_missing'
        USING ERRCODE = 'P0002';
    END IF;
    v_billing_mode := 'payg';
  ELSE
    v_billing_mode := CASE
      WHEN COALESCE((v_workspace_configuration ->> 'payg_enabled')::boolean, false)
        THEN 'payg'
      WHEN v_workspace_configuration ->> 'billing_interval' = 'prepaid_term'
        THEN 'prepaid_term'
      WHEN COALESCE((v_workspace_configuration ->> 'usage_enabled')::boolean, false)
        THEN 'monthly_renewal_usage'
      ELSE 'monthly_subscription'
    END;
  END IF;

  NEW.billing_snapshot := jsonb_build_object(
    'version', 1,
    'source', 'workspace-payment-submission',
    'captured_at', COALESCE(NEW.created_at, now()),
    'billing_mode', v_billing_mode,
    'billing_workspace_id', NEW.billing_workspace_id,
    'workspace_id', NEW.workspace_id,
    'payment', jsonb_build_object(
      'id', NEW.id,
      'payment_type', NEW.payment_type,
      'provider', NEW.provider,
      'amount', NEW.amount::text,
      'currency', NEW.currency,
      'gb_added', NEW.gb_added::text,
      'gb_added_bytes', NEW.gb_added_bytes,
      'payg_cycle_id', NEW.payg_cycle_id,
      'billed_usage_bytes', NEW.billed_usage_bytes,
      'billed_usage_gb', NEW.billed_usage_gb::text
    ),
    'owner_configuration', v_owner_configuration,
    'workspace_configuration', v_workspace_configuration,
    'payg_cycle', v_payg_cycle
  );

  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_payment_capture_billing_snapshot
BEFORE INSERT ON billing.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION billing.capture_workspace_payment_billing_snapshot();

CREATE OR REPLACE FUNCTION billing.protect_workspace_payment_billing_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.billing_snapshot IS DISTINCT FROM OLD.billing_snapshot THEN
    RAISE EXCEPTION 'workspace_payment_billing_snapshot_is_immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_payment_billing_snapshot_immutable
BEFORE UPDATE OF billing_snapshot ON billing.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION billing.protect_workspace_payment_billing_snapshot();

CREATE OR REPLACE FUNCTION billing.validate_workspace_payment_billing_terms()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing
AS $function$
DECLARE
  v_snapshot_owner_terms jsonb;
  v_snapshot_workspace_terms jsonb;
  v_current_owner jsonb;
  v_current_workspace jsonb;
BEGIN
  IF OLD.status <> 'pending'
    OR NEW.status <> 'approved'
    OR NEW.user_id IS NULL
    OR NEW.provider NOT IN ('fib', 'qicard')
    OR NEW.billing_snapshot IS NULL THEN
    RETURN NEW;
  END IF;

  v_snapshot_owner_terms := billing.workspace_payment_configuration_terms(
    NEW.billing_snapshot -> 'owner_configuration'
  );
  v_snapshot_workspace_terms := billing.workspace_payment_configuration_terms(
    NEW.billing_snapshot -> 'workspace_configuration'
  );

  SELECT to_jsonb(configuration_row)
  INTO v_current_owner
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = NEW.billing_workspace_id;

  SELECT to_jsonb(configuration_row)
  INTO v_current_workspace
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = NEW.workspace_id;

  IF v_current_owner IS NULL
    OR v_snapshot_owner_terms IS DISTINCT FROM
      billing.workspace_payment_configuration_terms(v_current_owner)
    OR (
      NEW.workspace_id <> NEW.billing_workspace_id
      AND (
        v_current_workspace IS NULL
        OR v_snapshot_workspace_terms IS DISTINCT FROM
          billing.workspace_payment_configuration_terms(v_current_workspace)
      )
    ) THEN
    RAISE EXCEPTION 'workspace_payment_billing_terms_changed'
      USING ERRCODE = '23514',
        DETAIL = 'Billing terms changed after this payment was submitted. Reject it and ask the workspace to submit again.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_payment_validate_billing_terms
BEFORE UPDATE OF status ON billing.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION billing.validate_workspace_payment_billing_terms();

CREATE OR REPLACE FUNCTION billing.record_approved_workspace_payment_billing_operation(
  p_transaction_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_id uuid;
  v_payment billing.payment_transactions;
  v_owner_configuration billing.workspace_payment_configurations;
  v_workspace_configuration billing.workspace_payment_configurations;
  v_current_live billing.workspace_billing_live_transactions;
  v_existing billing.admin_billing_revisions;
  v_revision_id uuid := gen_random_uuid();
  v_voucher text;
  v_billing_mode text;
  v_snapshot jsonb;
  v_payment_snapshot jsonb;
  v_idempotency_key text;
  v_actor_label text;
  v_attempt integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;

  SELECT transaction_row.billing_workspace_id
  INTO v_owner_id
  FROM billing.payment_transactions AS transaction_row
  WHERE transaction_row.id = p_transaction_id;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'workspace_payment_transaction_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Keep the lock order used by submission, review, and manual Billing
  -- Operations so a payment approval cannot deadlock with a config change.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-branch-payment-owner:' || v_owner_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_owner_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-billing-live-owner:' || v_owner_id::text, 0));

  SELECT * INTO v_payment
  FROM billing.payment_transactions AS transaction_row
  WHERE transaction_row.id = p_transaction_id
  FOR UPDATE;

  IF v_payment.status <> 'approved'
    OR v_payment.user_id IS NULL
    OR v_payment.provider NOT IN ('fib', 'qicard') THEN
    RAISE EXCEPTION 'approved_workspace_payment_required'
      USING ERRCODE = '23514';
  END IF;

  v_idempotency_key := 'workspace-payment-approval:' || v_payment.id::text;
  SELECT * INTO v_existing
  FROM billing.admin_billing_revisions AS revision
  WHERE revision.billing_workspace_id = v_owner_id
    AND revision.idempotency_key = v_idempotency_key;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.payment_transaction_id IS DISTINCT FROM v_payment.id THEN
      RAISE EXCEPTION 'workspace_payment_billing_operation_idempotency_conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  PERFORM billing.ensure_workspace_billing_live_reference(v_owner_id);
  SELECT * INTO v_current_live
  FROM billing.workspace_billing_live_transactions AS live
  WHERE live.billing_workspace_id = v_owner_id
  FOR UPDATE;

  SELECT * INTO v_owner_configuration
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = v_owner_id
  FOR UPDATE;

  SELECT * INTO v_workspace_configuration
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = v_payment.workspace_id
  FOR UPDATE;

  v_billing_mode := CASE
    WHEN v_owner_configuration.id IS NULL THEN 'unconfigured'
    WHEN v_owner_configuration.payg_enabled THEN 'payg'
    WHEN v_owner_configuration.billing_interval = 'prepaid_term' THEN 'prepaid_term'
    WHEN v_owner_configuration.usage_enabled THEN 'monthly_renewal_usage'
    WHEN NOT v_owner_configuration.is_payment_enabled
      AND COALESCE(v_owner_configuration.subscription_amount, 0) = 0
      THEN 'unconfigured'
    ELSE 'monthly_subscription'
  END;
  v_actor_label := COALESCE(
    NULLIF(btrim(v_payment.reviewed_by_label), ''),
    'Workspace payment approval'
  );

  -- New requests have a server-captured snapshot. Keep older pending requests
  -- approvable after this migration while clearly marking their reconstructed
  -- configuration as captured at approval time.
  v_payment_snapshot := COALESCE(
    v_payment.billing_snapshot,
    jsonb_build_object(
      'version', 1,
      'source', 'legacy-payment-reconstructed-at-approval',
      'captured_at', NULL,
      'reconstructed_at', now(),
      'billing_mode', v_billing_mode,
      'billing_workspace_id', v_owner_id,
      'workspace_id', v_payment.workspace_id,
      'payment', billing.payment_transaction_public_json(v_payment),
      'owner_configuration', CASE
        WHEN v_owner_configuration.id IS NULL THEN NULL
        ELSE to_jsonb(v_owner_configuration)
      END,
      'workspace_configuration', CASE
        WHEN v_workspace_configuration.id IS NULL THEN NULL
        ELSE to_jsonb(v_workspace_configuration)
      END
    )
  );

  v_snapshot := jsonb_build_object(
    'configured', v_owner_configuration.id IS NOT NULL,
    'billing_mode', v_billing_mode,
    'subscription_amount', COALESCE(v_workspace_configuration.subscription_amount, 0)::text,
    'monthly_list_price', COALESCE(v_workspace_configuration.subscription_amount, 0)::text,
    'monthly_allowance_gb', COALESCE(
      v_workspace_configuration.monthly_allowance_gb,
      v_workspace_configuration.gb_per_payment,
      0
    )::text,
    'gb_per_payment', COALESCE(v_workspace_configuration.gb_per_payment, 0)::text,
    'currency', v_payment.currency,
    'is_payment_enabled', COALESCE(v_workspace_configuration.is_payment_enabled, false),
    'usage_enabled', COALESCE(v_workspace_configuration.usage_enabled, false),
    'payg_enabled', COALESCE(v_workspace_configuration.payg_enabled, false),
    'billing_interval', COALESCE(v_workspace_configuration.billing_interval, 'monthly'),
    'prepaid_allowance_mode', v_workspace_configuration.prepaid_allowance_mode,
    'term_allowance_gb', v_workspace_configuration.term_allowance_gb::text,
    'prepaid_cycles', v_workspace_configuration.prepaid_cycles,
    'prepaid_amount', v_workspace_configuration.prepaid_amount::text,
    'prepaid_term_started_at', v_workspace_configuration.prepaid_term_started_at,
    'usage_start_date', v_workspace_configuration.usage_start_date,
    'renewal_due_at', v_workspace_configuration.renewal_due_at,
    'payg_profile_id', v_workspace_configuration.payg_profile_id,
    'payment_amount', v_payment.amount::text,
    'record_payment', true,
    'payment_transaction_id', v_payment.id,
    'payment_type', v_payment.payment_type,
    'payment_provider', v_payment.provider,
    'account_holder_name', v_payment.account_holder_name,
    'payment_snapshot', v_payment_snapshot,
    'configuration', CASE
      WHEN v_owner_configuration.id IS NULL THEN NULL
      ELSE to_jsonb(v_owner_configuration)
    END,
    'workspace_configuration', CASE
      WHEN v_workspace_configuration.id IS NULL THEN NULL
      ELSE to_jsonb(v_workspace_configuration)
    END,
    'request_snapshot', v_payment_snapshot
  );

  IF v_payment.payment_type = 'payg' THEN
    v_snapshot := v_snapshot || jsonb_build_object(
      'payg_cycle_id', v_payment.payg_cycle_id,
      'billed_usage_bytes', v_payment.billed_usage_bytes,
      'billed_usage_gb', v_payment.billed_usage_gb::text,
      'payg_cycle', v_payment_snapshot -> 'payg_cycle'
    );
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    v_voucher := billing.generate_admin_billing_base_voucher();
    INSERT INTO billing.admin_billing_revisions (
      id, billing_workspace_id, requested_workspace_id, family_id,
      revision_number, base_voucher_code, voucher_code, revision_type,
      billing_mode, snapshot, payment_transaction_id, idempotency_key,
      created_by, created_by_label, created_via
    ) VALUES (
      v_revision_id, v_owner_id, v_payment.workspace_id, v_revision_id,
      0, v_voucher, v_voucher, 'create', v_billing_mode, v_snapshot,
      v_payment.id, v_idempotency_key, v_payment.reviewed_by,
      v_actor_label, 'workspace-payment-approval'
    ) ON CONFLICT DO NOTHING;

    IF FOUND THEN
      EXIT;
    END IF;

    SELECT * INTO v_existing
    FROM billing.admin_billing_revisions AS revision
    WHERE revision.billing_workspace_id = v_owner_id
      AND revision.idempotency_key = v_idempotency_key;
    IF v_existing.id IS NOT NULL THEN
      IF v_existing.payment_transaction_id IS DISTINCT FROM v_payment.id THEN
        RAISE EXCEPTION 'workspace_payment_billing_operation_idempotency_conflict'
          USING ERRCODE = '23505';
      END IF;
      RETURN v_existing.id;
    END IF;

    IF v_attempt >= 10 THEN
      RAISE EXCEPTION 'billing_voucher_generation_failed' USING ERRCODE = '23505';
    END IF;
  END LOOP;

  UPDATE billing.workspace_billing_live_transactions
  SET current_revision_id = v_revision_id,
      revision_version = revision_version + 1,
      updated_at = now(),
      updated_by_label = v_actor_label
  WHERE billing_workspace_id = v_owner_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_live_reference_missing' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_revision_id;
END;
$function$;

REVOKE ALL ON FUNCTION billing.workspace_payment_configuration_terms(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing.capture_workspace_payment_billing_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION billing.protect_workspace_payment_billing_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION billing.validate_workspace_payment_billing_terms()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION billing.record_approved_workspace_payment_billing_operation(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.record_approved_workspace_payment_billing_operation(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION billing.record_approved_workspace_payment_billing_operation_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing
AS $function$
BEGIN
  PERFORM billing.record_approved_workspace_payment_billing_operation(NEW.id);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION billing.record_approved_workspace_payment_billing_operation_trigger()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER workspace_payment_approved_billing_operation
AFTER UPDATE ON billing.payment_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.status = 'pending'
  AND NEW.status = 'approved'
  AND NEW.user_id IS NOT NULL
  AND NEW.provider IN ('fib', 'qicard')
)
EXECUTE FUNCTION billing.record_approved_workspace_payment_billing_operation_trigger();

-- PAYG review previously took only the family payment lock. Acquire the
-- branch-owner lock first as submission and configuration writes do, so the
-- deferred billing-operation trigger cannot invert the established lock order.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := replace(
    pg_get_functiondef(
      'public.admin_review_workspace_payment_transaction_v2(uuid,text,text,text,text)'::regprocedure
    ),
    E'\r\n', E'\n'
  );
  v_old := $old$
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_transaction.billing_workspace_id::text, 0));
$old$;
  v_new := $new$
  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-branch-payment-owner:' || v_transaction.billing_workspace_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_transaction.billing_workspace_id::text, 0));
$new$;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'payg_review_lock_order_not_found';
  END IF;

  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;
END;
$migration$;

COMMIT;
