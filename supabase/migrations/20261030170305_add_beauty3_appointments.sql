CREATE TABLE IF NOT EXISTS clinics.beauty3_appointments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  age integer NOT NULL,
  marital_status text NOT NULL,
  address text NOT NULL,
  phone_number text NOT NULL,
  procedure_type text NULL,
  procedure_place text NOT NULL,
  procedure_date date NOT NULL,
  appointment_total numeric NOT NULL,
  total_profit numeric NOT NULL,
  currency text NOT NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  CONSTRAINT beauty3_appointments_name_check CHECK (length(trim(name)) > 0),
  CONSTRAINT beauty3_appointments_age_check CHECK (age >= 0),
  CONSTRAINT beauty3_appointments_marital_status_check CHECK (marital_status IN ('single', 'married')),
  CONSTRAINT beauty3_appointments_phone_check CHECK (length(trim(phone_number)) > 0),
  CONSTRAINT beauty3_appointments_procedure_type_check CHECK (
    procedure_type IS NULL OR length(trim(procedure_type)) > 0
  ),
  CONSTRAINT beauty3_appointments_procedure_place_check CHECK (
    procedure_place IN ('sulaymaniyah', 'erbil')
  ),
  CONSTRAINT beauty3_appointments_total_check CHECK (appointment_total >= 0),
  CONSTRAINT beauty3_appointments_profit_check CHECK (total_profit >= 0),
  CONSTRAINT beauty3_appointments_currency_check CHECK (currency IN ('usd', 'eur', 'iqd', 'try'))
);

CREATE INDEX IF NOT EXISTS idx_beauty3_appointments_workspace_procedure_date
  ON clinics.beauty3_appointments (workspace_id, procedure_date DESC, id DESC)
  WHERE is_deleted = false;

ALTER TABLE clinics.beauty3_appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS beauty3_appointments_select ON clinics.beauty3_appointments;
CREATE POLICY beauty3_appointments_select
  ON clinics.beauty3_appointments
  FOR SELECT TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS beauty3_appointments_insert ON clinics.beauty3_appointments;
CREATE POLICY beauty3_appointments_insert
  ON clinics.beauty3_appointments
  FOR INSERT TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS beauty3_appointments_update ON clinics.beauty3_appointments;
CREATE POLICY beauty3_appointments_update
  ON clinics.beauty3_appointments
  FOR UPDATE TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS beauty3_appointments_delete ON clinics.beauty3_appointments;
CREATE POLICY beauty3_appointments_delete
  ON clinics.beauty3_appointments
  FOR DELETE TO authenticated
  USING (workspace_id = public.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON clinics.beauty3_appointments TO authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_workspace_module_plan_access ON clinics.beauty3_appointments;
CREATE TRIGGER enforce_workspace_module_plan_access
  BEFORE INSERT OR UPDATE ON clinics.beauty3_appointments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_module_plan_access('clinical_appointments');

INSERT INTO public.workspace_usage_record_sources (schema_name, table_name, description, enabled)
VALUES ('clinics', 'beauty3_appointments', 'Beauty Center 3 appointment records', true)
ON CONFLICT (schema_name, table_name) DO UPDATE
SET description = EXCLUDED.description,
    enabled = EXCLUDED.enabled,
    updated_at = timezone('utc', now());

SELECT public.install_workspace_storage_usage_triggers();
