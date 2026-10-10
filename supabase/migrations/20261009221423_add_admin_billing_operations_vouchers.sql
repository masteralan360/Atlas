-- Admin billing operation snapshots and the owner-level current-live pointer.
-- Billing configuration and billing.payment_transactions remain authoritative
-- for reconciliation and collected payments; this is an immutable audit layer.

CREATE TABLE billing.admin_billing_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  requested_workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  family_id uuid NOT NULL,
  parent_revision_id uuid NULL,
  revision_number integer NOT NULL CHECK (revision_number >= 0),
  base_voucher_code text NOT NULL,
  voucher_code text NOT NULL UNIQUE,
  revision_type text NOT NULL CHECK (revision_type IN ('baseline', 'create', 'adjustment', 'configuration_override')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('unconfigured', 'monthly_subscription', 'monthly_renewal_usage', 'prepaid_term', 'payg')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  previous_snapshot jsonb NULL CHECK (previous_snapshot IS NULL OR jsonb_typeof(previous_snapshot) = 'object'),
  reason text NULL,
  payment_transaction_id uuid NULL REFERENCES billing.payment_transactions(id) ON DELETE RESTRICT,
  idempotency_key text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_label text NOT NULL,
  created_via text NOT NULL DEFAULT 'admin-console',
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT admin_billing_revision_family_fk
    FOREIGN KEY (family_id) REFERENCES billing.admin_billing_revisions(id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT admin_billing_revision_parent_fk
    FOREIGN KEY (parent_revision_id) REFERENCES billing.admin_billing_revisions(id)
    ON DELETE RESTRICT,
  CONSTRAINT admin_billing_revision_shape_check CHECK (
    (revision_type IN ('baseline', 'create', 'configuration_override') AND revision_number = 0 AND parent_revision_id IS NULL AND family_id = id)
    OR (revision_type = 'adjustment' AND revision_number > 0 AND parent_revision_id IS NOT NULL AND family_id <> id)
  ),
  CONSTRAINT admin_billing_revision_voucher_shape_check CHECK (
    (revision_number = 0 AND voucher_code = base_voucher_code AND base_voucher_code ~ '^BL-[0-9]{4}-[A-F0-9]{8}$')
    OR (revision_number > 0 AND voucher_code = base_voucher_code || '-' || revision_number::text)
  ),
  CONSTRAINT admin_billing_revision_reason_check CHECK (
    revision_type <> 'adjustment' OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 3 AND 1000)
  )
);

CREATE UNIQUE INDEX admin_billing_revisions_family_revision_idx
  ON billing.admin_billing_revisions (family_id, revision_number);
CREATE UNIQUE INDEX admin_billing_revisions_idempotency_idx
  ON billing.admin_billing_revisions (billing_workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX admin_billing_revisions_owner_created_idx
  ON billing.admin_billing_revisions (billing_workspace_id, created_at DESC);
CREATE INDEX admin_billing_revisions_family_idx
  ON billing.admin_billing_revisions (family_id, revision_number);
CREATE INDEX admin_billing_revisions_base_voucher_idx
  ON billing.admin_billing_revisions (base_voucher_code);

CREATE TABLE billing.workspace_billing_live_transactions (
  billing_workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  current_revision_id uuid NOT NULL REFERENCES billing.admin_billing_revisions(id) ON DELETE RESTRICT,
  revision_version bigint NOT NULL DEFAULT 1 CHECK (revision_version > 0),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_by_label text NOT NULL DEFAULT 'Billing initialization'
);

ALTER TABLE billing.admin_billing_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.workspace_billing_live_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing.admin_billing_revisions, billing.workspace_billing_live_transactions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.admin_billing_revisions,
  billing.workspace_billing_live_transactions TO service_role;

CREATE OR REPLACE FUNCTION billing.protect_admin_billing_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'admin_billing_revision_is_immutable' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER admin_billing_revisions_immutable
BEFORE UPDATE OR DELETE ON billing.admin_billing_revisions
FOR EACH ROW EXECUTE FUNCTION billing.protect_admin_billing_revision();

CREATE OR REPLACE FUNCTION billing.validate_workspace_billing_live_reference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing
AS $function$
DECLARE
  v_revision_owner uuid;
BEGIN
  SELECT revision.billing_workspace_id
  INTO v_revision_owner
  FROM billing.admin_billing_revisions AS revision
  WHERE revision.id = NEW.current_revision_id;

  IF v_revision_owner IS NULL OR v_revision_owner <> NEW.billing_workspace_id THEN
    RAISE EXCEPTION 'billing_live_reference_owner_mismatch' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_billing_live_reference_owner
BEFORE INSERT OR UPDATE OF billing_workspace_id, current_revision_id
ON billing.workspace_billing_live_transactions
FOR EACH ROW EXECUTE FUNCTION billing.validate_workspace_billing_live_reference();

CREATE OR REPLACE FUNCTION billing.generate_admin_billing_base_voucher()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog
AS $function$
  SELECT 'BL-' || to_char(timezone('UTC', now()), 'YYYY') || '-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$function$;

CREATE OR REPLACE FUNCTION billing.ensure_workspace_billing_live_reference(p_billing_workspace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_revision_id uuid;
  v_voucher text;
  v_config billing.workspace_payment_configurations;
  v_mode text;
  v_snapshot jsonb;
  v_attempt integer := 0;
BEGIN
  IF p_billing_workspace_id IS NULL THEN
    RAISE EXCEPTION 'billing_workspace_required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin-billing-live-owner:' || p_billing_workspace_id::text, 0)
  );

  SELECT current_revision_id INTO v_revision_id
  FROM billing.workspace_billing_live_transactions
  WHERE billing_workspace_id = p_billing_workspace_id;
  IF v_revision_id IS NOT NULL THEN
    RETURN v_revision_id;
  END IF;

  SELECT * INTO v_config
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = p_billing_workspace_id;

  v_mode := CASE
    WHEN v_config.id IS NULL THEN 'unconfigured'
    WHEN v_config.payg_enabled THEN 'payg'
    WHEN v_config.billing_interval = 'prepaid_term' THEN 'prepaid_term'
    WHEN v_config.usage_enabled THEN 'monthly_renewal_usage'
    ELSE 'monthly_subscription'
  END;
  v_snapshot := jsonb_build_object(
    'configured', v_config.id IS NOT NULL,
    'billing_mode', v_mode,
    'configuration', CASE WHEN v_config.id IS NULL THEN NULL ELSE to_jsonb(v_config) END,
    'payment_transaction_id', CASE WHEN v_config.id IS NULL THEN NULL ELSE v_config.prepaid_term_payment_transaction_id END,
    'initialized_as_nonfinancial_baseline', true
  );

  LOOP
    v_attempt := v_attempt + 1;
    v_voucher := billing.generate_admin_billing_base_voucher();
    v_revision_id := gen_random_uuid();
    BEGIN
      INSERT INTO billing.admin_billing_revisions (
        id, billing_workspace_id, requested_workspace_id, family_id,
        revision_number, base_voucher_code, voucher_code, revision_type,
        billing_mode, snapshot, payment_transaction_id, created_by_label, created_via
      ) VALUES (
        v_revision_id, p_billing_workspace_id, p_billing_workspace_id,
        v_revision_id, 0, v_voucher, v_voucher, 'baseline', v_mode,
        v_snapshot, v_config.prepaid_term_payment_transaction_id,
        'Legacy billing baseline', 'billing-baseline-migration'
      );
      INSERT INTO billing.workspace_billing_live_transactions (
        billing_workspace_id, current_revision_id, revision_version,
        updated_by_label
      ) VALUES (
        p_billing_workspace_id, v_revision_id, 1, 'Legacy billing baseline'
      );
      RETURN v_revision_id;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 10 THEN RAISE; END IF;
      -- A conflicting voucher or competing initializer is retried. The owner
      -- advisory lock makes competing initializers serial for this owner.
    END;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION billing.ensure_workspace_billing_live_reference(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.ensure_workspace_billing_live_reference(uuid)
  TO service_role;

-- Existing active billing owners receive nonfinancial baselines. The snapshot
-- copies existing configuration only and never creates or changes a payment.
DO $migration$
DECLARE
  v_owner record;
BEGIN
  FOR v_owner IN
    SELECT DISTINCT public.workspace_usage_owner_id(workspace_row.id) AS id
    FROM public.workspaces AS workspace_row
    WHERE public.workspace_usage_owner_id(workspace_row.id) = workspace_row.id
    ORDER BY 1
  LOOP
    PERFORM billing.ensure_workspace_billing_live_reference(v_owner.id);
  END LOOP;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.admin_list_billing_operations(p_search text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_result jsonb;
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT revision.id, revision.billing_workspace_id, revision.requested_workspace_id,
      owner.name AS billing_workspace_name, requested.name AS workspace_name,
      revision.family_id, revision.parent_revision_id, revision.revision_number,
      revision.base_voucher_code, revision.voucher_code, revision.revision_type,
      revision.billing_mode, revision.snapshot, revision.previous_snapshot,
      revision.reason, revision.payment_transaction_id,
      revision.created_by, revision.created_by_label, revision.created_at,
      live.current_revision_id AS current_live_revision_id,
      (live.current_revision_id = revision.id) AS is_current_live,
      (live.current_revision_id IS NOT NULL AND live_revision.family_id = revision.family_id) AS is_live_family,
      payment.amount::text AS payment_amount, payment.currency AS payment_currency,
      payment.status AS payment_status, payment.paid_at
    FROM billing.admin_billing_revisions AS revision
    JOIN public.workspaces AS owner ON owner.id = revision.billing_workspace_id
    JOIN public.workspaces AS requested ON requested.id = revision.requested_workspace_id
    LEFT JOIN billing.workspace_billing_live_transactions AS live
      ON live.billing_workspace_id = revision.billing_workspace_id
    LEFT JOIN billing.admin_billing_revisions AS live_revision
      ON live_revision.id = live.current_revision_id
    LEFT JOIN LATERAL (
      SELECT payment_row.amount, payment_row.currency,
        payment_row.status, payment_row.paid_at
      FROM billing.payment_transactions AS payment_row
      WHERE payment_row.id = revision.payment_transaction_id
        OR (
          live.current_revision_id = revision.id
          AND revision.payment_transaction_id IS NULL
          AND payment_row.billing_workspace_id = revision.billing_workspace_id
          AND payment_row.status = 'approved'
          AND payment_row.created_at >= revision.created_at
        )
      ORDER BY (payment_row.id = revision.payment_transaction_id) DESC,
        payment_row.created_at DESC
      LIMIT 1
    ) AS payment ON true
    WHERE v_search IS NULL
      OR revision.voucher_code ILIKE '%' || v_search || '%'
      OR revision.base_voucher_code ILIKE '%' || v_search || '%'
      OR requested.name ILIKE '%' || v_search || '%'
      OR requested.id::text ILIKE '%' || v_search || '%'
      OR owner.name ILIKE '%' || v_search || '%'
      OR owner.id::text ILIKE '%' || v_search || '%'
  ) AS row_data;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_billing_operation(p_voucher_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_requested billing.admin_billing_revisions;
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_voucher_code), '') IS NULL THEN
    RAISE EXCEPTION 'billing_voucher_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_requested
  FROM billing.admin_billing_revisions
  WHERE voucher_code = upper(btrim(p_voucher_code));
  IF v_requested.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'requested_revision_id', v_requested.id,
    'family_id', v_requested.family_id,
    'requested_voucher_code', v_requested.voucher_code,
    'billing_workspace_id', v_requested.billing_workspace_id,
    'workspace_id', v_requested.requested_workspace_id,
    'workspace_name', requested.name,
    'billing_workspace_name', owner.name,
    'current_live_revision_id', live.current_revision_id,
    'current_live_voucher_code', live_revision.voucher_code,
    'current_live_snapshot', live_revision.snapshot,
    'current_live_billing_mode', live_revision.billing_mode,
    'current_live_created_by_label', live_revision.created_by_label,
    'current_live_created_at', live_revision.created_at,
    'current_live_payment_amount', live_payment.amount::text,
    'current_live_payment_currency', live_payment.currency,
    'current_live_payment_status', live_payment.status,
    'live_family_id', live_revision.family_id,
    'is_live_family', live_revision.family_id = v_requested.family_id,
    'payment_history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', payment.id,
        'workspace_id', payment.workspace_id,
        'submitted_by_name', payment.submitted_by_name,
        'provider', payment.provider,
        'payment_type', payment.payment_type,
        'amount', payment.amount::text,
        'currency', payment.currency,
        'status', payment.status,
        'created_at', payment.created_at,
        'paid_at', payment.paid_at,
        'reviewed_at', payment.reviewed_at,
        'reviewed_by_label', payment.reviewed_by_label,
        'review_note', payment.review_note
      ) ORDER BY payment.created_at DESC)
      FROM billing.payment_transactions AS payment
      WHERE payment.billing_workspace_id = v_requested.billing_workspace_id
    ), '[]'::jsonb),
    'payment_adjustment_history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'transaction_id', audit.transaction_id,
        'old_record', audit.old_record,
        'new_record', audit.new_record,
        'changed_by_label', audit.changed_by_label,
        'changed_at', audit.changed_at
      ) ORDER BY audit.changed_at DESC)
      FROM billing.prepaid_term_replacement_audit AS audit
      WHERE audit.billing_workspace_id = v_requested.billing_workspace_id
        AND audit.transaction_id IN (
          SELECT family_revision.payment_transaction_id
          FROM billing.admin_billing_revisions AS family_revision
          WHERE family_revision.family_id = v_requested.family_id
            AND family_revision.payment_transaction_id IS NOT NULL
        )
    ), '[]'::jsonb),
    'revisions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', family_revision.id,
        'parent_revision_id', family_revision.parent_revision_id,
        'revision_number', family_revision.revision_number,
        'base_voucher_code', family_revision.base_voucher_code,
        'voucher_code', family_revision.voucher_code,
        'revision_type', family_revision.revision_type,
        'billing_mode', family_revision.billing_mode,
        'snapshot', family_revision.snapshot,
        'previous_snapshot', family_revision.previous_snapshot,
        'reason', family_revision.reason,
        'payment_transaction_id', family_revision.payment_transaction_id,
        'created_by_label', family_revision.created_by_label,
        'created_at', family_revision.created_at,
        'payment_amount', payment.amount::text,
        'payment_status', payment.status,
        'paid_at', payment.paid_at,
        'is_current_live', live.current_revision_id = family_revision.id
      ) ORDER BY family_revision.revision_number)
      FROM billing.admin_billing_revisions AS family_revision
      LEFT JOIN billing.payment_transactions AS payment
        ON payment.id = family_revision.payment_transaction_id
      WHERE family_revision.family_id = v_requested.family_id
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM public.workspaces AS requested
  JOIN public.workspaces AS owner ON owner.id = v_requested.billing_workspace_id
  LEFT JOIN billing.workspace_billing_live_transactions AS live
    ON live.billing_workspace_id = v_requested.billing_workspace_id
  LEFT JOIN billing.admin_billing_revisions AS live_revision
    ON live_revision.id = live.current_revision_id
  LEFT JOIN LATERAL (
    SELECT payment.id, payment.amount, payment.currency, payment.status,
      payment.paid_at
    FROM billing.payment_transactions AS payment
    WHERE payment.id = live_revision.payment_transaction_id
      OR (
        live_revision.payment_transaction_id IS NULL
        AND payment.billing_workspace_id = v_requested.billing_workspace_id
        AND payment.status = 'approved'
        AND payment.created_at >= live_revision.created_at
      )
    ORDER BY (payment.id = live_revision.payment_transaction_id) DESC,
      payment.created_at DESC
    LIMIT 1
  ) AS live_payment ON true
  WHERE requested.id = v_requested.requested_workspace_id;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_list_billing_operations(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_billing_operations(text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_get_billing_operation(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_billing_operation(text) TO service_role;

-- Keep the live reference aligned when established administrative billing
-- controls change the authoritative configuration outside Billing Operations.
-- Such changes are recorded as configuration overrides, never as payments or
-- voucher adjustments.
CREATE OR REPLACE FUNCTION billing.capture_admin_billing_configuration_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_id uuid;
  v_revision_id uuid;
  v_voucher text;
  v_mode text;
  v_version bigint;
  v_current_revision_created_at timestamptz;
  v_current_payment_id uuid;
  v_payment_id uuid;
  v_attempt integer := 0;
  v_snapshot jsonb;
BEGIN
  IF COALESCE(current_setting('atlas.admin_billing_operation_write', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  v_owner_id := public.workspace_usage_owner_id(NEW.workspace_id);
  IF v_owner_id IS NULL OR NEW.workspace_id <> v_owner_id THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin-billing-live-owner:' || v_owner_id::text, 0)
  );
  PERFORM billing.ensure_workspace_billing_live_reference(v_owner_id);

  v_mode := CASE
    WHEN NEW.payg_enabled THEN 'payg'
    WHEN NEW.billing_interval = 'prepaid_term' THEN 'prepaid_term'
    WHEN NEW.usage_enabled THEN 'monthly_renewal_usage'
    ELSE 'monthly_subscription'
  END;
  v_snapshot := jsonb_build_object(
    'configured', true,
    'billing_mode', v_mode,
    'configuration', to_jsonb(NEW),
    'payment_transaction_id', v_payment_id,
    'source', 'existing-administrative-billing-control'
  );
  v_revision_id := gen_random_uuid();
  SELECT live.revision_version, current_revision.created_at,
    current_revision.payment_transaction_id
  INTO v_version, v_current_revision_created_at, v_current_payment_id
  FROM billing.workspace_billing_live_transactions AS live
  JOIN billing.admin_billing_revisions AS current_revision
    ON current_revision.id = live.current_revision_id
  WHERE live.billing_workspace_id = v_owner_id
  FOR UPDATE OF live;

  SELECT payment.id INTO v_payment_id
  FROM billing.payment_transactions AS payment
  WHERE payment.billing_workspace_id = v_owner_id
    AND payment.status = 'approved'
    AND payment.created_at >= v_current_revision_created_at
  ORDER BY payment.created_at DESC, payment.id DESC
  LIMIT 1;
  v_payment_id := COALESCE(NEW.prepaid_term_payment_transaction_id, v_payment_id, v_current_payment_id);
  v_snapshot := v_snapshot || jsonb_build_object('payment_transaction_id', v_payment_id);

  LOOP
    v_attempt := v_attempt + 1;
    v_voucher := billing.generate_admin_billing_base_voucher();
    BEGIN
      INSERT INTO billing.admin_billing_revisions (
        id, billing_workspace_id, requested_workspace_id, family_id,
        revision_number, base_voucher_code, voucher_code, revision_type,
        billing_mode, snapshot, payment_transaction_id, created_by,
        created_by_label, created_via
      ) VALUES (
        v_revision_id, v_owner_id, v_owner_id, v_revision_id, 0,
        v_voucher, v_voucher, 'configuration_override', v_mode, v_snapshot,
        v_payment_id,
        NEW.updated_by, COALESCE(NULLIF(btrim(NEW.updated_by_label), ''), 'Billing configuration updated'),
        COALESCE(NULLIF(NEW.updated_via, ''), 'admin-configuration')
      );
      UPDATE billing.workspace_billing_live_transactions
      SET current_revision_id = v_revision_id,
          revision_version = COALESCE(v_version, 0) + 1,
          updated_at = now(),
          updated_by_label = COALESCE(NULLIF(btrim(NEW.updated_by_label), ''), 'Billing configuration updated')
      WHERE billing_workspace_id = v_owner_id;
      RETURN NEW;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 10 THEN RAISE; END IF;
    END;
  END LOOP;
END;
$function$;

CREATE TRIGGER capture_admin_billing_configuration_change
AFTER INSERT OR UPDATE ON billing.workspace_payment_configurations
FOR EACH ROW EXECUTE FUNCTION billing.capture_admin_billing_configuration_change();

CREATE OR REPLACE FUNCTION billing.initialize_workspace_billing_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
BEGIN
  IF public.workspace_usage_owner_id(NEW.id) = NEW.id THEN
    PERFORM billing.ensure_workspace_billing_live_reference(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER initialize_workspace_billing_reference
AFTER INSERT ON public.workspaces
FOR EACH ROW EXECUTE FUNCTION billing.initialize_workspace_billing_reference();

CREATE OR REPLACE FUNCTION billing.remove_workspace_billing_reference_after_branch_attach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_workspace_id uuid;
  v_owner_id uuid;
BEGIN
  v_workspace_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.branch_workspace_id ELSE NEW.branch_workspace_id END;
  v_owner_id := public.workspace_usage_owner_id(v_workspace_id);

  IF v_owner_id IS DISTINCT FROM v_workspace_id THEN
    IF v_owner_id IS NOT NULL THEN
      PERFORM billing.ensure_workspace_billing_live_reference(v_owner_id);
    END IF;
    DELETE FROM billing.workspace_billing_live_transactions
    WHERE billing_workspace_id = v_workspace_id;
  ELSE
    PERFORM billing.ensure_workspace_billing_live_reference(v_workspace_id);
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER remove_workspace_billing_reference_after_branch_attach
AFTER INSERT OR UPDATE OR DELETE ON public.workspace_branches
FOR EACH ROW EXECUTE FUNCTION billing.remove_workspace_billing_reference_after_branch_attach();

-- The helper applies only established billing configuration and payment
-- workflows. It never mutates collected payments or creates an unpaid payment.
CREATE OR REPLACE FUNCTION billing.apply_admin_billing_snapshot(
  p_workspace_id uuid,
  p_billing_mode text,
  p_snapshot jsonb,
  p_actor_label text,
  p_record_payment boolean,
  p_payment_correction_transaction_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_price numeric;
  v_allowance numeric;
  v_payment_amount numeric;
  v_payment_id uuid;
  v_payment_type text;
  v_paid jsonb;
  v_usage boolean;
  v_payg boolean;
  v_payment_enabled boolean;
  v_renewal text;
  v_start text;
  v_profile_id uuid;
  v_cycles integer;
  v_prepaid_mode text;
  v_created_at timestamptz := now();
BEGIN
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'billing_snapshot_required' USING ERRCODE = '22023';
  END IF;
  IF p_billing_mode NOT IN ('monthly_subscription', 'monthly_renewal_usage', 'prepaid_term', 'payg') THEN
    RAISE EXCEPTION 'unsupported_billing_mode' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_price := COALESCE(NULLIF(p_snapshot->>'subscription_amount', ''), '0')::numeric;
    v_allowance := COALESCE(NULLIF(p_snapshot->>'monthly_allowance_gb', ''), NULLIF(p_snapshot->>'gb_per_payment', ''), '0')::numeric;
    v_payment_amount := COALESCE(NULLIF(p_snapshot->>'payment_amount', ''), NULLIF(p_snapshot->>'prepaid_amount', ''), '0')::numeric;
    v_payment_enabled := COALESCE((p_snapshot->>'is_payment_enabled')::boolean, p_billing_mode <> 'monthly_subscription');
    v_renewal := NULLIF(p_snapshot->>'renewal_due_at', '');
    v_start := NULLIF(p_snapshot->>'usage_start_date', '');
    v_profile_id := NULLIF(p_snapshot->>'payg_profile_id', '')::uuid;
    v_cycles := NULLIF(p_snapshot->>'prepaid_cycles', '')::integer;
    v_prepaid_mode := COALESCE(NULLIF(p_snapshot->>'prepaid_allowance_mode', ''), 'term_pool');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_billing_snapshot' USING ERRCODE = '22023';
  END;

  IF v_price < 0 OR v_allowance < 0 OR v_payment_amount < 0
  THEN
    RAISE EXCEPTION 'billing_values_must_be_non_negative' USING ERRCODE = '22023';
  END IF;
  IF abs(v_price) >= 100000000000000000::numeric
    OR abs(v_payment_amount) >= 100000000000000000::numeric
    OR abs(v_allowance) >= 100000000::numeric
    OR scale(trim_scale(v_price)) > 3
    OR scale(trim_scale(v_payment_amount)) > 3
    OR scale(trim_scale(v_allowance)) > 6 THEN
    RAISE EXCEPTION 'billing_values_exceed_supported_precision' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(NULLIF(upper(p_snapshot->>'currency'), ''), 'IQD') <> 'IQD' THEN
    RAISE EXCEPTION 'workspace_billing_currency_must_be_iqd' USING ERRCODE = '22023';
  END IF;

  v_usage := p_billing_mode IN ('monthly_renewal_usage', 'prepaid_term');
  v_payg := p_billing_mode = 'payg';

  IF p_billing_mode = 'prepaid_term' THEN
    IF NOT p_record_payment THEN
      RAISE EXCEPTION 'prepaid_term_requires_explicit_payment' USING ERRCODE = '23514';
    END IF;
    IF p_workspace_id <> public.workspace_usage_owner_id(p_workspace_id) THEN
      RAISE EXCEPTION 'prepaid_term_is_managed_by_source_workspace' USING ERRCODE = '23514';
    END IF;
    IF v_price <= 0 OR v_allowance <= 0 OR v_cycles IS NULL OR v_cycles NOT BETWEEN 1 AND 120
      OR v_payment_amount <= 0 OR v_start IS NULL THEN
      RAISE EXCEPTION 'invalid_prepaid_term_configuration' USING ERRCODE = '22023';
    END IF;
    PERFORM public.admin_activate_workspace_prepaid_term_v3(
      p_workspace_id, v_price::text, v_allowance::text, v_cycles,
      v_payment_amount::text, v_start, v_prepaid_mode,
      p_payment_correction_transaction_id IS NOT NULL,
      p_payment_correction_transaction_id,
      p_actor_label
    );
    SELECT prepaid_term_payment_transaction_id INTO v_payment_id
    FROM billing.workspace_payment_configurations
    WHERE workspace_id = p_workspace_id;
    RETURN v_payment_id;
  END IF;

  IF p_billing_mode = 'monthly_renewal_usage' THEN
    IF v_allowance <= 0 OR v_renewal IS NULL OR v_start IS NULL THEN
      RAISE EXCEPTION 'usage_billing_dates_and_allowance_required' USING ERRCODE = '22023';
    END IF;
    IF v_start::date >= v_renewal::timestamptz::date THEN
      RAISE EXCEPTION 'billing_period_start_must_precede_renewal' USING ERRCODE = '22023';
    END IF;
  ELSIF p_billing_mode = 'payg' THEN
    IF v_profile_id IS NULL OR v_renewal IS NULL THEN
      RAISE EXCEPTION 'payg_profile_and_renewal_required' USING ERRCODE = '22023';
    END IF;
    IF p_record_payment THEN
      RAISE EXCEPTION 'payg_payment_requires_existing_cycle_workflow' USING ERRCODE = '23514';
    END IF;
  ELSIF p_billing_mode = 'monthly_subscription' AND p_record_payment AND v_payment_amount <= 0 THEN
    RAISE EXCEPTION 'payment_amount_must_be_positive' USING ERRCODE = '22023';
  END IF;

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

  IF p_record_payment THEN
    IF p_billing_mode = 'monthly_renewal_usage' THEN
      v_payment_type := 'usage';
      IF v_payment_amount <= 0 THEN
        RAISE EXCEPTION 'payment_amount_must_be_positive' USING ERRCODE = '22023';
      END IF;
    ELSE
      v_payment_type := 'subscription';
    END IF;

    INSERT INTO billing.payment_transactions (
      workspace_id, billing_workspace_id, submitted_by_name, provider,
      payment_type, amount, currency, gb_added, gb_added_bytes, status,
      expires_at, provider_response, created_at, updated_at
    ) VALUES (
      p_workspace_id,
      public.workspace_usage_owner_id(p_workspace_id),
      p_actor_label,
      'manual',
      v_payment_type,
      v_payment_amount,
      'IQD',
      CASE WHEN v_payment_type = 'usage' THEN v_allowance ELSE 0 END,
      CASE WHEN v_payment_type = 'usage' THEN (v_allowance * 1000000000)::bigint ELSE 0 END,
      'pending',
      v_created_at + interval '7 days',
      jsonb_build_object('source', 'admin-billing-operations', 'usage_start_date', v_start, 'renewal_due_at', v_renewal),
      v_created_at,
      v_created_at
    ) RETURNING id INTO v_payment_id;

    v_paid := public.admin_review_workspace_payment_transaction_v2(
      v_payment_id, 'approved', 'Prepaid period recorded by Billing Operations',
      p_actor_label, NULL
    );
    IF COALESCE((v_paid->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'billing_payment_not_approved' USING ERRCODE = '23514';
    END IF;

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
  END IF;

  RETURN v_payment_id;
END;
$function$;

REVOKE ALL ON FUNCTION billing.apply_admin_billing_snapshot(uuid, text, jsonb, text, boolean, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.apply_admin_billing_snapshot(uuid, text, jsonb, text, boolean, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.admin_create_billing_operation(
  p_workspace_id uuid,
  p_billing_mode text,
  p_snapshot jsonb,
  p_idempotency_key text,
  p_actor_label text DEFAULT 'Platform administrator'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_id uuid;
  v_revision_id uuid;
  v_payment_id uuid;
  v_voucher text;
  v_snapshot jsonb;
  v_config jsonb;
  v_live billing.workspace_billing_live_transactions;
  v_existing billing.admin_billing_revisions;
  v_attempt integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'workspace_and_billing_snapshot_required' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(p_idempotency_key), '') IS NULL OR length(p_idempotency_key) > 120 THEN
    RAISE EXCEPTION 'billing_operation_idempotency_key_required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-branch-payment-owner:' || p_workspace_id::text, 0));
  v_owner_id := public.workspace_usage_owner_id(p_workspace_id);
  IF v_owner_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.workspaces WHERE id = p_workspace_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-payment:' || v_owner_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-billing-live-owner:' || v_owner_id::text, 0));

  SELECT * INTO v_existing
  FROM billing.admin_billing_revisions
  WHERE billing_workspace_id = v_owner_id AND idempotency_key = p_idempotency_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.requested_workspace_id <> p_workspace_id
      OR v_existing.billing_mode <> p_billing_mode
      OR v_existing.snapshot->'request_snapshot' IS DISTINCT FROM p_snapshot THEN
      RAISE EXCEPTION 'billing_operation_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'revision_id', v_existing.id,
      'voucher_code', v_existing.voucher_code,
      'billing_workspace_id', v_owner_id,
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

  PERFORM billing.ensure_workspace_billing_live_reference(v_owner_id);
  SELECT * INTO v_live
  FROM billing.workspace_billing_live_transactions
  WHERE billing_workspace_id = v_owner_id
  FOR UPDATE;

  PERFORM set_config('atlas.admin_billing_operation_write', 'on', true);
  v_payment_id := billing.apply_admin_billing_snapshot(
    p_workspace_id, p_billing_mode, p_snapshot,
    COALESCE(NULLIF(btrim(p_actor_label), ''), 'Platform administrator'),
    COALESCE((p_snapshot->>'record_payment')::boolean, false),
    NULL
  );

  SELECT to_jsonb(owner_config) INTO v_config
  FROM billing.workspace_payment_configurations AS owner_config
  WHERE owner_config.workspace_id = v_owner_id;
  v_snapshot := p_snapshot || jsonb_build_object(
    'configured', true,
    'billing_mode', p_billing_mode,
    'configuration', v_config,
    'payment_transaction_id', v_payment_id,
    'request_snapshot', p_snapshot
  );
  SELECT to_jsonb(workspace_config) INTO v_config
  FROM billing.workspace_payment_configurations AS workspace_config
  WHERE workspace_config.workspace_id = p_workspace_id;
  v_snapshot := v_snapshot || jsonb_build_object('workspace_configuration', v_config);

  v_revision_id := gen_random_uuid();
  LOOP
    v_attempt := v_attempt + 1;
    v_voucher := billing.generate_admin_billing_base_voucher();
    INSERT INTO billing.admin_billing_revisions (
      id, billing_workspace_id, requested_workspace_id, family_id,
      revision_number, base_voucher_code, voucher_code, revision_type,
      billing_mode, snapshot, payment_transaction_id, idempotency_key,
      created_by, created_by_label, created_via
    ) VALUES (
      v_revision_id, v_owner_id, p_workspace_id, v_revision_id, 0,
      v_voucher, v_voucher, 'create', p_billing_mode, v_snapshot,
      v_payment_id, p_idempotency_key, auth.uid(),
      COALESCE(NULLIF(btrim(p_actor_label), ''), 'Platform administrator'),
      'admin-console'
    ) ON CONFLICT (voucher_code) DO NOTHING;
    EXIT WHEN FOUND;
    IF v_attempt >= 10 THEN RAISE EXCEPTION 'billing_voucher_generation_failed' USING ERRCODE = '23505'; END IF;
  END LOOP;

  UPDATE billing.workspace_billing_live_transactions
  SET current_revision_id = v_revision_id,
      revision_version = revision_version + 1,
      updated_at = now(),
      updated_by_label = COALESCE(NULLIF(btrim(p_actor_label), ''), 'Platform administrator')
  WHERE billing_workspace_id = v_owner_id;

  RETURN jsonb_build_object(
    'revision_id', v_revision_id,
    'voucher_code', v_voucher,
    'billing_workspace_id', v_owner_id,
    'current_live', true,
    'payment_transaction_id', v_payment_id,
    'payment_status', CASE WHEN v_payment_id IS NULL THEN 'unpaid' ELSE 'approved' END,
    'idempotent', false
  );
END;
$function$;

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
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_voucher_code), '') IS NULL OR p_expected_live_revision_id IS NULL
    OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object'
    OR NULLIF(btrim(p_reason), '') IS NULL OR length(p_reason) > 1000
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
      OR v_existing.snapshot->'request_snapshot' IS DISTINCT FROM p_snapshot
      OR v_existing.reason IS DISTINCT FROM btrim(p_reason) THEN
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
    v_snapshot, v_current.snapshot, btrim(p_reason), v_linked_payment_id,
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

REVOKE ALL ON FUNCTION public.admin_create_billing_operation(uuid, text, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_billing_operation(uuid, text, jsonb, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.admin_adjust_billing_operation(text, uuid, jsonb, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_billing_operation(text, uuid, jsonb, text, text, text)
  TO service_role;
