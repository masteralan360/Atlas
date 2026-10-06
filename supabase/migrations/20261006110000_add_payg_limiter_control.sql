-- One live PAYG limiter configuration belongs to the workspace family that
-- owns the existing PAYG counter.  Mutations use admin-only RPCs and are
-- deliberately excluded from billing history and audit triggers.
CREATE TABLE billing.workspace_payg_limits (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  metric text NOT NULL DEFAULT 'accrued_charge'
    CHECK (metric IN ('accrued_charge', 'changed_usage')),
  threshold numeric(20, 6) NOT NULL
    CHECK (threshold > 0 AND threshold <> 'NaN'::numeric),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

COMMENT ON TABLE billing.workspace_payg_limits IS
  'Current PAYG lock setting only. Changes are intentionally not audited or retained as history.';

ALTER TABLE billing.workspace_payg_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing.workspace_payg_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON billing.workspace_payg_limits TO authenticated;
GRANT ALL ON billing.workspace_payg_limits TO service_role;

DROP POLICY IF EXISTS workspace_payg_limits_select_owner
  ON billing.workspace_payg_limits;
CREATE POLICY workspace_payg_limits_select_owner
  ON billing.workspace_payg_limits
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.workspace_usage_owner_id(public.current_workspace_id())
  );

DROP TRIGGER IF EXISTS touch_workspace_payg_limits_updated_at
  ON billing.workspace_payg_limits;
CREATE TRIGGER touch_workspace_payg_limits_updated_at
BEFORE UPDATE ON billing.workspace_payg_limits
FOR EACH ROW
EXECUTE FUNCTION billing.touch_updated_at();

-- Reuse the existing PAYG pricing and usage counter in a small, history-free
-- snapshot so write guards do not assemble payment/history data for every
-- business write. The public summary below consumes these same metric values.
CREATE OR REPLACE FUNCTION billing.current_payg_metric_snapshot(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_id uuid := public.workspace_usage_owner_id(p_workspace_id);
  v_config billing.workspace_payment_configurations%ROWTYPE;
  v_cycle billing.payg_cycles%ROWTYPE;
  v_usage_bytes bigint := 0;
  v_amount numeric := 0;
BEGIN
  SELECT * INTO v_config
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_owner_id;

  IF NOT COALESCE(v_config.payg_enabled, false) THEN
    RETURN jsonb_build_object(
      'enabled', false,
      'workspace_id', p_workspace_id,
      'billing_workspace_id', v_owner_id
    );
  END IF;

  -- The established summary closes a cycle when its renewal deadline has
  -- passed. Avoid taking its advisory lock on ordinary workspace writes by
  -- checking first and invoking the shared closer only for a due open cycle.
  SELECT * INTO v_cycle
  FROM billing.payg_cycles
  WHERE billing_workspace_id = v_owner_id
    AND status IN ('open', 'awaiting_payment')
  ORDER BY period_started_at DESC
  LIMIT 1;
  IF v_cycle.id IS NOT NULL
    AND v_cycle.status = 'open'
    AND v_cycle.renewal_due_at <= now() THEN
    v_cycle := billing.close_due_payg_cycle(v_owner_id);
  END IF;
  SELECT COALESCE(data_transfer_bytes, 0)
  INTO v_usage_bytes
  FROM public.workspace_usage
  WHERE workspace_id = v_owner_id;

  IF v_cycle.status = 'open' THEN
    v_amount := billing.calculate_payg_amount_from_checkpoints(
      v_cycle.pricing_snapshot,
      v_usage_bytes
    );
  ELSE
    v_usage_bytes := v_cycle.charged_usage_bytes;
    v_amount := v_cycle.amount_iqd;
  END IF;

  RETURN jsonb_build_object(
    'enabled', true,
    'workspace_id', p_workspace_id,
    'billing_workspace_id', v_owner_id,
    'cycle_id', v_cycle.id,
    'charged_usage_bytes', v_usage_bytes,
    'charged_usage_gb', (v_usage_bytes::numeric / 1000000000::numeric)::text,
    'amount_iqd', v_amount::text
  );
END;
$function$;

-- Keep the established summary shape while sourcing both lock metrics from
-- the shared snapshot used by backend write enforcement.
CREATE OR REPLACE FUNCTION public.get_workspace_payg_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_owner_id uuid;
  v_config billing.workspace_payment_configurations%ROWTYPE;
  v_cycle billing.payg_cycles%ROWTYPE;
  v_metrics jsonb;
  v_usage_bytes bigint := 0;
  v_amount numeric := 0;
  v_history jsonb := '[]'::jsonb;
  v_payment_history jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_authentication_required' USING ERRCODE = '42501';
  END IF;

  v_metrics := billing.current_payg_metric_snapshot(v_workspace_id);
  IF NOT COALESCE((v_metrics->>'enabled')::boolean, false) THEN
    RETURN jsonb_build_object(
      'enabled', false,
      'workspace_id', v_workspace_id,
      'billing_workspace_id', v_metrics->>'billing_workspace_id'
    );
  END IF;

  v_owner_id := (v_metrics->>'billing_workspace_id')::uuid;
  v_usage_bytes := (v_metrics->>'charged_usage_bytes')::bigint;
  v_amount := (v_metrics->>'amount_iqd')::numeric;
  SELECT * INTO v_config
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_owner_id;
  SELECT * INTO v_cycle
  FROM billing.payg_cycles
  WHERE id = (v_metrics->>'cycle_id')::uuid;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', history.id,
    'period_started_at', history.period_started_at,
    'period_ended_at', history.period_ended_at,
    'charged_usage_bytes', history.charged_usage_bytes,
    'charged_usage_gb', history.charged_usage_gb::text,
    'amount_iqd', history.amount_iqd::text,
    'status', history.status,
    'pricing_version', history.pricing_version_number,
    'pricing_profile_id', history.pricing_profile_id,
    'pricing_profile_name', history.pricing_profile_name,
    'payment_transaction_id', history.payment_transaction_id
  ) ORDER BY history.period_started_at DESC), '[]'::jsonb)
  INTO v_history
  FROM (
    SELECT *
    FROM billing.payg_cycles
    WHERE billing_workspace_id = v_owner_id
    ORDER BY period_started_at DESC
    LIMIT 20
  ) AS history;

  SELECT COALESCE(jsonb_agg(
    billing.payment_transaction_public_json(payment_row)
      || jsonb_build_object('payg_cycle_id', payment_row.payg_cycle_id)
    ORDER BY payment_row.created_at DESC
  ), '[]'::jsonb)
  INTO v_payment_history
  FROM (
    SELECT *
    FROM billing.payment_transactions
    WHERE billing_workspace_id = v_owner_id
      AND payment_type = 'payg'
    ORDER BY created_at DESC
    LIMIT 20
  ) AS payment_row;

  RETURN jsonb_build_object(
    'enabled', true,
    'workspace_id', v_workspace_id,
    'billing_workspace_id', v_owner_id,
    'is_inherited', v_workspace_id <> v_owner_id,
    'can_submit_payment', public.current_user_role() = 'admin',
    'cycle_id', v_cycle.id,
    'cycle_status', v_cycle.status,
    'cycle_started_at', v_cycle.period_started_at,
    'renewal_due_at', v_cycle.renewal_due_at,
    'charged_usage_bytes', v_usage_bytes,
    'charged_usage_gb', (v_usage_bytes::numeric / 1000000000::numeric)::text,
    'amount_iqd', v_amount::text,
    'currency', 'IQD',
    'pricing_version_id', v_cycle.pricing_version_id,
    'pricing_version', v_cycle.pricing_version_number,
    'pricing_profile_id', v_cycle.pricing_profile_id,
    'pricing_profile_name', v_cycle.pricing_profile_name,
    'pricing_checkpoints', v_cycle.pricing_snapshot,
    'pending_billing_mode', v_config.pending_billing_mode,
    'last_updated_at', now(),
    'history', v_history,
    'payment_history', v_payment_history
  );
END;
$function$;

-- This helper decorates the existing PAYG summary; the summary remains the
-- only source for both the charged usage and accrued charge measurements.
CREATE OR REPLACE FUNCTION billing.payg_limit_state_for_summary(p_summary jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_owner_id uuid;
  v_limit billing.workspace_payg_limits%ROWTYPE;
  v_enabled boolean := COALESCE((p_summary->>'enabled')::boolean, false);
  v_current_value numeric;
  v_limit_json jsonb := NULL;
BEGIN
  IF auth.uid() IS NULL OR v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_authentication_required' USING ERRCODE = '42501';
  END IF;

  v_owner_id := public.workspace_usage_owner_id(v_workspace_id);
  IF v_enabled THEN
    SELECT * INTO v_limit
    FROM billing.workspace_payg_limits
    WHERE workspace_id = v_owner_id;

    IF FOUND THEN
      v_current_value := CASE v_limit.metric
        WHEN 'accrued_charge' THEN COALESCE((p_summary->>'amount_iqd')::numeric, 0)
        ELSE COALESCE((p_summary->>'charged_usage_gb')::numeric, 0)
      END;

      v_limit_json := jsonb_build_object(
        'metric', v_limit.metric,
        'threshold', v_limit.threshold::text,
        'current_value', v_current_value::text,
        'locked', v_current_value >= v_limit.threshold,
        'created_at', v_limit.created_at,
        'updated_at', v_limit.updated_at
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'workspace_id', v_workspace_id,
    'billing_workspace_id', v_owner_id,
    'enabled', v_enabled,
    'has_limit', v_limit_json IS NOT NULL,
    'locked', COALESCE((v_limit_json->>'locked')::boolean, false),
    'limit', v_limit_json,
    'metrics', jsonb_build_object(
      'accrued_charge', COALESCE(p_summary->>'amount_iqd', '0'),
      'changed_usage', COALESCE(p_summary->>'charged_usage_gb', '0')
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_workspace_payg_limit_state()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_metrics jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_authentication_required' USING ERRCODE = '42501';
  END IF;

  v_metrics := billing.current_payg_metric_snapshot(v_workspace_id);
  RETURN billing.payg_limit_state_for_summary(v_metrics);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_workspace_payg_summary_with_limit()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_summary jsonb;
BEGIN
  v_summary := public.get_workspace_payg_summary();
  RETURN v_summary || jsonb_build_object(
    'payg_limit_state', billing.payg_limit_state_for_summary(v_summary)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_upsert_workspace_payg_limit(
  p_metric text,
  p_threshold numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_owner_id uuid;
  v_summary jsonb;
  v_state jsonb;
  v_current_value numeric;
  v_limit numeric(20, 6);
BEGIN
  IF auth.uid() IS NULL
    OR v_workspace_id IS NULL
    OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'workspace_payg_limit_admin_required' USING ERRCODE = '42501';
  END IF;

  IF p_metric IS NULL OR p_metric NOT IN ('accrued_charge', 'changed_usage') THEN
    RAISE EXCEPTION 'invalid_workspace_payg_limit_metric' USING ERRCODE = '22023';
  END IF;
  IF p_threshold IS NULL
    OR p_threshold::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_threshold <= 0 THEN
    RAISE EXCEPTION 'invalid_workspace_payg_limit_threshold' USING ERRCODE = '22023';
  END IF;
  IF p_threshold <> round(p_threshold, 6) THEN
    RAISE EXCEPTION 'workspace_payg_limit_threshold_precision_exceeded' USING ERRCODE = '22023';
  END IF;
  v_owner_id := public.workspace_usage_owner_id(v_workspace_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payg-limit:' || v_owner_id::text, 0));
  -- Serialize threshold changes with the counter updates that feed PAYG.
  PERFORM 1 FROM public.workspace_usage WHERE workspace_id = v_owner_id FOR UPDATE;

  v_summary := public.get_workspace_payg_summary();
  IF NOT COALESCE((v_summary->>'enabled')::boolean, false) THEN
    RAISE EXCEPTION 'workspace_payg_limit_requires_payg' USING ERRCODE = '23514';
  END IF;
  v_state := billing.payg_limit_state_for_summary(v_summary);
  v_current_value := (v_state->'metrics'->>p_metric)::numeric;
  IF COALESCE((v_state->>'locked')::boolean, false)
    AND p_threshold <= v_current_value THEN
    RAISE EXCEPTION 'workspace_payg_limit_must_exceed_current_usage' USING ERRCODE = '23514';
  END IF;

  v_limit := p_threshold;
  INSERT INTO billing.workspace_payg_limits (workspace_id, metric, threshold)
  VALUES (v_owner_id, p_metric, v_limit)
  ON CONFLICT (workspace_id) DO UPDATE
    SET metric = EXCLUDED.metric,
        threshold = EXCLUDED.threshold,
        updated_at = timezone('utc', now());

  RETURN v_summary || jsonb_build_object(
    'payg_limit_state', billing.payg_limit_state_for_summary(v_summary)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_workspace_payg_limit()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_owner_id uuid;
  v_summary jsonb;
BEGIN
  IF auth.uid() IS NULL
    OR v_workspace_id IS NULL
    OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'workspace_payg_limit_admin_required' USING ERRCODE = '42501';
  END IF;

  v_owner_id := public.workspace_usage_owner_id(v_workspace_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payg-limit:' || v_owner_id::text, 0));
  DELETE FROM billing.workspace_payg_limits WHERE workspace_id = v_owner_id;

  v_summary := public.get_workspace_payg_summary();
  RETURN v_summary || jsonb_build_object(
    'payg_limit_state', billing.payg_limit_state_for_summary(v_summary)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_workspace_payg_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_active_workspace_id uuid := public.current_workspace_id();
  v_limit_state jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR v_active_workspace_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_limit_state := public.get_workspace_payg_limit_state();
  IF COALESCE((v_limit_state->>'locked')::boolean, false) THEN
    RAISE EXCEPTION 'workspace_payg_limit_reached'
      USING ERRCODE = '42501',
        DETAIL = jsonb_build_object(
          'metric', v_limit_state->'limit'->>'metric',
          'threshold', v_limit_state->'limit'->>'threshold',
          'current_value', v_limit_state->'limit'->>'current_value'
        )::text;
  END IF;

  RETURN NULL;
END;
$function$;

-- Guard writes at the database boundary for workspace-owned application data.
-- Billing configuration and audit/history schemas are intentionally excluded;
-- the PAYG limit table itself is only writable through the admin RPCs above.
DO $install_payg_limit_guards$
DECLARE
  source record;
BEGIN
  FOR source IN
    SELECT namespace_row.nspname AS schema_name, table_row.relname AS table_name
    FROM pg_catalog.pg_class AS table_row
    INNER JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = table_row.relnamespace
    INNER JOIN information_schema.columns AS column_row
      ON column_row.table_schema = namespace_row.nspname
     AND column_row.table_name = table_row.relname
     AND column_row.column_name = 'workspace_id'
    WHERE table_row.relkind IN ('r', 'p')
      AND namespace_row.nspname NOT IN (
        'pg_catalog', 'information_schema', 'audit', 'auth', 'billing', 'extensions',
        'graphql', 'graphql_public', 'net', 'pgtap', 'realtime', 'storage',
        'supabase_functions', 'vault', 'cron', 'history', 'logs'
      )
      -- workspace_usage is the billing/metering counter itself. It must keep
      -- recording the usage that reaches a configured threshold, and PAYG
      -- cycle closure updates it while evaluating the same canonical metric.
      AND NOT (namespace_row.nspname = 'public' AND table_row.relname = 'workspace_usage')
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS enforce_workspace_payg_limit_on_write ON %I.%I',
      source.schema_name,
      source.table_name
    );
    EXECUTE format(
      'CREATE TRIGGER enforce_workspace_payg_limit_on_write BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_workspace_payg_limit()',
      source.schema_name,
      source.table_name
    );
  END LOOP;
END;
$install_payg_limit_guards$;

REVOKE ALL ON FUNCTION billing.payg_limit_state_for_summary(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing.current_payg_metric_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_workspace_payg_limit_state() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_workspace_payg_summary_with_limit() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_upsert_workspace_payg_limit(text, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_workspace_payg_limit() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.enforce_workspace_payg_limit() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_workspace_payg_limit_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_workspace_payg_summary_with_limit() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_workspace_payg_limit(text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_workspace_payg_limit() TO authenticated;

ALTER TABLE billing.workspace_payg_limits REPLICA IDENTITY FULL;
DO $enable_payg_limit_realtime$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE billing.workspace_payg_limits;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_usage;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END;
$enable_payg_limit_realtime$;
