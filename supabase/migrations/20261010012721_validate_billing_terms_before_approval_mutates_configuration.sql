BEGIN;

-- Validate the request against the configuration before the existing review
-- routine advances its billing dates. The status trigger then trusts only
-- this transaction-local validation result for that approval.
CREATE OR REPLACE FUNCTION billing.assert_workspace_payment_billing_terms(
  p_transaction_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing
AS $function$
DECLARE
  v_payment billing.payment_transactions;
  v_snapshot_owner_terms jsonb;
  v_snapshot_workspace_terms jsonb;
  v_current_owner jsonb;
  v_current_workspace jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_payment
  FROM billing.payment_transactions AS transaction_row
  WHERE transaction_row.id = p_transaction_id
  FOR UPDATE;

  IF v_payment.id IS NULL
    OR v_payment.status <> 'pending'
    OR (v_payment.expires_at IS NOT NULL AND v_payment.expires_at < now())
    OR v_payment.user_id IS NULL
    OR v_payment.provider NOT IN ('fib', 'qicard')
    OR v_payment.billing_snapshot IS NULL THEN
    RETURN;
  END IF;

  v_snapshot_owner_terms := billing.workspace_payment_configuration_terms(
    v_payment.billing_snapshot -> 'owner_configuration'
  );
  v_snapshot_workspace_terms := billing.workspace_payment_configuration_terms(
    v_payment.billing_snapshot -> 'workspace_configuration'
  );

  SELECT to_jsonb(configuration_row)
  INTO v_current_owner
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = v_payment.billing_workspace_id
  FOR UPDATE;

  SELECT to_jsonb(configuration_row)
  INTO v_current_workspace
  FROM billing.workspace_payment_configurations AS configuration_row
  WHERE configuration_row.workspace_id = v_payment.workspace_id
  FOR UPDATE;

  IF v_current_owner IS NULL
    OR v_snapshot_owner_terms IS DISTINCT FROM
      billing.workspace_payment_configuration_terms(v_current_owner)
    OR (
      v_payment.workspace_id <> v_payment.billing_workspace_id
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
END;
$function$;

REVOKE ALL ON FUNCTION billing.assert_workspace_payment_billing_terms(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.assert_workspace_payment_billing_terms(uuid)
  TO service_role;

-- The legacy review routine updates renewal_due_at and usage_start_date before
-- it changes the payment status. Skip the trigger's second comparison only
-- when the review wrapper has already performed the comparison above.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := replace(
    pg_get_functiondef(
      'billing.validate_workspace_payment_billing_terms()'::regprocedure
    ),
    E'\r\n', E'\n'
  );

  v_old := $old$
BEGIN
  IF OLD.status <> 'pending'
    OR NEW.status <> 'approved'
$old$;
  v_new := $new$
BEGIN
  IF current_setting('atlas.workspace_payment_billing_terms_validated', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending'
    OR NEW.status <> 'approved'
$new$;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'workspace_payment_billing_terms_validator_anchor_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;
END;
$migration$;

-- Preserve the established lock order and approval behavior while validating
-- terms before the base routine makes its normal renewal-date updates.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  v_definition := replace(
    pg_get_functiondef(
      'public.admin_review_workspace_payment_transaction(uuid,text,text,text,text)'::regprocedure
    ),
    E'\r\n', E'\n'
  );

  v_old := $old$
  v_result := public.admin_review_workspace_payment_transaction_base(
$old$;
  v_new := $new$
  IF v_decision = 'approved' THEN
    PERFORM billing.assert_workspace_payment_billing_terms(p_transaction_id);
    PERFORM set_config('atlas.workspace_payment_billing_terms_validated', 'on', true);
  END IF;

  v_result := public.admin_review_workspace_payment_transaction_base(
$new$;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'workspace_payment_review_validation_anchor_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$
    p_provider_payment_id
  );

  IF v_decision <> 'approved' THEN
$old$;
  v_new := $new$
    p_provider_payment_id
  );

  PERFORM set_config('atlas.workspace_payment_billing_terms_validated', 'off', true);

  IF v_decision <> 'approved' THEN
$new$;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'workspace_payment_review_validation_cleanup_anchor_not_found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;
END;
$migration$;

COMMIT;
