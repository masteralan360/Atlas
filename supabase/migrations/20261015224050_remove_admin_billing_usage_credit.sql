-- Remove the duplicate 15 GB usage credit granted by the legacy Admin Billing
-- Operations approval path for these workspaces. Preserve their payment rows,
-- configured monthly allowance, and metered usage; record the payment effect in
-- the metadata-only audit table.
DO $reconcile_admin_billing_usage_credit$
DECLARE
  v_target record;
  v_workspace_id uuid;
  v_workspace_count integer;
  v_payment_count integer;
  v_transaction billing.payment_transactions%ROWTYPE;
  v_transfer_period_start date;
  v_monthly_limit_bytes bigint;
  v_purchased_credit_bytes bigint;
BEGIN
  FOR v_target IN
    SELECT target_values.workspace_code,
           target_values.usage_start_date,
           target_values.payment_amount,
           target_values.credit_bytes
    FROM (VALUES
      ('HBKB-K8UH', DATE '2026-10-12', 10000::numeric, 15000000000::bigint),
      ('W6AM-XKHA', DATE '2026-10-14', 35000::numeric, 15000000000::bigint)
    ) AS target_values(workspace_code, usage_start_date, payment_amount, credit_bytes)
  LOOP
    SELECT count(*)::integer
    INTO v_workspace_count
    FROM public.workspaces AS workspace_row
    WHERE workspace_row.code = v_target.workspace_code
      AND workspace_row.id = public.workspace_usage_owner_id(workspace_row.id)
      AND workspace_row.deleted_at IS NULL;

    IF v_workspace_count <> 1 THEN
      RAISE EXCEPTION 'admin_billing_usage_workspace_not_unique: %', v_target.workspace_code;
    END IF;

    SELECT workspace_row.id
    INTO v_workspace_id
    FROM public.workspaces AS workspace_row
    WHERE workspace_row.code = v_target.workspace_code
      AND workspace_row.id = public.workspace_usage_owner_id(workspace_row.id)
      AND workspace_row.deleted_at IS NULL;

    SELECT count(*)::integer
    INTO v_payment_count
    FROM billing.payment_transactions AS payment_row
    WHERE payment_row.billing_workspace_id = v_workspace_id
      AND payment_row.status = 'approved'
      AND payment_row.payment_type = 'usage'
      AND payment_row.provider = 'manual'
      AND payment_row.currency = 'IQD'
      AND payment_row.amount = v_target.payment_amount
      AND payment_row.gb_added_bytes = v_target.credit_bytes
      AND payment_row.provider_response ->> 'source' = 'admin-billing-operations'
      AND payment_row.provider_response ->> 'usage_start_date' = v_target.usage_start_date::text;

    IF v_payment_count <> 1 THEN
      RAISE EXCEPTION 'admin_billing_usage_payment_not_unique: %', v_target.workspace_code;
    END IF;

    SELECT payment_row.*
    INTO v_transaction
    FROM billing.payment_transactions AS payment_row
    WHERE payment_row.billing_workspace_id = v_workspace_id
      AND payment_row.status = 'approved'
      AND payment_row.payment_type = 'usage'
      AND payment_row.provider = 'manual'
      AND payment_row.currency = 'IQD'
      AND payment_row.amount = v_target.payment_amount
      AND payment_row.gb_added_bytes = v_target.credit_bytes
      AND payment_row.provider_response ->> 'source' = 'admin-billing-operations'
      AND payment_row.provider_response ->> 'usage_start_date' = v_target.usage_start_date::text
    FOR UPDATE OF payment_row;

    SELECT usage_row.transfer_period_start,
           usage_row.purchased_credit_bytes,
           limits_row.monthly_data_transfer_limit_bytes
    INTO v_transfer_period_start,
         v_purchased_credit_bytes,
         v_monthly_limit_bytes
    FROM public.workspace_usage AS usage_row
    JOIN public.workspace_usage_limits AS limits_row
      ON limits_row.workspace_id = usage_row.workspace_id
    WHERE usage_row.workspace_id = v_workspace_id
    FOR UPDATE OF usage_row;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'admin_billing_usage_row_missing: %', v_target.workspace_code;
    END IF;

    IF v_transfer_period_start <> v_target.usage_start_date
      OR v_monthly_limit_bytes <> 15000000000
      OR v_purchased_credit_bytes <> v_transaction.gb_added_bytes THEN
      RAISE EXCEPTION 'admin_billing_usage_credit_state_changed: %', v_target.workspace_code;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM billing.admin_payment_entitlement_metadata AS effect_metadata
      WHERE effect_metadata.payment_transaction_id = v_transaction.id
    ) THEN
      RAISE EXCEPTION 'admin_billing_usage_payment_already_audited: %', v_target.workspace_code;
    END IF;

    UPDATE public.workspace_usage AS usage_row
    SET purchased_credit_bytes = usage_row.purchased_credit_bytes - v_transaction.gb_added_bytes,
        updated_at = timezone('utc', now())
    WHERE usage_row.workspace_id = v_workspace_id;

    PERFORM public.reconcile_workspace_usage_limit_lock(v_workspace_id);

    INSERT INTO billing.admin_payment_entitlement_metadata (
      payment_transaction_id,
      reason
    ) VALUES (
      v_transaction.id,
      'Legacy Billing Operations payment; duplicate usage credit removed while preserving the payment record.'
    );
  END LOOP;
END;
$reconcile_admin_billing_usage_credit$;
