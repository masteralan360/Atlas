CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.siva_public_visit_rate_limits (
  rate_limit_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE private.siva_public_visit_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_siva_public_visit_rate_limits_updated
  ON private.siva_public_visit_rate_limits (updated_at);

REVOKE ALL ON TABLE private.siva_public_visit_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE private.siva_public_visit_rate_limits TO service_role;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE OR REPLACE FUNCTION public.consume_siva_public_visit_rate_limit(p_rate_limit_key text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  v_request_count integer;
  v_now timestamptz := now();
BEGIN
  IF p_rate_limit_key IS NULL OR p_rate_limit_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_rate_limit_key' USING ERRCODE = '22023';
  END IF;

  DELETE FROM private.siva_public_visit_rate_limits
  WHERE updated_at < v_now - interval '2 days';

  INSERT INTO private.siva_public_visit_rate_limits AS limits (
    rate_limit_key,
    window_started_at,
    request_count,
    updated_at
  )
  VALUES (p_rate_limit_key, v_now, 1, v_now)
  ON CONFLICT (rate_limit_key) DO UPDATE
  SET window_started_at = CASE
        WHEN limits.window_started_at <= v_now - interval '1 hour' THEN v_now
        ELSE limits.window_started_at
      END,
      request_count = CASE
        WHEN limits.window_started_at <= v_now - interval '1 hour' THEN 1
        ELSE limits.request_count + 1
      END,
      updated_at = v_now
  RETURNING request_count INTO v_request_count;

  RETURN v_request_count <= 12;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_siva_public_beauty3_visit(p_visit jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  v_workspace_id constant uuid := '903503d2-cb83-49b8-9243-3f175f55b389';
  v_workspace_currency text;
  v_currency text;
  v_name text;
  v_age integer;
  v_marital_status text;
  v_address text;
  v_phone_number text;
  v_procedure_types text[];
  v_procedure_type text;
  v_procedure_type_other text;
  v_procedure_place text;
  v_procedure_date date;
  v_appointment_total numeric;
  v_total_profit numeric;
  v_client_id uuid := gen_random_uuid();
  v_appointment_id uuid := gen_random_uuid();
  v_procedure_count integer;
  v_unique_procedure_count integer;
BEGIN
  IF p_visit IS NULL OR jsonb_typeof(p_visit) <> 'object' THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;

  SELECT lower(workspace.default_currency::text)
  INTO v_workspace_currency
  FROM public.workspaces AS workspace
  WHERE workspace.id = v_workspace_id
    AND workspace.deleted_at IS NULL;

  IF v_workspace_currency IS NULL OR v_workspace_currency NOT IN ('usd', 'eur', 'iqd', 'try') THEN
    RAISE EXCEPTION 'workspace_unavailable' USING ERRCODE = '22023';
  END IF;

  v_name := btrim(coalesce(p_visit->>'name', ''));
  v_address := btrim(coalesce(p_visit->>'address', ''));
  v_phone_number := btrim(coalesce(p_visit->>'phoneNumber', ''));
  v_marital_status := p_visit->>'maritalStatus';
  v_procedure_place := p_visit->>'procedurePlace';
  v_procedure_type_other := nullif(btrim(coalesce(p_visit->>'procedureTypeOther', '')), '');
  v_currency := lower(coalesce(p_visit->>'currency', ''));

  IF v_name = '' OR length(v_name) > 160
    OR v_address = '' OR length(v_address) > 500
    OR v_phone_number = '' OR length(v_phone_number) > 50
    OR v_marital_status IS NULL OR v_marital_status NOT IN ('single', 'married')
    OR v_procedure_place IS NULL OR v_procedure_place NOT IN ('sulaymaniyah', 'erbil')
    OR v_currency <> v_workspace_currency
  THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;

  v_age := nullif(p_visit->>'age', '')::integer;
  IF v_age IS NULL OR v_age < 0 OR v_age > 150 THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;

  IF coalesce(jsonb_typeof(p_visit->'procedureTypes'), '') <> 'array' THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;
  v_procedure_count := jsonb_array_length(p_visit->'procedureTypes');
  IF v_procedure_count < 1 OR v_procedure_count > 20 THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(btrim(element.value)), count(*), count(DISTINCT btrim(element.value))
  INTO v_procedure_types, v_procedure_count, v_unique_procedure_count
  FROM jsonb_array_elements_text(p_visit->'procedureTypes') AS element(value);

  IF v_procedure_count = 0 OR v_procedure_count <> v_unique_procedure_count
    OR array_position(v_procedure_types, '') IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM unnest(v_procedure_types) AS selected(value)
      WHERE length(selected.value) > 180
        OR (
          selected.value NOT IN (
            'other',
            'builtin:dermal_filler',
            'builtin:botox',
            'builtin:mesotherapy',
            'builtin:skin_treatment',
            'builtin:device_based_treatments',
            'builtin:plasma_treatment'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM clinics.clinical_presets AS preset
            WHERE preset.workspace_id = v_workspace_id
              AND preset.category = 'beauty3_procedure'
              AND preset.name = selected.value
              AND preset.is_active = true
              AND preset.is_deleted = false
          )
        )
    )
  THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;

  v_procedure_type := p_visit->>'procedureType';
  IF v_procedure_type IS DISTINCT FROM v_procedure_types[1]
    OR (array_position(v_procedure_types, 'other') IS NOT NULL AND v_procedure_type_other IS NULL)
    OR (array_position(v_procedure_types, 'other') IS NULL AND v_procedure_type_other IS NOT NULL)
  THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;
  IF v_procedure_type_other IS NOT NULL AND length(v_procedure_type_other) > 180 THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;

  IF coalesce(p_visit->>'procedureDate', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;
  v_procedure_date := (p_visit->>'procedureDate')::date;

  v_appointment_total := (p_visit->>'appointmentTotal')::numeric;
  v_total_profit := (p_visit->>'totalProfit')::numeric;
  IF v_appointment_total IS NULL OR v_total_profit IS NULL
    OR v_appointment_total < 0 OR v_appointment_total > 999999999999999
    OR v_total_profit < 0 OR v_total_profit > 999999999999999
  THEN
    RAISE EXCEPTION 'invalid_visit' USING ERRCODE = '22023';
  END IF;

  INSERT INTO clinics.beauty3_clients (
    id, workspace_id, name, age, marital_status, address, phone_number,
    created_by, version, is_deleted
  ) VALUES (
    v_client_id, v_workspace_id, v_name, v_age, v_marital_status, v_address, v_phone_number,
    NULL, 1, false
  );

  INSERT INTO clinics.beauty3_appointments (
    id, workspace_id, client_id, name, age, marital_status, address, phone_number,
    procedure_type, procedure_types, procedure_type_other, procedure_place, procedure_date,
    appointment_total, total_profit, currency, created_by, version, is_deleted
  ) VALUES (
    v_appointment_id, v_workspace_id, v_client_id, v_name, v_age, v_marital_status, v_address, v_phone_number,
    v_procedure_type, v_procedure_types, v_procedure_type_other, v_procedure_place, v_procedure_date,
    v_appointment_total, v_total_profit, v_workspace_currency, NULL, 1, false
  );

  RETURN v_appointment_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.consume_siva_public_visit_rate_limit(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_siva_public_beauty3_visit(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_siva_public_visit_rate_limit(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_siva_public_beauty3_visit(jsonb) TO service_role;
