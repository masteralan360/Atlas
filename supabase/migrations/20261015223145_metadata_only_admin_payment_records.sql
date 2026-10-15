-- Admin Billing Operations records payments for history only. The configured
-- billing operation remains responsible for allowance and renewal settings;
-- recording the payment must not apply those entitlements a second time.
CREATE TABLE billing.admin_payment_entitlement_metadata (
  payment_transaction_id uuid PRIMARY KEY
    REFERENCES billing.payment_transactions(id) ON DELETE RESTRICT,
  entitlement_effect text NOT NULL DEFAULT 'metadata_only'
    CHECK (entitlement_effect = 'metadata_only'),
  source text NOT NULL DEFAULT 'admin-billing-operations'
    CHECK (source = 'admin-billing-operations'),
  reason text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing.admin_payment_entitlement_metadata IS
  'Audits admin-recorded payment transactions whose payment approval has no entitlement effect.';

ALTER TABLE billing.admin_payment_entitlement_metadata ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE billing.admin_payment_entitlement_metadata
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE billing.admin_payment_entitlement_metadata
  TO service_role;

DO $metadata_only_admin_payment_review$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.admin_review_workspace_payment_transaction_base(uuid,text,text,text,text)'::regprocedure
  );
  v_old_open text := '  IF v_transaction.payment_type = ''subscription'' THEN';
  v_new_open text := $new$
  IF v_transaction.billing_snapshot ->> 'entitlement_effect' IS DISTINCT FROM 'metadata_only' THEN
    IF v_transaction.payment_type = 'subscription' THEN$new$;
  v_old_close text := $old$  END IF;

  UPDATE billing.payment_transactions AS transaction_row
  SET
    status = 'approved',$old$;
  v_new_close text := $new$  END IF;
  END IF;

  UPDATE billing.payment_transactions AS transaction_row
  SET
    status = 'approved',$new$;
BEGIN
  v_definition := replace(v_definition, E'\r\n', E'\n');
  IF strpos(v_definition, v_old_open) = 0
    OR strpos(v_definition, v_old_close) = 0 THEN
    RAISE EXCEPTION 'metadata_only_payment_review_definition_changed';
  END IF;

  v_definition := replace(v_definition, v_old_open, v_new_open);
  v_definition := replace(v_definition, v_old_close, v_new_close);
  EXECUTE v_definition;
END;
$metadata_only_admin_payment_review$;

-- The public reviewer has an additional subscription-expiry adjustment after
-- the base reviewer returns. Metadata-only records must stop before that path.
DO $metadata_only_admin_subscription_review$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.admin_review_workspace_payment_transaction(uuid,text,text,text,text)'::regprocedure
  );
  v_anchor text := $old$  IF v_transaction.status <> 'approved'
    OR v_transaction.payment_type <> 'subscription' THEN$old$;
  v_replacement text := $new$  IF v_transaction.billing_snapshot ->> 'entitlement_effect' = 'metadata_only' THEN
    RETURN v_result;
  END IF;

  IF v_transaction.status <> 'approved'
    OR v_transaction.payment_type <> 'subscription' THEN$new$;
BEGIN
  v_definition := replace(v_definition, E'\r\n', E'\n');
  IF strpos(v_definition, v_anchor) = 0 THEN
    RAISE EXCEPTION 'metadata_only_subscription_review_definition_changed';
  END IF;

  EXECUTE replace(v_definition, v_anchor, v_replacement);
END;
$metadata_only_admin_subscription_review$;

-- Attach an immutable marker to each Billing Operations payment before the
-- reviewer approves it. Remove the old post-approval upsert because the
-- configuration was already saved before the payment record was created.
DO $metadata_only_admin_billing_operation$
DECLARE
  v_definition text := pg_get_functiondef(
    'billing.apply_admin_billing_snapshot(uuid,text,jsonb,text,boolean,uuid)'::regprocedure
  );
  v_old_columns text := '      expires_at, provider_response, created_at, updated_at';
  v_new_columns text := '      expires_at, provider_response, billing_snapshot, created_at, updated_at';
  v_old_values text := $old$      jsonb_build_object('source', 'admin-billing-operations', 'usage_start_date', v_start, 'renewal_due_at', v_renewal),
      v_created_at,$old$;
  v_new_values text := $new$      jsonb_build_object(
        'source', 'admin-billing-operations',
        'entitlement_effect', 'metadata_only',
        'usage_start_date', v_start,
        'renewal_due_at', v_renewal
      ),
      jsonb_build_object(
        'version', 1,
        'source', 'admin-billing-operations',
        'billing_mode', p_billing_mode,
        'entitlement_effect', 'metadata_only',
        'payment_amount', v_payment_amount::text,
        'currency', 'IQD',
        'usage_allowance_gb', v_allowance::text,
        'usage_allowance_bytes', CASE
          WHEN v_payment_type = 'usage' THEN (v_allowance * 1000000000)::bigint
          ELSE 0
        END,
        'usage_start_date', v_start,
        'usage_start_at', COALESCE(v_start_at, v_start),
        'renewal_due_at', v_renewal
      ),
      v_created_at,$new$;
  v_old_post_approval_upsert text := $old$
    -- The administrator selected the exact period in this workflow. Keep that
    -- boundary after the existing reviewer has applied payment entitlements.
    PERFORM public.admin_upsert_workspace_payment_configuration_v3(
      p_workspace_id,
      v_price::text,
      CASE WHEN v_payg THEN true ELSE v_payment_enabled END,
      v_usage,
      v_payg,
      CASE WHEN v_usage THEN v_allowance::text ELSE '0' END,
      v_renewal,
      p_actor_label,
      v_start,
      'monthly',
      CASE WHEN v_payg THEN v_profile_id ELSE NULL END,
      'next_cycle'
    );
$old$;
BEGIN
  v_definition := replace(v_definition, E'\r\n', E'\n');
  IF strpos(v_definition, v_old_columns) = 0
    OR strpos(v_definition, v_old_values) = 0
    OR strpos(v_definition, v_old_post_approval_upsert) = 0 THEN
    RAISE EXCEPTION 'metadata_only_admin_billing_operation_definition_changed';
  END IF;

  v_definition := replace(v_definition, v_old_columns, v_new_columns);
  v_definition := replace(v_definition, v_old_values, v_new_values);
  v_definition := replace(v_definition, v_old_post_approval_upsert, '');
  EXECUTE v_definition;
END;
$metadata_only_admin_billing_operation$;

-- Expose the payment effect to the Admin payment history so the recorded
-- allowance is not presented as usage credit.
DO $metadata_only_admin_payment_history$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.admin_list_workspace_payment_transactions_v2(text)'::regprocedure
  );
  v_old text := '      transaction_row.gb_added::text, transaction_row.billed_usage_bytes,';
  v_new text := $replacement$      transaction_row.gb_added::text,
      CASE
        WHEN transaction_row.billing_snapshot ->> 'entitlement_effect' = 'metadata_only'
          OR transaction_row.provider_response ->> 'entitlement_effect' = 'metadata_only'
          OR EXISTS (
            SELECT 1
            FROM billing.admin_payment_entitlement_metadata AS effect_metadata
            WHERE effect_metadata.payment_transaction_id = transaction_row.id
          )
          THEN 'metadata_only'
        ELSE NULL
      END AS entitlement_effect,
      transaction_row.billed_usage_bytes,$replacement$;
BEGIN
  v_definition := replace(v_definition, E'\r\n', E'\n');
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'metadata_only_admin_payment_history_definition_changed';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END;
$metadata_only_admin_payment_history$;

DO $metadata_only_payment_public_json$
DECLARE
  v_definition text := pg_get_functiondef(
    'billing.payment_transaction_public_json(billing.payment_transactions)'::regprocedure
  );
  v_old text := $old$    'payment_type', p_transaction.payment_type,$old$;
  v_new text := $replacement$    'payment_type', p_transaction.payment_type,
    'entitlement_effect', CASE
      WHEN p_transaction.billing_snapshot ->> 'entitlement_effect' = 'metadata_only'
        OR p_transaction.provider_response ->> 'entitlement_effect' = 'metadata_only'
        OR EXISTS (
          SELECT 1
          FROM billing.admin_payment_entitlement_metadata AS effect_metadata
          WHERE effect_metadata.payment_transaction_id = p_transaction.id
        )
        THEN 'metadata_only'
      ELSE NULL
    END,$replacement$;
BEGIN
  v_definition := replace(v_definition, E'\r\n', E'\n');
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'metadata_only_payment_public_json_definition_changed';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END;
$metadata_only_payment_public_json$;

DO $metadata_only_billing_operation_history$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.admin_get_billing_operation(text)'::regprocedure
  );
  v_old text := $old$'review_note', payment.review_note$old$;
  v_new text := $replacement$'review_note', payment.review_note,
        'entitlement_effect', CASE
          WHEN payment.billing_snapshot ->> 'entitlement_effect' = 'metadata_only'
            OR EXISTS (
              SELECT 1
              FROM billing.admin_payment_entitlement_metadata AS effect_metadata
              WHERE effect_metadata.payment_transaction_id = payment.id
            )
            THEN 'metadata_only'
          ELSE NULL
        END$replacement$;
BEGIN
  v_definition := replace(v_definition, E'\r\n', E'\n');
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'metadata_only_billing_operation_history_definition_changed';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END;
$metadata_only_billing_operation_history$;

-- Correct the already approved Y3T8-YBX4 Billing Operations record without
-- deleting or changing its amount/status. Its duplicate credit is removed
-- only when the same usage period is still active and the balance is exactly
-- the 15 GB granted by that transaction.
DO $reconcile_y3t8_metadata_payment$
DECLARE
  v_workspace_id uuid;
  v_workspace_count integer;
  v_payment_count integer;
  v_transaction billing.payment_transactions%ROWTYPE;
  v_transfer_period_start date;
  v_purchased_credit_bytes bigint;
BEGIN
  SELECT count(*)::integer
  INTO v_workspace_count
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.code = 'Y3T8-YBX4'
    AND workspace_row.id = public.workspace_usage_owner_id(workspace_row.id)
    AND workspace_row.deleted_at IS NULL;

  IF v_workspace_count <> 1 THEN
    RAISE EXCEPTION 'y3t8_billing_workspace_not_unique';
  END IF;

  SELECT workspace_row.id
  INTO v_workspace_id
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.code = 'Y3T8-YBX4'
    AND workspace_row.id = public.workspace_usage_owner_id(workspace_row.id)
    AND workspace_row.deleted_at IS NULL;

  SELECT count(*)::integer
  INTO v_payment_count
  FROM billing.payment_transactions AS payment_row
  WHERE payment_row.billing_workspace_id = v_workspace_id
    AND payment_row.status = 'approved'
    AND payment_row.payment_type = 'usage'
    AND payment_row.provider = 'manual'
    AND payment_row.amount = 25000::numeric
    AND payment_row.gb_added_bytes = 15000000000
    AND payment_row.provider_response ->> 'source' = 'admin-billing-operations'
    AND payment_row.provider_response ->> 'usage_start_date' = '2026-10-11';

  IF v_payment_count <> 1 THEN
    RAISE EXCEPTION 'y3t8_admin_usage_payment_not_unique';
  END IF;

  SELECT payment_row.*
  INTO v_transaction
  FROM billing.payment_transactions AS payment_row
  WHERE payment_row.billing_workspace_id = v_workspace_id
    AND payment_row.status = 'approved'
    AND payment_row.payment_type = 'usage'
    AND payment_row.provider = 'manual'
    AND payment_row.amount = 25000::numeric
    AND payment_row.gb_added_bytes = 15000000000
    AND payment_row.provider_response ->> 'source' = 'admin-billing-operations'
    AND payment_row.provider_response ->> 'usage_start_date' = '2026-10-11'
  FOR UPDATE OF payment_row;

  IF NOT EXISTS (
    SELECT 1
    FROM billing.admin_payment_entitlement_metadata AS effect_metadata
    WHERE effect_metadata.payment_transaction_id = v_transaction.id
  ) THEN
    SELECT usage_row.transfer_period_start, usage_row.purchased_credit_bytes
    INTO v_transfer_period_start, v_purchased_credit_bytes
    FROM public.workspace_usage AS usage_row
    WHERE usage_row.workspace_id = v_workspace_id
    FOR UPDATE OF usage_row;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'y3t8_workspace_usage_row_missing';
    END IF;

    IF v_transfer_period_start = (v_transaction.provider_response ->> 'usage_start_date')::date THEN
      IF v_purchased_credit_bytes = v_transaction.gb_added_bytes THEN
        UPDATE public.workspace_usage AS usage_row
        SET purchased_credit_bytes = usage_row.purchased_credit_bytes - v_transaction.gb_added_bytes,
            updated_at = timezone('utc', now())
        WHERE usage_row.workspace_id = v_workspace_id;

        PERFORM public.reconcile_workspace_usage_limit_lock(v_workspace_id);
      ELSIF v_purchased_credit_bytes <> 0 THEN
        RAISE EXCEPTION 'y3t8_duplicate_credit_balance_is_ambiguous';
      END IF;
    END IF;

    INSERT INTO billing.admin_payment_entitlement_metadata (
      payment_transaction_id,
      reason
    ) VALUES (
      v_transaction.id,
      'Legacy Billing Operations payment; duplicate usage credit removed while preserving the payment record.'
    );
  END IF;
END;
$reconcile_y3t8_metadata_payment$;

NOTIFY pgrst, 'reload schema';
