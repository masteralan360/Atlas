CREATE TABLE IF NOT EXISTS clinics.beauty3_clients (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  age integer NOT NULL,
  marital_status text NOT NULL,
  address text NOT NULL,
  phone_number text NOT NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  CONSTRAINT beauty3_clients_name_check CHECK (length(trim(name)) > 0),
  CONSTRAINT beauty3_clients_age_check CHECK (age >= 0),
  CONSTRAINT beauty3_clients_marital_status_check CHECK (marital_status IN ('single', 'married')),
  CONSTRAINT beauty3_clients_phone_check CHECK (length(trim(phone_number)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_beauty3_clients_workspace_updated
  ON clinics.beauty3_clients (workspace_id, updated_at DESC, id DESC)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_beauty3_clients_workspace_phone
  ON clinics.beauty3_clients (workspace_id, phone_number)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_beauty3_clients_workspace_name
  ON clinics.beauty3_clients (workspace_id, lower(name), id)
  WHERE is_deleted = false;

ALTER TABLE clinics.beauty3_clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS beauty3_clients_select ON clinics.beauty3_clients;
CREATE POLICY beauty3_clients_select
  ON clinics.beauty3_clients
  FOR SELECT TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS beauty3_clients_insert ON clinics.beauty3_clients;
CREATE POLICY beauty3_clients_insert
  ON clinics.beauty3_clients
  FOR INSERT TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS beauty3_clients_update ON clinics.beauty3_clients;
CREATE POLICY beauty3_clients_update
  ON clinics.beauty3_clients
  FOR UPDATE TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS beauty3_clients_delete ON clinics.beauty3_clients;
CREATE POLICY beauty3_clients_delete
  ON clinics.beauty3_clients
  FOR DELETE TO authenticated
  USING (workspace_id = public.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON clinics.beauty3_clients TO authenticated, service_role;

WITH ranked_appointment_profiles AS (
  SELECT
    appointment.*,
    first_value(id) OVER identity_order AS client_id,
    row_number() OVER latest_profile AS profile_rank
  FROM clinics.beauty3_appointments AS appointment
  WINDOW
    identity_order AS (
      PARTITION BY workspace_id, lower(trim(name)), regexp_replace(phone_number, '[^0-9]', '', 'g')
      ORDER BY id
    ),
    latest_profile AS (
      PARTITION BY workspace_id, lower(trim(name)), regexp_replace(phone_number, '[^0-9]', '', 'g')
      ORDER BY updated_at DESC, id DESC
    )
)
INSERT INTO clinics.beauty3_clients (
  id,
  workspace_id,
  name,
  age,
  marital_status,
  address,
  phone_number,
  created_by,
  created_at,
  updated_at,
  version,
  is_deleted
)
SELECT
  client_id,
  workspace_id,
  name,
  age,
  marital_status,
  address,
  phone_number,
  created_by,
  created_at,
  updated_at,
  1,
  false
FROM ranked_appointment_profiles
WHERE profile_rank = 1
ON CONFLICT (id) DO NOTHING;

ALTER TABLE clinics.beauty3_appointments
  ADD COLUMN IF NOT EXISTS client_id uuid NULL;

UPDATE clinics.beauty3_appointments AS appointment
SET client_id = client.id
FROM clinics.beauty3_clients AS client
WHERE appointment.client_id IS NULL
  AND appointment.workspace_id = client.workspace_id
  AND lower(trim(appointment.name)) = lower(trim(client.name))
  AND regexp_replace(appointment.phone_number, '[^0-9]', '', 'g')
    = regexp_replace(client.phone_number, '[^0-9]', '', 'g');

CREATE INDEX IF NOT EXISTS idx_beauty3_appointments_workspace_client
  ON clinics.beauty3_appointments (workspace_id, client_id, procedure_date DESC, id DESC)
  WHERE is_deleted = false;

ALTER TABLE clinics.beauty3_appointments
  DROP CONSTRAINT IF EXISTS beauty3_appointments_client_workspace_fk,
  ADD CONSTRAINT beauty3_appointments_client_workspace_fk
    FOREIGN KEY (workspace_id, client_id)
    REFERENCES clinics.beauty3_clients (workspace_id, id);

DROP TRIGGER IF EXISTS enforce_workspace_module_plan_access ON clinics.beauty3_clients;
CREATE TRIGGER enforce_workspace_module_plan_access
  BEFORE INSERT OR UPDATE ON clinics.beauty3_clients
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_module_plan_access('clinical_appointments');

INSERT INTO public.workspace_usage_record_sources (schema_name, table_name, description, enabled)
VALUES ('clinics', 'beauty3_clients', 'Beauty Center 3 client profiles', true)
ON CONFLICT (schema_name, table_name) DO UPDATE
SET description = EXCLUDED.description,
    enabled = EXCLUDED.enabled,
    updated_at = timezone('utc', now());

SELECT public.install_workspace_storage_usage_triggers();
