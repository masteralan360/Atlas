BEGIN;

-- When an approved final PAYG payment applies a pending mode change, the owner
-- configuration is authoritative. Mirror its fully applied state to every
-- branch so old monthly subscription values cannot remain active afterward.
CREATE OR REPLACE FUNCTION public.admin_review_workspace_payment_transaction_v2(
  p_transaction_id uuid,
  p_decision text,
  p_note text,
  p_reviewer_label text,
  p_provider_payment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_transaction billing.payment_transactions;
  v_cycle billing.payg_cycles;
  v_config billing.workspace_payment_configurations;
  v_decision text := lower(btrim(COALESCE(p_decision, '')));
  v_next_due timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_transaction FROM billing.payment_transactions WHERE id = p_transaction_id;
  IF v_transaction.id IS NULL THEN
    RAISE EXCEPTION 'workspace_payment_transaction_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_transaction.payment_type <> 'payg' THEN
    RETURN public.admin_review_workspace_payment_transaction(
      p_transaction_id, p_decision, p_note, p_reviewer_label, p_provider_payment_id
    );
  END IF;
  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_workspace_payment_review_decision' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_transaction.billing_workspace_id::text, 0));
  SELECT * INTO v_transaction FROM billing.payment_transactions WHERE id = p_transaction_id FOR UPDATE;
  IF v_transaction.status <> 'pending' OR v_transaction.expires_at <= now() THEN
    RAISE EXCEPTION 'workspace_payment_no_longer_pending' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_cycle FROM billing.payg_cycles WHERE id = v_transaction.payg_cycle_id FOR UPDATE;
  IF v_cycle.status <> 'awaiting_payment'
    OR v_transaction.amount <> v_cycle.amount_iqd
    OR v_transaction.billed_usage_bytes <> v_cycle.charged_usage_bytes THEN
    RAISE EXCEPTION 'payg_payment_snapshot_mismatch' USING ERRCODE = '23514';
  END IF;
  UPDATE billing.payment_transactions SET
    status = v_decision,
    paid_at = CASE WHEN v_decision = 'approved' THEN now() ELSE NULL END,
    reviewed_at = now(), reviewed_by = auth.uid(),
    reviewed_by_label = COALESCE(NULLIF(btrim(p_reviewer_label), ''), 'Platform administrator'),
    reviewed_via = 'admin-console', review_note = NULLIF(btrim(p_note), ''),
    provider_payment_id = NULLIF(btrim(p_provider_payment_id), '')
  WHERE id = v_transaction.id RETURNING * INTO v_transaction;
  IF v_decision = 'rejected' THEN
    UPDATE billing.payg_cycles SET payment_transaction_id = NULL, updated_at = now() WHERE id = v_cycle.id;
    RETURN billing.payment_transaction_public_json(v_transaction) || jsonb_build_object('success', true);
  END IF;

  UPDATE billing.payg_cycles SET status = 'paid', settled_at = now(), updated_at = now() WHERE id = v_cycle.id;
  UPDATE public.workspace_usage SET data_transfer_bytes = 0, updated_at = now()
  WHERE workspace_id = v_transaction.billing_workspace_id;
  PERFORM set_config('atlas.trusted_workspace_lock_update', 'on', true);
  UPDATE public.workspaces SET
    locked_workspace = false,
    payment_renewal_locked = false,
    usage_limit_locked = false,
    subscription_expiry_locked = false
  WHERE id = v_transaction.billing_workspace_id;
  SELECT * INTO v_config FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_transaction.billing_workspace_id FOR UPDATE;
  v_next_due := billing.next_workspace_usage_renewal_due(
    v_transaction.billing_workspace_id, GREATEST(v_cycle.renewal_due_at, now())
  );
  IF v_config.pending_billing_mode IS NULL THEN
    UPDATE billing.workspace_payment_configurations SET
      renewal_due_at = v_next_due, payg_cycle_started_at = now(), updated_at = now()
    WHERE workspace_id = v_transaction.billing_workspace_id;
    PERFORM billing.start_payg_cycle(v_transaction.billing_workspace_id, now(), v_next_due);
  ELSE
    PERFORM set_config('atlas.trusted_workspace_payment_family_mode_update', 'on', true);
    UPDATE billing.workspace_payment_configurations SET
      payg_enabled = false,
      usage_enabled = pending_billing_mode = 'prepaid_usage' AND NOT pending_billing_termination,
      subscription_amount = CASE WHEN pending_billing_termination THEN 0 ELSE pending_subscription_amount END,
      gb_per_payment = CASE
        WHEN pending_billing_mode = 'prepaid_usage' AND NOT pending_billing_termination
          THEN pending_gb_per_payment
        ELSE 0
      END,
      is_payment_enabled = CASE WHEN pending_billing_termination THEN false ELSE pending_payment_enabled END,
      pending_billing_mode = NULL,
      pending_subscription_amount = NULL,
      pending_gb_per_payment = NULL,
      pending_payment_enabled = NULL,
      pending_renewal_due_at = NULL,
      pending_usage_start_date = NULL,
      payg_cycle_started_at = NULL,
      payg_profile_id = NULL,
      renewal_due_at = CASE
        WHEN pending_billing_termination THEN NULL
        WHEN pending_billing_mode = 'prepaid_usage' THEN v_next_due
        ELSE COALESCE(pending_renewal_due_at, renewal_due_at)
      END,
      usage_start_date = CASE
        WHEN pending_billing_termination THEN NULL
        WHEN pending_billing_mode = 'prepaid_usage'
          THEN COALESCE(pending_usage_start_date, usage_start_date, now()::date)
        ELSE NULL
      END,
      updated_at = now()
    WHERE workspace_id = v_transaction.billing_workspace_id;

    -- Copy the post-settlement source values, including payment enablement and
    -- price, rather than only flipping the branches' PAYG/usage flags.
    UPDATE billing.workspace_payment_configurations AS family_config
    SET
      subscription_amount = owner_config.subscription_amount,
      currency = owner_config.currency,
      is_payment_enabled = owner_config.is_payment_enabled,
      usage_enabled = owner_config.usage_enabled,
      payg_enabled = owner_config.payg_enabled,
      gb_per_payment = owner_config.gb_per_payment,
      renewal_due_at = owner_config.renewal_due_at,
      usage_start_date = owner_config.usage_start_date,
      billing_interval = owner_config.billing_interval,
      monthly_allowance_gb = owner_config.monthly_allowance_gb,
      prepaid_cycles = owner_config.prepaid_cycles,
      prepaid_amount = owner_config.prepaid_amount,
      prepaid_term_started_at = owner_config.prepaid_term_started_at,
      prepaid_term_payment_transaction_id = owner_config.prepaid_term_payment_transaction_id,
      prepaid_allowance_mode = owner_config.prepaid_allowance_mode,
      term_allowance_gb = owner_config.term_allowance_gb,
      payg_profile_id = owner_config.payg_profile_id,
      payg_cycle_started_at = owner_config.payg_cycle_started_at,
      pending_billing_mode = owner_config.pending_billing_mode,
      pending_billing_termination = owner_config.pending_billing_termination,
      pending_subscription_amount = owner_config.pending_subscription_amount,
      pending_gb_per_payment = owner_config.pending_gb_per_payment,
      pending_payment_enabled = owner_config.pending_payment_enabled,
      pending_renewal_due_at = owner_config.pending_renewal_due_at,
      pending_usage_start_date = owner_config.pending_usage_start_date,
      updated_by = owner_config.updated_by,
      updated_by_label = owner_config.updated_by_label,
      updated_via = 'admin-console-family-mode',
      updated_at = now()
    FROM billing.workspace_payment_configurations AS owner_config
    WHERE owner_config.workspace_id = v_transaction.billing_workspace_id
      AND family_config.workspace_id <> owner_config.workspace_id
      AND public.workspace_usage_owner_id(family_config.workspace_id) = owner_config.workspace_id;

    UPDATE public.workspace_usage_limits SET
      tracking_only = false,
      monthly_data_transfer_limit_bytes = COALESCE(monthly_data_transfer_limit_bytes, 0),
      updated_at = now()
    WHERE workspace_id = v_transaction.billing_workspace_id
      AND v_config.pending_billing_mode = 'prepaid_usage'
      AND NOT v_config.pending_billing_termination;
    DELETE FROM public.workspace_usage_limits
    WHERE workspace_id = v_transaction.billing_workspace_id
      AND (v_config.pending_billing_mode = 'monthly' OR v_config.pending_billing_termination)
      AND tracking_only
      AND storage_unit_limit IS NULL
      AND monthly_data_transfer_limit_bytes IS NULL;
  END IF;
  RETURN billing.payment_transaction_public_json(v_transaction) || jsonb_build_object(
    'success', true, 'renewal_due_at', v_next_due, 'payg_reset', true
  );
END;
$function$;

-- Repair any already-settled final PAYG family where the owner is inactive
-- but branches retained an active monthly subscription.
DO $migration$
BEGIN
  PERFORM set_config('atlas.trusted_workspace_payment_family_mode_update', 'on', true);
  UPDATE billing.workspace_payment_configurations AS family_config
  SET
    subscription_amount = owner_config.subscription_amount,
    currency = owner_config.currency,
    is_payment_enabled = owner_config.is_payment_enabled,
    usage_enabled = owner_config.usage_enabled,
    payg_enabled = owner_config.payg_enabled,
    gb_per_payment = owner_config.gb_per_payment,
    renewal_due_at = owner_config.renewal_due_at,
    usage_start_date = owner_config.usage_start_date,
    billing_interval = owner_config.billing_interval,
    monthly_allowance_gb = owner_config.monthly_allowance_gb,
    prepaid_cycles = owner_config.prepaid_cycles,
    prepaid_amount = owner_config.prepaid_amount,
    prepaid_term_started_at = owner_config.prepaid_term_started_at,
    prepaid_term_payment_transaction_id = owner_config.prepaid_term_payment_transaction_id,
    prepaid_allowance_mode = owner_config.prepaid_allowance_mode,
    term_allowance_gb = owner_config.term_allowance_gb,
    payg_profile_id = owner_config.payg_profile_id,
    payg_cycle_started_at = owner_config.payg_cycle_started_at,
    pending_billing_mode = owner_config.pending_billing_mode,
    pending_billing_termination = owner_config.pending_billing_termination,
    pending_subscription_amount = owner_config.pending_subscription_amount,
    pending_gb_per_payment = owner_config.pending_gb_per_payment,
    pending_payment_enabled = owner_config.pending_payment_enabled,
    pending_renewal_due_at = owner_config.pending_renewal_due_at,
    pending_usage_start_date = owner_config.pending_usage_start_date,
    updated_by = owner_config.updated_by,
    updated_by_label = owner_config.updated_by_label,
    updated_via = 'admin-console-family-mode',
    updated_at = now()
  FROM billing.workspace_payment_configurations AS owner_config
  WHERE family_config.workspace_id <> owner_config.workspace_id
    AND public.workspace_usage_owner_id(family_config.workspace_id) = owner_config.workspace_id
    AND owner_config.payg_enabled = false
    AND owner_config.usage_enabled = false
    AND owner_config.is_payment_enabled = false
    AND owner_config.subscription_amount = 0
    AND owner_config.pending_billing_mode IS NULL
    AND EXISTS (
      SELECT 1
      FROM billing.payg_cycles AS cycle
      JOIN billing.payment_transactions AS payment
        ON payment.id = cycle.payment_transaction_id
      WHERE cycle.billing_workspace_id = owner_config.workspace_id
        AND cycle.status = 'paid'
        AND payment.payment_type = 'payg'
        AND payment.status = 'approved'
        AND payment.paid_at >= owner_config.updated_at - interval '1 second'
    )
    AND (
      family_config.subscription_amount IS DISTINCT FROM owner_config.subscription_amount
      OR family_config.is_payment_enabled IS DISTINCT FROM owner_config.is_payment_enabled
      OR family_config.usage_enabled IS DISTINCT FROM owner_config.usage_enabled
      OR family_config.payg_enabled IS DISTINCT FROM owner_config.payg_enabled
    );
END;
$migration$;

COMMIT;
