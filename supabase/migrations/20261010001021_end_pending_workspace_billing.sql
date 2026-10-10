BEGIN;

ALTER TABLE billing.workspace_payment_configurations
  ADD COLUMN IF NOT EXISTS pending_billing_termination boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION billing.clear_resolved_billing_termination_marker()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing
AS $function$
BEGIN
  IF NEW.pending_billing_mode IS NULL THEN
    NEW.pending_billing_termination := false;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS clear_resolved_billing_termination_marker
  ON billing.workspace_payment_configurations;
CREATE TRIGGER clear_resolved_billing_termination_marker
BEFORE UPDATE OF pending_billing_mode ON billing.workspace_payment_configurations
FOR EACH ROW EXECUTE FUNCTION billing.clear_resolved_billing_termination_marker();

CREATE OR REPLACE FUNCTION billing.end_workspace_live_billing(
  p_workspace_id uuid,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_id uuid;
  v_config billing.workspace_payment_configurations%ROWTYPE;
  v_cycle billing.payg_cycles%ROWTYPE;
  v_usage_bytes bigint := 0;
  v_amount numeric := 0;
  v_actor text := COALESCE(NULLIF(btrim(p_actor), ''), 'Workspace administrator');
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('workspace-branch-payment-owner:' || p_workspace_id::text, 0)
  );
  v_owner_id := public.workspace_usage_owner_id(p_workspace_id);
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_workspace_id IS DISTINCT FROM v_owner_id THEN
    RAISE EXCEPTION 'payg_is_managed_by_source_workspace' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_owner_id::text, 0));
  SELECT * INTO v_config
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_owner_id
  FOR UPDATE;
  IF v_config.id IS NULL THEN
    RAISE EXCEPTION 'workspace_billing_not_active' USING ERRCODE = '23514';
  END IF;

  IF COALESCE(v_config.payg_enabled, false) THEN
    SELECT * INTO v_cycle
    FROM billing.payg_cycles
    WHERE billing_workspace_id = v_owner_id
      AND status IN ('open', 'awaiting_payment')
    ORDER BY period_started_at DESC
    LIMIT 1
    FOR UPDATE;
    IF v_cycle.id IS NULL THEN
      RAISE EXCEPTION 'payg_termination_requires_open_cycle' USING ERRCODE = '23514';
    END IF;

    IF v_cycle.status = 'open' THEN
      SELECT COALESCE(data_transfer_bytes, 0) INTO v_usage_bytes
      FROM public.workspace_usage
      WHERE workspace_id = v_owner_id
      FOR UPDATE;
      v_amount := billing.calculate_payg_amount_from_checkpoints(v_cycle.pricing_snapshot, v_usage_bytes);
    ELSE
      v_usage_bytes := COALESCE(v_cycle.charged_usage_bytes, 0);
      v_amount := COALESCE(v_cycle.amount_iqd, 0);
    END IF;

    -- Replace any queued mode change with an explicit end request. PAYG stays
    -- applied until its frozen usage is paid through the normal app workflow.
    UPDATE billing.workspace_payment_configurations
    SET
      pending_billing_mode = 'monthly',
      pending_billing_termination = true,
      pending_subscription_amount = 0,
      pending_gb_per_payment = 0,
      pending_payment_enabled = false,
      pending_renewal_due_at = NULL,
      pending_usage_start_date = NULL,
      updated_by = auth.uid(),
      updated_by_label = v_actor,
      updated_via = CASE WHEN auth.uid() IS NULL THEN 'admin-console' ELSE 'workspace-settings' END,
      updated_at = now()
    WHERE workspace_id = v_owner_id;

    IF v_cycle.status = 'open' THEN
      UPDATE billing.payg_cycles
      SET
        period_ended_at = now(),
        charged_usage_bytes = v_usage_bytes,
        charged_usage_gb = v_usage_bytes::numeric / 1000000000::numeric,
        amount_iqd = v_amount,
        status = CASE WHEN v_amount = 0 THEN 'no_payment_required' ELSE 'awaiting_payment' END,
        closed_at = now(),
        settled_at = CASE WHEN v_amount = 0 THEN now() ELSE NULL END,
        updated_at = now()
      WHERE id = v_cycle.id
      RETURNING * INTO v_cycle;
    ELSIF v_amount <= 0 THEN
      RAISE EXCEPTION 'payg_cycle_amount_invalid' USING ERRCODE = '23514';
    END IF;

    IF v_amount > 0 THEN
      PERFORM set_config('atlas.trusted_workspace_lock_update', 'on', true);
      UPDATE public.workspaces
      SET locked_workspace = true, payment_renewal_locked = true
      WHERE id = v_owner_id;
      RETURN jsonb_build_object(
        'success', true,
        'payment_required', true,
        'pending_termination', true,
        'cycle_id', v_cycle.id,
        'charged_usage_bytes', v_usage_bytes,
        'charged_usage_gb', (v_usage_bytes::numeric / 1000000000::numeric)::text,
        'amount_iqd', v_amount::text,
        'status', v_cycle.status
      );
    END IF;

    UPDATE public.workspace_usage
    SET data_transfer_bytes = 0, updated_at = now()
    WHERE workspace_id = v_owner_id;
  ELSE
    IF EXISTS (
      SELECT 1 FROM billing.payment_transactions
      WHERE billing_workspace_id = v_owner_id AND status = 'pending'
    ) THEN
      RAISE EXCEPTION 'workspace_payment_already_pending_for_workspace' USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM set_config('atlas.trusted_workspace_payment_family_mode_update', 'on', true);
  UPDATE billing.workspace_payment_configurations AS family_config
  SET
    billing_interval = 'monthly',
    monthly_allowance_gb = NULL,
    prepaid_cycles = NULL,
    prepaid_amount = NULL,
    prepaid_term_started_at = NULL,
    prepaid_term_payment_transaction_id = NULL,
    prepaid_allowance_mode = NULL,
    term_allowance_gb = NULL,
    subscription_amount = 0,
    is_payment_enabled = false,
    usage_enabled = false,
    payg_enabled = false,
    payg_profile_id = NULL,
    gb_per_payment = 0,
    renewal_due_at = NULL,
    usage_start_date = NULL,
    payg_cycle_started_at = NULL,
    pending_billing_mode = NULL,
    pending_billing_termination = false,
    pending_subscription_amount = NULL,
    pending_gb_per_payment = NULL,
    pending_payment_enabled = NULL,
    pending_renewal_due_at = NULL,
    pending_usage_start_date = NULL,
    updated_by = auth.uid(),
    updated_by_label = v_actor,
    updated_via = CASE WHEN auth.uid() IS NULL THEN 'admin-console' ELSE 'workspace-settings' END,
    updated_at = now()
  WHERE public.workspace_usage_owner_id(family_config.workspace_id) = v_owner_id;

  DELETE FROM public.workspace_usage_limits
  WHERE workspace_id = v_owner_id
    AND tracking_only
    AND storage_unit_limit IS NULL
    AND monthly_data_transfer_limit_bytes IS NULL;

  RETURN jsonb_build_object(
    'success', true,
    'payment_required', false,
    'pending_termination', false,
    'cycle_id', v_cycle.id,
    'charged_usage_bytes', v_usage_bytes,
    'charged_usage_gb', (v_usage_bytes::numeric / 1000000000::numeric)::text,
    'amount_iqd', v_amount::text,
    'status', COALESCE(v_cycle.status, 'ended')
  );
END;
$function$;

REVOKE ALL ON FUNCTION billing.end_workspace_live_billing(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_end_workspace_live_billing(
  p_workspace_id uuid,
  p_actor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
BEGIN
  IF (COALESCE(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;
  RETURN billing.end_workspace_live_billing(p_workspace_id, p_actor);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_terminate_workspace_payg(
  p_workspace_id uuid,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_id uuid;
  v_config billing.workspace_payment_configurations%ROWTYPE;
BEGIN
  IF (COALESCE(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;
  v_owner_id := public.workspace_usage_owner_id(p_workspace_id);
  SELECT * INTO v_config
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_owner_id;
  IF NOT COALESCE(v_config.payg_enabled, false) THEN
    RAISE EXCEPTION 'payg_is_not_enabled' USING ERRCODE = '23514';
  END IF;
  RETURN billing.end_workspace_live_billing(p_workspace_id, p_actor);
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_workspace_billing_termination()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_owner_id uuid;
  v_config billing.workspace_payment_configurations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_workspace_id IS NULL
    OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'workspace_payment_workspace_admin_required' USING ERRCODE = '42501';
  END IF;
  v_owner_id := public.workspace_usage_owner_id(v_workspace_id);
  IF v_workspace_id IS DISTINCT FROM v_owner_id THEN
    RAISE EXCEPTION 'payg_is_managed_by_source_workspace' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_config
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_owner_id;
  IF v_config.pending_billing_mode IS NULL THEN
    RAISE EXCEPTION 'workspace_billing_change_not_pending' USING ERRCODE = '23514';
  END IF;
  RETURN billing.end_workspace_live_billing(v_workspace_id, 'Workspace administrator');
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_end_workspace_live_billing(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_end_workspace_live_billing(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_terminate_workspace_payg(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_terminate_workspace_payg(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.request_workspace_billing_termination() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_workspace_billing_termination() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_workspace_payg_summary_with_limit()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_owner_id uuid;
  v_pending_termination boolean := false;
  v_summary jsonb;
BEGIN
  v_summary := public.get_workspace_payg_summary();
  IF auth.uid() IS NULL OR v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_authentication_required' USING ERRCODE = '42501';
  END IF;
  v_owner_id := public.workspace_usage_owner_id(v_workspace_id);
  SELECT COALESCE(pending_billing_termination, false) INTO v_pending_termination
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_owner_id;
  RETURN v_summary || jsonb_build_object(
    'pending_billing_termination', COALESCE(v_pending_termination, false),
    'payg_limit_state', billing.payg_limit_state_for_summary(v_summary)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_workspace_payment_configurations_v2()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE v_result jsonb;
BEGIN
  IF (COALESCE(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'role') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;
  PERFORM billing.close_due_payg_cycle(owner.id)
  FROM public.workspaces owner
  JOIN billing.workspace_payment_configurations config ON config.workspace_id = owner.id
  WHERE config.payg_enabled;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'workspace_id', workspace_row.id, 'workspace_name', workspace_row.name,
    'workspace_code', workspace_row.code, 'data_mode', workspace_row.data_mode::text,
    'billing_workspace_id', owner.id, 'is_branch', workspace_row.id <> owner.id,
    'source_workspace_id', CASE WHEN workspace_row.id <> owner.id THEN owner.id ELSE NULL END,
    'id', own_config.id, 'subscription_amount', own_config.subscription_amount::text,
    'currency', COALESCE(own_config.currency, 'IQD'),
    'is_payment_enabled', COALESCE(own_config.is_payment_enabled, false),
    'usage_enabled', COALESCE(own_config.usage_enabled, false),
    'payg_enabled', COALESCE(owner_config.payg_enabled, false),
    'payg_inherited', workspace_row.id <> owner.id AND COALESCE(owner_config.payg_enabled, false),
    'payg_profile_id', COALESCE(owner_config.payg_profile_id, cycle.pricing_profile_id),
    'payg_profile_name', COALESCE(profile.name, cycle.pricing_profile_name),
    'payg_profile_change_available', cycle.status = 'open',
    'pending_billing_mode', owner_config.pending_billing_mode,
    'pending_billing_termination', COALESCE(owner_config.pending_billing_termination, false),
    'billing_interval', COALESCE(owner_config.billing_interval, 'monthly'),
    'monthly_allowance_gb', owner_config.monthly_allowance_gb::text,
    'prepaid_cycles', owner_config.prepaid_cycles,
    'prepaid_amount', owner_config.prepaid_amount::text,
    'prepaid_term_started_at', owner_config.prepaid_term_started_at,
    'prepaid_term_payment_transaction_id', owner_config.prepaid_term_payment_transaction_id,
    'prepaid_allowance_mode', owner_config.prepaid_allowance_mode,
    'term_allowance_gb', owner_config.term_allowance_gb::text,
    'gb_per_payment', COALESCE(own_config.gb_per_payment, 0)::text,
    'renewal_due_at', CASE WHEN owner_config.payg_enabled THEN cycle.renewal_due_at ELSE own_config.renewal_due_at END,
    'usage_start_date', CASE
      WHEN COALESCE(owner_config.payg_enabled, false) THEN owner_config.payg_cycle_started_at::text
      ELSE own_config.usage_start_date::text
    END,
    'charged_usage_bytes', COALESCE(usage_row.data_transfer_bytes, 0),
    'charged_usage_gb', (COALESCE(usage_row.data_transfer_bytes, 0)::numeric / 1000000000::numeric)::text,
    'payg_amount_iqd', CASE
      WHEN cycle.status = 'awaiting_payment' THEN cycle.amount_iqd
      WHEN cycle.status = 'open' THEN billing.calculate_payg_amount_from_checkpoints(cycle.pricing_snapshot, COALESCE(usage_row.data_transfer_bytes, 0))
      ELSE 0 END::text,
    'payg_cycle_status', cycle.status, 'payg_pricing_version', cycle.pricing_version_number,
    'created_at', own_config.created_at, 'updated_at', own_config.updated_at
  ) ORDER BY owner.created_at DESC NULLS LAST, (workspace_row.id <> owner.id), workspace_row.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.workspaces workspace_row
  JOIN public.workspaces owner ON owner.id = public.workspace_usage_owner_id(workspace_row.id)
  LEFT JOIN billing.workspace_payment_configurations own_config ON own_config.workspace_id = workspace_row.id
  LEFT JOIN billing.workspace_payment_configurations owner_config ON owner_config.workspace_id = owner.id
  LEFT JOIN billing.payg_profiles profile ON profile.id = owner_config.payg_profile_id
  LEFT JOIN public.workspace_usage usage_row ON usage_row.workspace_id = owner.id
  LEFT JOIN billing.payg_cycles cycle ON cycle.billing_workspace_id = owner.id AND cycle.status IN ('open', 'awaiting_payment')
  WHERE workspace_row.deleted_at IS NULL;
  RETURN v_result;
END;
$function$;

COMMIT;
