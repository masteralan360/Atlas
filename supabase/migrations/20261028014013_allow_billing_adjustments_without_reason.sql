ALTER TABLE billing.admin_billing_revisions
  DROP CONSTRAINT admin_billing_revision_reason_check;

ALTER TABLE billing.admin_billing_revisions
  ADD CONSTRAINT admin_billing_revision_reason_check CHECK (
    revision_type <> 'adjustment' OR reason IS NULL OR length(reason) <= 1000
  );

CREATE OR REPLACE FUNCTION public.admin_adjust_billing_operation(
  p_voucher_code text,
  p_expected_live_revision_id uuid,
  p_snapshot jsonb,
  p_reason text,
  p_idempotency_key text,
  p_actor_label text DEFAULT 'Platform administrator'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_target billing.admin_billing_revisions;
  v_current billing.admin_billing_revisions;
  v_live billing.workspace_billing_live_transactions;
  v_owner_id uuid;
  v_payment_id uuid;
  v_linked_payment_id uuid;
  v_revision_id uuid := gen_random_uuid();
  v_voucher text;
  v_snapshot jsonb;
  v_config jsonb;
  v_existing billing.admin_billing_revisions;
  v_revision_number integer;
  v_attempt integer := 0;
  v_reason text := NULLIF(btrim(p_reason), '');
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_voucher_code), '') IS NULL OR p_expected_live_revision_id IS NULL
    OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object'
    OR NULLIF(btrim(p_idempotency_key), '') IS NULL OR length(p_idempotency_key) > 120 THEN
    RAISE EXCEPTION 'billing_adjustment_fields_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_target FROM billing.admin_billing_revisions
  WHERE voucher_code = upper(btrim(p_voucher_code));
  IF v_target.id IS NULL THEN
    RAISE EXCEPTION 'billing_voucher_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_owner_id := v_target.billing_workspace_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-branch-payment-owner:' || v_owner_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_owner_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-billing-live-owner:' || v_owner_id::text, 0));

  SELECT * INTO v_existing
  FROM billing.admin_billing_revisions
  WHERE billing_workspace_id = v_owner_id AND idempotency_key = p_idempotency_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.revision_type <> 'adjustment'
      OR v_existing.parent_revision_id <> p_expected_live_revision_id
      OR v_existing.snapshot->'request_snapshot' IS DISTINCT FROM p_snapshot THEN
      RAISE EXCEPTION 'billing_operation_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'revision_id', v_existing.id,
      'voucher_code', v_existing.voucher_code,
      'current_live', EXISTS (
        SELECT 1 FROM billing.workspace_billing_live_transactions AS live
        WHERE live.billing_workspace_id = v_owner_id
          AND live.current_revision_id = v_existing.id
      ),
      'payment_transaction_id', CASE
        WHEN COALESCE((v_existing.snapshot->'request_snapshot'->>'record_payment')::boolean, false)
          THEN v_existing.payment_transaction_id ELSE NULL END,
      'idempotent', true
    );
  END IF;

  SELECT * INTO v_live
  FROM billing.workspace_billing_live_transactions
  WHERE billing_workspace_id = v_owner_id
  FOR UPDATE;
  SELECT * INTO v_current
  FROM billing.admin_billing_revisions
  WHERE id = v_live.current_revision_id;
  IF v_current.family_id <> v_target.family_id THEN
    RAISE EXCEPTION 'billing_operation_superseded' USING ERRCODE = '23514';
  END IF;
  IF v_current.id <> p_expected_live_revision_id THEN
    RAISE EXCEPTION 'billing_operation_stale_revision' USING ERRCODE = '40001';
  END IF;
  IF (p_snapshot->>'billing_mode') IS DISTINCT FROM v_current.billing_mode THEN
    RAISE EXCEPTION 'billing_adjustment_cannot_change_billing_mode' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('atlas.admin_billing_operation_write', 'on', true);
  v_payment_id := billing.apply_admin_billing_snapshot(
    v_current.requested_workspace_id,
    v_current.billing_mode,
    p_snapshot,
    COALESCE(NULLIF(btrim(p_actor_label), ''), 'Platform administrator'),
    COALESCE((p_snapshot->>'record_payment')::boolean, false),
    CASE WHEN v_current.billing_mode = 'prepaid_term'
      THEN v_current.payment_transaction_id ELSE NULL END
  );
  v_linked_payment_id := COALESCE(v_payment_id, v_current.payment_transaction_id);

  SELECT to_jsonb(owner_config) INTO v_config
  FROM billing.workspace_payment_configurations AS owner_config
  WHERE owner_config.workspace_id = v_owner_id;
  v_snapshot := p_snapshot || jsonb_build_object(
    'configured', true,
    'billing_mode', v_current.billing_mode,
    'configuration', v_config,
    'payment_transaction_id', v_linked_payment_id,
    'request_snapshot', p_snapshot,
    'expected_live_revision_id', p_expected_live_revision_id
  );
  SELECT to_jsonb(workspace_config) INTO v_config
  FROM billing.workspace_payment_configurations AS workspace_config
  WHERE workspace_config.workspace_id = v_current.requested_workspace_id;
  v_snapshot := v_snapshot || jsonb_build_object('workspace_configuration', v_config);

  v_revision_number := v_current.revision_number + 1;
  v_voucher := v_current.base_voucher_code || '-' || v_revision_number::text;
  INSERT INTO billing.admin_billing_revisions (
    id, billing_workspace_id, requested_workspace_id, family_id,
    parent_revision_id, revision_number, base_voucher_code, voucher_code,
    revision_type, billing_mode, snapshot, previous_snapshot, reason,
    payment_transaction_id, idempotency_key, created_by, created_by_label,
    created_via
  ) VALUES (
    v_revision_id, v_owner_id, v_current.requested_workspace_id,
    v_current.family_id, v_current.id, v_revision_number,
    v_current.base_voucher_code, v_voucher, 'adjustment', v_current.billing_mode,
    v_snapshot, v_current.snapshot, v_reason, v_linked_payment_id,
    p_idempotency_key, auth.uid(),
    COALESCE(NULLIF(btrim(p_actor_label), ''), 'Platform administrator'),
    'admin-console'
  );

  UPDATE billing.workspace_billing_live_transactions
  SET current_revision_id = v_revision_id,
      revision_version = revision_version + 1,
      updated_at = now(),
      updated_by_label = COALESCE(NULLIF(btrim(p_actor_label), ''), 'Platform administrator')
  WHERE billing_workspace_id = v_owner_id
    AND current_revision_id = p_expected_live_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_operation_stale_revision' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'revision_id', v_revision_id,
    'voucher_code', v_voucher,
    'billing_workspace_id', v_owner_id,
    'current_live', true,
    'payment_transaction_id', v_payment_id,
    'payment_status', CASE WHEN v_payment_id IS NULL THEN 'unchanged' ELSE 'approved' END,
    'idempotent', false
  );
END;
$function$;
