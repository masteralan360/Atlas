BEGIN;

-- The payment submission wrapper captures the account-holder name after the
-- base RPC creates its pending row. Permit that one trusted, first-time field
-- capture without making any of the financial snapshot fields mutable.
CREATE OR REPLACE FUNCTION billing.enforce_payment_transaction_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing
AS $function$
DECLARE
  v_trusted_account_holder_capture boolean :=
    current_setting('atlas.trusted_workspace_payment_account_holder_update', true) = 'on'
    AND OLD.status = 'pending'
    AND NEW.status = 'pending'
    AND OLD.account_holder_name IS NULL
    AND NEW.account_holder_name IS NOT NULL
    AND NEW.account_holder_name = upper(
      btrim(regexp_replace(NEW.account_holder_name, '[[:space:]]+', ' ', 'g'))
    )
    AND char_length(NEW.account_holder_name) <= 160
    AND cardinality(string_to_array(NEW.account_holder_name, ' ')) >= 3;
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

  IF NEW.account_holder_name IS DISTINCT FROM OLD.account_holder_name
    AND NOT v_trusted_account_holder_capture THEN
    RAISE EXCEPTION 'workspace_payment_transaction_snapshot_is_immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.billing_workspace_id IS DISTINCT FROM OLD.billing_workspace_id
    OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NOT (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL))
    OR NEW.submitted_by_name IS DISTINCT FROM OLD.submitted_by_name
    OR NEW.submitted_by_email IS DISTINCT FROM OLD.submitted_by_email
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.gb_added IS DISTINCT FROM OLD.gb_added
    OR NEW.gb_added_bytes IS DISTINCT FROM OLD.gb_added_bytes
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
    RAISE EXCEPTION 'workspace_payment_transaction_snapshot_is_immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending'
      OR NEW.status NOT IN ('approved', 'rejected', 'expired') THEN
      RAISE EXCEPTION 'invalid_workspace_payment_status_transition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'pending' AND (
    NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
    OR NEW.reviewed_by_label IS DISTINCT FROM OLD.reviewed_by_label
    OR NEW.reviewed_via IS DISTINCT FROM OLD.reviewed_via
    OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
    OR NEW.review_note IS DISTINCT FROM OLD.review_note
    OR NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
    OR NEW.provider_response IS DISTINCT FROM OLD.provider_response
  ) THEN
    RAISE EXCEPTION 'reviewed_workspace_payment_transaction_is_immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_workspace_payment_base(
  p_provider text,
  p_account_holder_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing, auth
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_provider text := lower(btrim(COALESCE(p_provider, '')));
  v_account_holder_name text := upper(
    btrim(regexp_replace(COALESCE(p_account_holder_name, ''), '[[:space:]]+', ' ', 'g'))
  );
  v_result jsonb;
  v_transaction_id uuid;
  v_stored_account_holder_name text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'workspace_authentication_required' USING ERRCODE = '42501';
  END IF;

  IF v_provider NOT IN ('fib', 'qicard', 'free') THEN
    RAISE EXCEPTION 'unsupported_workspace_payment_provider' USING ERRCODE = '22023';
  END IF;

  IF v_provider <> 'free' AND v_account_holder_name = '' THEN
    RAISE EXCEPTION 'account_holder_name_required' USING ERRCODE = '22023';
  END IF;

  IF v_provider <> 'free'
    AND cardinality(string_to_array(v_account_holder_name, ' ')) < 3 THEN
    RAISE EXCEPTION 'account_holder_name_must_have_three_words' USING ERRCODE = '22023';
  END IF;

  IF v_provider <> 'free' AND char_length(v_account_holder_name) > 160 THEN
    RAISE EXCEPTION 'account_holder_name_too_long' USING ERRCODE = '22023';
  END IF;

  v_result := public.submit_workspace_payment(v_provider);

  IF v_provider = 'free' THEN
    RETURN v_result || jsonb_build_object('account_holder_name', NULL);
  END IF;

  v_transaction_id := NULLIF(v_result ->> 'id', '')::uuid;
  IF v_transaction_id IS NULL THEN
    RAISE EXCEPTION 'workspace_payment_transaction_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT transaction_row.account_holder_name
  INTO v_stored_account_holder_name
  FROM billing.payment_transactions AS transaction_row
  WHERE transaction_row.id = v_transaction_id
    AND transaction_row.user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_payment_transaction_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_stored_account_holder_name IS NULL THEN
    PERFORM set_config('atlas.trusted_workspace_payment_account_holder_update', 'on', true);
    UPDATE billing.payment_transactions
    SET account_holder_name = v_account_holder_name
    WHERE id = v_transaction_id
    RETURNING account_holder_name INTO v_stored_account_holder_name;
    PERFORM set_config('atlas.trusted_workspace_payment_account_holder_update', 'off', true);
  END IF;

  RETURN v_result || jsonb_build_object('account_holder_name', v_stored_account_holder_name);
END;
$function$;

COMMIT;
