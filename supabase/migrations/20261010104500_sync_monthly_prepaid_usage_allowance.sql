CREATE OR REPLACE FUNCTION billing.sync_monthly_prepaid_usage_allowance(
  p_workspace_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_owner_id uuid := public.workspace_usage_owner_id(p_workspace_id);
  v_configuration billing.workspace_payment_configurations%ROWTYPE;
  v_limit public.workspace_usage_limits%ROWTYPE;
  v_limit_bytes numeric;
  v_saved_state jsonb;
  v_managed_notes text;
  v_has_limit boolean;
  v_marker CONSTANT text := '[atlas:monthly-prepaid-usage-limit]';
BEGIN
  IF v_owner_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_configuration
  FROM billing.workspace_payment_configurations
  WHERE workspace_id = v_owner_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_limit
  FROM public.workspace_usage_limits
  WHERE workspace_id = v_owner_id
  FOR UPDATE;
  v_has_limit := FOUND;

  IF v_configuration.usage_enabled
    AND NOT COALESCE(v_configuration.payg_enabled, false)
    AND COALESCE(v_configuration.billing_interval, 'monthly') = 'monthly'
    AND COALESCE(v_configuration.gb_per_payment, 0) > 0 THEN
    v_limit_bytes := v_configuration.gb_per_payment::numeric * 1000000000::numeric;
    IF trunc(v_limit_bytes) <> v_limit_bytes
      OR v_limit_bytes > 9223372036854775807::numeric THEN
      RAISE EXCEPTION 'workspace_payment_gb_value_out_of_range'
        USING ERRCODE = '22003';
    END IF;

    IF v_has_limit AND v_limit.notes LIKE (v_marker || E'\n%') THEN
      v_managed_notes := v_limit.notes;
    ELSE
      v_saved_state := jsonb_build_object(
        'had_limit_row', v_has_limit,
        'monthly_data_transfer_limit_bytes', CASE
          WHEN v_has_limit THEN v_limit.monthly_data_transfer_limit_bytes::text
          ELSE NULL
        END,
        'tracking_only', CASE WHEN v_has_limit THEN v_limit.tracking_only ELSE NULL END,
        'notes', CASE WHEN v_has_limit THEN v_limit.notes ELSE NULL END
      );
      v_managed_notes := v_marker || E'\n' || v_saved_state::text;
    END IF;

    INSERT INTO public.workspace_usage_limits (
      workspace_id,
      monthly_data_transfer_limit_bytes,
      tracking_only,
      notes
    ) VALUES (
      v_owner_id,
      v_limit_bytes::bigint,
      false,
      v_managed_notes
    )
    ON CONFLICT (workspace_id) DO UPDATE SET
      monthly_data_transfer_limit_bytes = EXCLUDED.monthly_data_transfer_limit_bytes,
      tracking_only = false,
      notes = v_managed_notes,
      updated_at = now();

    PERFORM public.ensure_workspace_usage_row(v_owner_id);
    PERFORM public.reconcile_workspace_usage_limit_lock(v_owner_id);
    RETURN;
  END IF;

  IF v_has_limit AND v_limit.notes LIKE (v_marker || E'\n%') THEN
    v_saved_state := substring(v_limit.notes FROM char_length(v_marker) + 2)::jsonb;

    IF COALESCE((v_saved_state->>'had_limit_row')::boolean, false) THEN
      UPDATE public.workspace_usage_limits
      SET
        monthly_data_transfer_limit_bytes = NULLIF(
          v_saved_state->>'monthly_data_transfer_limit_bytes', ''
        )::bigint,
        tracking_only = (v_saved_state->>'tracking_only')::boolean,
        notes = NULLIF(v_saved_state->>'notes', ''),
        updated_at = now()
      WHERE workspace_id = v_owner_id;
    ELSIF v_limit.storage_unit_limit IS NULL THEN
      DELETE FROM public.workspace_usage_limits
      WHERE workspace_id = v_owner_id;
    ELSE
      UPDATE public.workspace_usage_limits
      SET
        monthly_data_transfer_limit_bytes = NULL,
        tracking_only = false,
        notes = NULL,
        updated_at = now()
      WHERE workspace_id = v_owner_id;
    END IF;

    PERFORM public.ensure_workspace_usage_row(v_owner_id);
    PERFORM public.reconcile_workspace_usage_limit_lock(v_owner_id);
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION billing.sync_monthly_prepaid_usage_allowance(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION billing.sync_monthly_prepaid_usage_allowance_from_configuration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
BEGIN
  PERFORM billing.sync_monthly_prepaid_usage_allowance(NEW.workspace_id);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION billing.sync_monthly_prepaid_usage_allowance_from_configuration()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_monthly_prepaid_usage_allowance_on_configuration
  ON billing.workspace_payment_configurations;
CREATE TRIGGER sync_monthly_prepaid_usage_allowance_on_configuration
AFTER INSERT OR UPDATE OF usage_enabled, payg_enabled, billing_interval, gb_per_payment
ON billing.workspace_payment_configurations
FOR EACH ROW
EXECUTE FUNCTION billing.sync_monthly_prepaid_usage_allowance_from_configuration();

-- The configured value for Atlas was entered as 15,000 even though the
-- requested allowance is 15 GB. Correct only this known workspace family and
-- only while its active configuration still matches the values just applied.
DO $migration$
DECLARE
  v_owner_id uuid;
BEGIN
  SELECT workspace_row.id INTO v_owner_id
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.code = 'P5TQ-B9RT'
    AND workspace_row.name = 'Atlas'
    AND workspace_row.id = public.workspace_usage_owner_id(workspace_row.id)
    AND workspace_row.deleted_at IS NULL
  LIMIT 1;

  IF v_owner_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM billing.workspace_payment_configurations AS owner_config
      WHERE owner_config.workspace_id = v_owner_id
        AND owner_config.usage_enabled = true
        AND owner_config.payg_enabled = false
        AND owner_config.billing_interval = 'monthly'
        AND owner_config.subscription_amount = 10000
        AND owner_config.gb_per_payment = 15000
    ) THEN
    PERFORM set_config('atlas.trusted_workspace_payment_family_mode_update', 'on', true);
    UPDATE billing.workspace_payment_configurations AS family_config
    SET
      gb_per_payment = 15,
      updated_by_label = 'Platform administrator',
      updated_via = 'monthly-prepaid-allowance-correction',
      updated_at = now()
    WHERE public.workspace_usage_owner_id(family_config.workspace_id) = v_owner_id
      AND family_config.usage_enabled = true
      AND family_config.payg_enabled = false
      AND family_config.billing_interval = 'monthly'
      AND family_config.subscription_amount = 10000
      AND family_config.gb_per_payment = 15000;
  END IF;
END;
$migration$;

-- Materialize the active configured allowance for every source workspace. The
-- usage counter is shared by each source and its branches.
DO $migration$
DECLARE
  v_owner_id uuid;
BEGIN
  FOR v_owner_id IN
    SELECT configuration_row.workspace_id
    FROM billing.workspace_payment_configurations AS configuration_row
    WHERE configuration_row.workspace_id = public.workspace_usage_owner_id(configuration_row.workspace_id)
      AND configuration_row.usage_enabled = true
      AND COALESCE(configuration_row.payg_enabled, false) = false
      AND COALESCE(configuration_row.billing_interval, 'monthly') = 'monthly'
      AND COALESCE(configuration_row.gb_per_payment, 0) > 0
  LOOP
    PERFORM billing.sync_monthly_prepaid_usage_allowance(v_owner_id);
  END LOOP;
END;
$migration$;
