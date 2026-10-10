-- Monthly prepaid usage renewals replace the allowance for the new cycle.
-- Older approvals kept the monthly cap and also added the same allowance as
-- purchased credit, causing a 15 GB renewal to appear as 30 GB.
DO $replace_monthly_usage_renewal$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.admin_review_workspace_payment_transaction_base(uuid,text,text,text,text)'::regprocedure
  );
  v_old_insert_values text := $old_insert$      v_transaction.billing_workspace_id,
      0,
      'Usage billing enabled by an approved workspace payment.'$old_insert$;
  v_new_insert_values text := $new_insert$      v_transaction.billing_workspace_id,
      CASE
        WHEN v_transaction.billing_snapshot ->> 'billing_mode' = 'monthly_renewal_usage'
          THEN v_transaction.gb_added_bytes
        ELSE 0
      END,
      'Usage billing enabled by an approved workspace payment.'$new_insert$;
  v_old_cap_assignment text := $old_cap$      monthly_data_transfer_limit_bytes = COALESCE(
        workspace_usage_limits.monthly_data_transfer_limit_bytes,
        0
      ),$old_cap$;
  v_new_cap_assignment text := $new_cap$      monthly_data_transfer_limit_bytes = CASE
        WHEN v_transaction.billing_snapshot ->> 'billing_mode' = 'monthly_renewal_usage'
          THEN v_transaction.gb_added_bytes
        ELSE COALESCE(workspace_usage_limits.monthly_data_transfer_limit_bytes, 0)
      END,$new_cap$;
  v_old_usage_assignment text := $old_usage$      purchased_credit_bytes = usage_row.purchased_credit_bytes + v_transaction.gb_added_bytes,
      updated_at = now()
    WHERE usage_row.workspace_id = v_transaction.billing_workspace_id;$old_usage$;
  v_new_usage_assignment text := $new_usage$      data_transfer_bytes = CASE
        WHEN v_transaction.billing_snapshot ->> 'billing_mode' = 'monthly_renewal_usage'
          THEN 0
        ELSE usage_row.data_transfer_bytes
      END,
      purchased_credit_bytes = CASE
        WHEN v_transaction.billing_snapshot ->> 'billing_mode' = 'monthly_renewal_usage'
          THEN 0
        ELSE usage_row.purchased_credit_bytes + v_transaction.gb_added_bytes
      END,
      transfer_period_start = CASE
        WHEN v_transaction.billing_snapshot ->> 'billing_mode' = 'monthly_renewal_usage'
          THEN public.workspace_usage_period_start(v_transaction.billing_workspace_id)
        ELSE usage_row.transfer_period_start
      END,
      transfer_updated_at = CASE
        WHEN v_transaction.billing_snapshot ->> 'billing_mode' = 'monthly_renewal_usage'
          THEN timezone('utc', now())
        ELSE usage_row.transfer_updated_at
      END,
      updated_at = now()
    WHERE usage_row.workspace_id = v_transaction.billing_workspace_id;$new_usage$;
BEGIN
  IF strpos(v_definition, v_old_insert_values) = 0
    OR strpos(v_definition, v_old_cap_assignment) = 0
    OR strpos(v_definition, v_old_usage_assignment) = 0 THEN
    RAISE EXCEPTION 'monthly_usage_renewal_function_definition_changed';
  END IF;

  v_definition := replace(v_definition, v_old_insert_values, v_new_insert_values);
  v_definition := replace(v_definition, v_old_cap_assignment, v_new_cap_assignment);
  v_definition := replace(v_definition, v_old_usage_assignment, v_new_usage_assignment);

  EXECUTE v_definition;
END;
$replace_monthly_usage_renewal$;

-- Remove only the duplicated credit granted by the approved Atlas renewal for
-- the current usage period. Preserve the metered data_transfer_bytes value.
DO $correct_atlas_monthly_credit$
DECLARE
  v_workspace_id uuid;
  v_transfer_period_start date;
  v_data_transfer_bytes bigint;
  v_purchased_credit_bytes bigint;
  v_monthly_limit_bytes bigint;
  v_payment_credit_bytes bigint;
  v_matching_payment_count integer;
BEGIN
  SELECT workspace_row.id
  INTO v_workspace_id
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.name = 'Atlas'
    AND workspace_row.code = 'P5TQ-B9RT'
    AND public.workspace_usage_owner_id(workspace_row.id) = workspace_row.id
  FOR KEY SHARE;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'atlas_billing_workspace_not_found';
  END IF;

  SELECT
    usage_row.transfer_period_start,
    usage_row.data_transfer_bytes,
    usage_row.purchased_credit_bytes,
    limits.monthly_data_transfer_limit_bytes
  INTO
    v_transfer_period_start,
    v_data_transfer_bytes,
    v_purchased_credit_bytes,
    v_monthly_limit_bytes
  FROM public.workspace_usage AS usage_row
  JOIN public.workspace_usage_limits AS limits
    ON limits.workspace_id = usage_row.workspace_id
  WHERE usage_row.workspace_id = v_workspace_id
  FOR UPDATE OF usage_row;

  IF NOT FOUND OR v_monthly_limit_bytes <> 15000000000 THEN
    RAISE EXCEPTION 'atlas_monthly_allowance_state_changed';
  END IF;

  SELECT
    count(*)::integer,
    max(payment_row.gb_added_bytes)
  INTO v_matching_payment_count, v_payment_credit_bytes
  FROM billing.payment_transactions AS payment_row
  WHERE payment_row.billing_workspace_id = v_workspace_id
    AND payment_row.status = 'approved'
    AND payment_row.payment_type = 'usage'
    AND payment_row.gb_added_bytes = v_monthly_limit_bytes
    AND payment_row.billing_snapshot ->> 'source' = 'workspace-payment-submission'
    AND payment_row.billing_snapshot ->> 'billing_mode' = 'monthly_renewal_usage'
    AND payment_row.paid_at >= (v_transfer_period_start::timestamp AT TIME ZONE 'UTC')
    AND payment_row.paid_at < ((v_transfer_period_start + 1)::timestamp AT TIME ZONE 'UTC');

  IF v_matching_payment_count <> 1
    OR v_payment_credit_bytes IS NULL
    OR v_purchased_credit_bytes < v_payment_credit_bytes THEN
    RAISE EXCEPTION 'atlas_monthly_renewal_credit_not_uniquely_reconcilable';
  END IF;

  UPDATE public.workspace_usage AS usage_row
  SET
    purchased_credit_bytes = usage_row.purchased_credit_bytes - v_payment_credit_bytes,
    updated_at = timezone('utc', now())
  WHERE usage_row.workspace_id = v_workspace_id;

  PERFORM public.reconcile_workspace_usage_limit_lock(v_workspace_id);
END;
$correct_atlas_monthly_credit$;
