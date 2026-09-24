-- Allow an administrator to correct the current manual prepaid term in place.
-- The original payment ID and paid_at remain stable; every correction is audited.
CREATE TABLE billing.prepaid_term_replacement_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL,
  billing_workspace_id uuid NOT NULL,
  old_record jsonb NOT NULL,
  new_record jsonb NOT NULL,
  changed_by uuid,
  changed_by_label text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prepaid_term_replacement_audit_transaction_idx
  ON billing.prepaid_term_replacement_audit (transaction_id, changed_at DESC);
ALTER TABLE billing.prepaid_term_replacement_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing.prepaid_term_replacement_audit FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION billing.enforce_payment_transaction_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'billing'
AS $function$
BEGIN
  IF current_setting('atlas.trusted_prepaid_term_replacement', true) = 'on'
    AND auth.role() = 'service_role'
    AND OLD.payment_type = 'prepaid_term'
    AND OLD.status = 'approved'
    AND NEW.status = 'approved'
    AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
    AND NEW.billing_workspace_id IS NOT DISTINCT FROM OLD.billing_workspace_id
    AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
    AND NEW.submitted_by_name IS NOT DISTINCT FROM OLD.submitted_by_name
    AND NEW.submitted_by_email IS NOT DISTINCT FROM OLD.submitted_by_email
    AND NEW.account_holder_name IS NOT DISTINCT FROM OLD.account_holder_name
    AND NEW.provider IS NOT DISTINCT FROM OLD.provider
    AND NEW.provider_payment_id IS NOT DISTINCT FROM OLD.provider_payment_id
    AND NEW.provider_response IS NOT DISTINCT FROM OLD.provider_response
    AND NEW.payment_type IS NOT DISTINCT FROM OLD.payment_type
    AND NEW.currency IS NOT DISTINCT FROM OLD.currency
    AND NEW.gb_added IS NOT DISTINCT FROM OLD.gb_added
    AND NEW.gb_added_bytes IS NOT DISTINCT FROM OLD.gb_added_bytes
    AND NEW.payg_cycle_id IS NOT DISTINCT FROM OLD.payg_cycle_id
    AND NEW.billed_usage_bytes IS NOT DISTINCT FROM OLD.billed_usage_bytes
    AND NEW.billed_usage_gb IS NOT DISTINCT FROM OLD.billed_usage_gb
    AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NEW.paid_at IS NOT DISTINCT FROM OLD.paid_at
    AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
    AND NEW.reviewed_by_label IS NOT DISTINCT FROM OLD.reviewed_by_label
    AND NEW.reviewed_via IS NOT DISTINCT FROM OLD.reviewed_via
    AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
    AND NEW.review_note IS NOT DISTINCT FROM OLD.review_note THEN
    RETURN NEW;
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.billing_workspace_id IS DISTINCT FROM OLD.billing_workspace_id
    OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NOT (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL))
    OR NEW.submitted_by_name IS DISTINCT FROM OLD.submitted_by_name
    OR NEW.submitted_by_email IS DISTINCT FROM OLD.submitted_by_email
    OR NEW.account_holder_name IS DISTINCT FROM OLD.account_holder_name
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
    OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.gb_added IS DISTINCT FROM OLD.gb_added OR NEW.gb_added_bytes IS DISTINCT FROM OLD.gb_added_bytes
    OR NEW.payg_cycle_id IS DISTINCT FROM OLD.payg_cycle_id
    OR NEW.billed_usage_bytes IS DISTINCT FROM OLD.billed_usage_bytes
    OR NEW.billed_usage_gb IS DISTINCT FROM OLD.billed_usage_gb
    OR NEW.monthly_list_price IS DISTINCT FROM OLD.monthly_list_price
    OR NEW.monthly_allowance_gb IS DISTINCT FROM OLD.monthly_allowance_gb
    OR NEW.prepaid_cycles IS DISTINCT FROM OLD.prepaid_cycles
    OR NEW.prepaid_allowance_mode IS DISTINCT FROM OLD.prepaid_allowance_mode
    OR NEW.term_allowance_gb IS DISTINCT FROM OLD.term_allowance_gb
    OR NEW.term_started_at IS DISTINCT FROM OLD.term_started_at
    OR NEW.term_paid_through_at IS DISTINCT FROM OLD.term_paid_through_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'workspace_payment_transaction_snapshot_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected', 'expired') THEN
      RAISE EXCEPTION 'invalid_workspace_payment_status_transition' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'pending' AND (
    NEW.paid_at IS DISTINCT FROM OLD.paid_at OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
    OR NEW.reviewed_by_label IS DISTINCT FROM OLD.reviewed_by_label OR NEW.reviewed_via IS DISTINCT FROM OLD.reviewed_via
    OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_note IS DISTINCT FROM OLD.review_note
    OR NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id OR NEW.provider_response IS DISTINCT FROM OLD.provider_response
  ) THEN
    RAISE EXCEPTION 'reviewed_workspace_payment_transaction_is_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_activate_workspace_prepaid_term_v3(
  p_workspace_id uuid,
  p_monthly_list_price text,
  p_monthly_allowance_gb text,
  p_prepaid_cycles integer,
  p_amount_paid text,
  p_term_started_at text,
  p_prepaid_allowance_mode text,
  p_replace_existing_term boolean,
  p_expected_transaction_id uuid,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'billing'
AS $function$
DECLARE
  v_owner_id uuid;
  v_config billing.workspace_payment_configurations;
  v_existing billing.payment_transactions;
  v_updated billing.payment_transactions;
  v_start date;
  v_end timestamptz;
  v_old_record jsonb;
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;

  IF p_replace_existing_term IS NOT TRUE THEN
    RETURN public.admin_activate_workspace_prepaid_term_v2(
      p_workspace_id, p_monthly_list_price, p_monthly_allowance_gb,
      p_prepaid_cycles, p_amount_paid, p_term_started_at,
      p_prepaid_allowance_mode, p_actor
    );
  END IF;

  IF p_expected_transaction_id IS NULL THEN
    RAISE EXCEPTION 'prepaid_term_replacement_requires_current_term' USING ERRCODE = '22023';
  END IF;
  IF p_prepaid_cycles IS NULL OR p_prepaid_cycles NOT BETWEEN 1 AND 120
    OR btrim(COALESCE(p_term_started_at, '')) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid_prepaid_term_configuration' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_start := btrim(p_term_started_at)::date;
    v_end := billing.prepaid_term_paid_through(v_start, p_prepaid_cycles);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_prepaid_term_configuration' USING ERRCODE = '22023';
  END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-branch-payment-owner:' || p_workspace_id::text, 0)
  );
  v_owner_id := public.workspace_usage_owner_id(p_workspace_id);
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_workspace_id <> v_owner_id THEN
    RAISE EXCEPTION 'prepaid_term_is_managed_by_source_workspace' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_owner_id::text, 0));

  SELECT * INTO v_config
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_owner_id
  FOR UPDATE;
  IF v_config.billing_interval IS DISTINCT FROM 'prepaid_term'
    OR v_config.prepaid_term_payment_transaction_id IS DISTINCT FROM p_expected_transaction_id THEN
    RAISE EXCEPTION 'prepaid_term_replacement_stale' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing
  FROM billing.payment_transactions
  WHERE id = p_expected_transaction_id
    AND billing_workspace_id = v_owner_id
    AND payment_type = 'prepaid_term'
    AND status = 'approved'
  FOR UPDATE;
  IF v_existing.id IS NULL THEN
    RAISE EXCEPTION 'prepaid_term_replacement_stale' USING ERRCODE = '23514';
  END IF;
  IF v_existing.provider <> 'manual' OR v_existing.reviewed_via <> 'admin-console' THEN
    RAISE EXCEPTION 'prepaid_term_replacement_requires_manual_payment' USING ERRCODE = '23514';
  END IF;
  IF v_existing.term_started_at >= (v_end AT TIME ZONE 'UTC')::date
    OR v_existing.term_paid_through_at <= (v_start::timestamp AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'prepaid_term_replacement_requires_overlap' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM billing.payment_transactions
    WHERE billing_workspace_id = v_owner_id
      AND id <> v_existing.id
      AND payment_type = 'prepaid_term'
      AND status = 'approved'
      AND term_started_at < (v_end AT TIME ZONE 'UTC')::date
      AND term_paid_through_at > (v_start::timestamp AT TIME ZONE 'UTC')
  ) THEN
    RAISE EXCEPTION 'prepaid_term_overlaps_other_approved_term' USING ERRCODE = '23514';
  END IF;

  IF v_existing.monthly_list_price = btrim(p_monthly_list_price)::numeric
    AND v_existing.monthly_allowance_gb = btrim(p_monthly_allowance_gb)::numeric
    AND v_existing.prepaid_cycles = p_prepaid_cycles
    AND v_existing.amount = btrim(p_amount_paid)::numeric
    AND v_existing.term_started_at = v_start
    AND v_existing.term_paid_through_at = v_end
    AND v_existing.prepaid_allowance_mode = lower(btrim(p_prepaid_allowance_mode)) THEN
    RETURN public.admin_activate_workspace_prepaid_term_v2(
      p_workspace_id, p_monthly_list_price, p_monthly_allowance_gb,
      p_prepaid_cycles, p_amount_paid, p_term_started_at,
      p_prepaid_allowance_mode, p_actor
    );
  END IF;

  v_old_record := to_jsonb(v_existing);
  PERFORM set_config('atlas.trusted_prepaid_term_replacement', 'on', true);
  UPDATE billing.payment_transactions
  SET amount = btrim(p_amount_paid)::numeric,
    monthly_list_price = btrim(p_monthly_list_price)::numeric,
    monthly_allowance_gb = btrim(p_monthly_allowance_gb)::numeric,
    prepaid_cycles = p_prepaid_cycles,
    prepaid_allowance_mode = lower(btrim(p_prepaid_allowance_mode)),
    term_allowance_gb = btrim(p_monthly_allowance_gb)::numeric * p_prepaid_cycles,
    term_started_at = v_start,
    term_paid_through_at = v_end
  WHERE id = v_existing.id
  RETURNING * INTO v_updated;
  PERFORM set_config('atlas.trusted_prepaid_term_replacement', 'off', true);

  INSERT INTO billing.prepaid_term_replacement_audit (
    transaction_id, billing_workspace_id, old_record, new_record,
    changed_by, changed_by_label
  ) VALUES (
    v_existing.id, v_owner_id, v_old_record, to_jsonb(v_updated),
    auth.uid(), COALESCE(NULLIF(btrim(p_actor), ''), 'Platform administrator')
  );

  -- The existing prepaid metadata may be incompatible with the replacement
  -- price or allowance during the base configuration update.
  PERFORM set_config('atlas.trusted_workspace_payment_family_mode_update', 'on', true);
  UPDATE billing.workspace_payment_configurations AS configuration_row
  SET billing_interval = 'monthly',
    monthly_allowance_gb = NULL,
    prepaid_cycles = NULL,
    prepaid_amount = NULL,
    prepaid_term_started_at = NULL,
    prepaid_term_payment_transaction_id = NULL,
    prepaid_allowance_mode = NULL,
    term_allowance_gb = NULL,
    updated_at = now()
  WHERE public.workspace_usage_owner_id(configuration_row.workspace_id) = v_owner_id
    AND configuration_row.billing_interval = 'prepaid_term';

  v_result := public.admin_activate_workspace_prepaid_term_v2(
    p_workspace_id, p_monthly_list_price, p_monthly_allowance_gb,
    p_prepaid_cycles, p_amount_paid, p_term_started_at,
    p_prepaid_allowance_mode, p_actor
  );
  RETURN v_result || jsonb_build_object('replaced', true, 'idempotent', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_activate_workspace_prepaid_term_v3(
  uuid, text, text, integer, text, text, text, boolean, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_activate_workspace_prepaid_term_v3(
  uuid, text, text, integer, text, text, text, boolean, uuid, text
) TO service_role;
