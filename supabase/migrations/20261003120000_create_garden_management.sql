-- Garden Management is an admin-granted-only module. No workspace plan grants it.
CREATE SCHEMA IF NOT EXISTS garden;

CREATE OR REPLACE FUNCTION public.workspace_plan_has_module(p_plan text, p_module text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE lower(coalesce(p_module, ''))
    WHEN 'pos' THEN true
    WHEN 'instant_pos' THEN false
    WHEN 'kds' THEN false
    WHEN 'sales_history' THEN true
    WHEN 'products' THEN true
    WHEN 'services' THEN false
    WHEN 'storages' THEN true
    WHEN 'inventory_transfer' THEN true
    WHEN 'inventory_transactions' THEN true
    WHEN 'stock_adjustments' THEN true
    WHEN 'ledger' THEN true
    WHEN 'payments' THEN true
    WHEN 'payment_accounts' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'cashier_shift_control' THEN false
    WHEN 'direct_transactions' THEN true
    WHEN 'members' THEN true
    WHEN 'business_partners' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'agents' THEN false
    WHEN 'sales_agent_commissions' THEN false
    WHEN 'agent_sales_accounts' THEN false
    WHEN 'post_service' THEN false
    WHEN 'car_rental' THEN false
    WHEN 'customers' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'suppliers' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'orders' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'ecommerce' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'real_estate' THEN false
    WHEN 'activities' THEN false
    WHEN 'currency_exchange' THEN false
    WHEN 'clinical_appointments' THEN false
    WHEN 'loans' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'installments' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'discounts' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'revenue_analytics' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'customer_profitability' THEN false
    WHEN 'team_performance' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'invoice_history' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'accounting' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'hr' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'expenses' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'payroll' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'whatsapp' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'manual_entry' THEN false
    WHEN 'garden_management' THEN false
    ELSE false
  END;
$function$;

GRANT EXECUTE ON FUNCTION public.workspace_plan_has_module(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION garden.module_allowed(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, garden
AS $function$
  SELECT p_workspace_id IS NOT NULL
    AND p_workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.workspaces workspace
      WHERE workspace.id = p_workspace_id
        AND workspace.deleted_at IS NULL
        AND public.workspace_module_allowed(workspace.id, workspace.plan, 'garden_management')
    );
$function$;

REVOKE ALL ON FUNCTION garden.module_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION garden.module_allowed(uuid) TO authenticated, service_role;

CREATE TABLE garden.garden_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  business_partner_id uuid NULL REFERENCES crm.business_partners(id) ON DELETE SET NULL,
  homeowner_name text NOT NULL CHECK (length(btrim(homeowner_name)) > 0),
  homeowner_phone text NULL,
  address text NOT NULL CHECK (length(btrim(address)) > 0),
  city text NULL,
  latitude double precision NULL,
  longitude double precision NULL,
  access_notes text NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('pending', 'synced', 'conflict')),
  last_synced_at timestamptz NULL
);

CREATE TABLE garden.garden_construction_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES garden.garden_sites(id) ON DELETE RESTRICT,
  business_partner_id uuid NULL REFERENCES crm.business_partners(id) ON DELETE SET NULL,
  project_no text NOT NULL CHECK (length(btrim(project_no)) > 0),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  scope text NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'quoted', 'approved', 'in_progress', 'on_hold', 'completed', 'cancelled')),
  quoted_amount numeric(18, 2) NULL CHECK (quoted_amount IS NULL OR quoted_amount >= 0),
  agreed_amount numeric(18, 2) NULL CHECK (agreed_amount IS NULL OR agreed_amount >= 0),
  estimated_cost numeric(18, 2) NULL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  actual_cost numeric(18, 2) NULL CHECK (actual_cost IS NULL OR actual_cost >= 0),
  currency text NOT NULL DEFAULT 'iqd' CHECK (lower(currency) IN ('usd', 'eur', 'iqd', 'try')),
  starts_on date NULL,
  target_completion_on date NULL,
  completed_at timestamptz NULL,
  notes text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('pending', 'synced', 'conflict')),
  last_synced_at timestamptz NULL,
  UNIQUE (workspace_id, project_no)
);

CREATE TABLE garden.garden_maintenance_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES garden.garden_sites(id) ON DELETE RESTRICT,
  business_partner_id uuid NULL REFERENCES crm.business_partners(id) ON DELETE SET NULL,
  contract_no text NOT NULL CHECK (length(btrim(contract_no)) > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on >= starts_on),
  monthly_fee numeric(18, 2) NOT NULL CHECK (monthly_fee >= 0),
  currency text NOT NULL DEFAULT 'iqd' CHECK (lower(currency) IN ('usd', 'eur', 'iqd', 'try')),
  visits_per_month smallint NOT NULL DEFAULT 4 CHECK (visits_per_month BETWEEN 1 AND 31),
  visit_days smallint[] NOT NULL DEFAULT ARRAY[1, 8, 15, 22]::smallint[],
  service_time time NOT NULL DEFAULT '08:00',
  time_zone text NOT NULL DEFAULT 'Asia/Baghdad',
  notes text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('pending', 'synced', 'conflict')),
  last_synced_at timestamptz NULL,
  UNIQUE (workspace_id, contract_no),
  CHECK (cardinality(visit_days) > 0),
  CHECK (0 < ALL(visit_days) AND 31 >= ALL(visit_days))
);

CREATE TABLE garden.garden_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES garden.garden_sites(id) ON DELETE RESTRICT,
  project_id uuid NULL REFERENCES garden.garden_construction_projects(id) ON DELETE SET NULL,
  contract_id uuid NULL REFERENCES garden.garden_maintenance_contracts(id) ON DELETE SET NULL,
  source_key text NULL,
  kind text NOT NULL CHECK (kind IN ('construction', 'maintenance', 'ad_hoc')),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  scheduled_at timestamptz NOT NULL,
  time_zone text NOT NULL DEFAULT 'Asia/Baghdad',
  planned_duration_minutes integer NULL CHECK (planned_duration_minutes IS NULL OR planned_duration_minutes BETWEEN 1 AND 1440),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  outcome text NULL CHECK (outcome IS NULL OR outcome IN ('ok', 'needs_follow_up')),
  route_order integer NOT NULL DEFAULT 1 CHECK (route_order > 0),
  instructions text NULL,
  completed_at timestamptz NULL,
  completed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  completion_note text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('pending', 'synced', 'conflict')),
  last_synced_at timestamptz NULL,
  UNIQUE (workspace_id, source_key)
);

CREATE TABLE garden.garden_job_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES garden.garden_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  user_name_snapshot text NOT NULL CHECK (length(btrim(user_name_snapshot)) > 0),
  route_order integer NOT NULL DEFAULT 1 CHECK (route_order > 0),
  assigned_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  unassigned_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('pending', 'synced', 'conflict')),
  last_synced_at timestamptz NULL
);

CREATE TABLE garden.garden_job_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES garden.garden_jobs(id) ON DELETE CASCADE,
  actor_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  activity_type text NOT NULL CHECK (activity_type IN ('created', 'scheduled', 'rescheduled', 'assigned', 'unassigned', 'started', 'completed', 'reopened', 'cancelled')),
  summary text NOT NULL CHECK (length(btrim(summary)) > 0),
  payload jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('pending', 'synced', 'conflict')),
  last_synced_at timestamptz NULL
);

CREATE INDEX garden_sites_workspace_status_idx ON garden.garden_sites (workspace_id, status) WHERE is_deleted = false;
CREATE INDEX garden_projects_workspace_status_idx ON garden.garden_construction_projects (workspace_id, status, updated_at DESC) WHERE is_deleted = false;
CREATE INDEX garden_contracts_workspace_status_idx ON garden.garden_maintenance_contracts (workspace_id, status, starts_on, ends_on) WHERE is_deleted = false;
CREATE INDEX garden_jobs_workspace_schedule_idx ON garden.garden_jobs (workspace_id, scheduled_at, route_order) WHERE is_deleted = false;
CREATE INDEX garden_jobs_workspace_status_idx ON garden.garden_jobs (workspace_id, status, scheduled_at) WHERE is_deleted = false;
CREATE UNIQUE INDEX garden_job_active_assignment_idx ON garden.garden_job_assignments (workspace_id, job_id, user_id) WHERE unassigned_at IS NULL AND is_deleted = false;
CREATE INDEX garden_job_assignments_user_idx ON garden.garden_job_assignments (workspace_id, user_id, job_id) WHERE unassigned_at IS NULL AND is_deleted = false;
CREATE INDEX garden_job_activity_job_idx ON garden.garden_job_activity (workspace_id, job_id, created_at DESC) WHERE is_deleted = false;

CREATE OR REPLACE FUNCTION garden.user_is_assigned(p_workspace_id uuid, p_job_id uuid, p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = garden, public
AS $function$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM garden.garden_job_assignments assignment
    WHERE assignment.workspace_id = p_workspace_id
      AND assignment.job_id = p_job_id
      AND assignment.user_id = p_user_id
      AND assignment.unassigned_at IS NULL
      AND assignment.is_deleted = false
  );
$function$;

REVOKE ALL ON FUNCTION garden.user_is_assigned(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION garden.user_is_assigned(uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION garden.enforce_workspace_relations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = garden, public
AS $function$
DECLARE
  related_workspace uuid;
  related_site uuid;
BEGIN
  IF TG_TABLE_NAME IN ('garden_sites', 'garden_construction_projects', 'garden_maintenance_contracts')
    AND NEW.business_partner_id IS NOT NULL THEN
    SELECT workspace_id INTO related_workspace
    FROM crm.business_partners
    WHERE id = NEW.business_partner_id;
    IF related_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Garden business partner must belong to the same workspace' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('garden_construction_projects', 'garden_maintenance_contracts') THEN
    SELECT workspace_id INTO related_workspace FROM garden.garden_sites WHERE id = NEW.site_id;
    IF related_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Garden site must belong to the same workspace' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'garden_jobs' THEN
    SELECT workspace_id INTO related_workspace FROM garden.garden_sites WHERE id = NEW.site_id;
    IF related_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Garden site must belong to the same workspace' USING ERRCODE = '23514';
    END IF;
    IF NEW.project_id IS NOT NULL THEN
      SELECT workspace_id, site_id INTO related_workspace, related_site FROM garden.garden_construction_projects WHERE id = NEW.project_id;
      IF related_workspace IS DISTINCT FROM NEW.workspace_id OR related_site IS DISTINCT FROM NEW.site_id THEN
        RAISE EXCEPTION 'Garden project must belong to the same workspace and site' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.contract_id IS NOT NULL THEN
      SELECT workspace_id, site_id INTO related_workspace, related_site FROM garden.garden_maintenance_contracts WHERE id = NEW.contract_id;
      IF related_workspace IS DISTINCT FROM NEW.workspace_id OR related_site IS DISTINCT FROM NEW.site_id THEN
        RAISE EXCEPTION 'Garden contract must belong to the same workspace and site' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME IN ('garden_job_assignments', 'garden_job_activity') THEN
    SELECT workspace_id INTO related_workspace FROM garden.garden_jobs WHERE id = NEW.job_id;
    IF related_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Garden job must belong to the same workspace' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'garden_job_assignments' AND NOT EXISTS (
      SELECT 1 FROM public.profiles profile
      WHERE profile.id = NEW.user_id AND profile.workspace_id = NEW.workspace_id AND profile.role IN ('admin', 'staff')
    ) THEN
      RAISE EXCEPTION 'Assigned staff member must belong to the same workspace' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER garden_projects_workspace_guard BEFORE INSERT OR UPDATE ON garden.garden_construction_projects FOR EACH ROW EXECUTE FUNCTION garden.enforce_workspace_relations();
CREATE TRIGGER garden_contracts_workspace_guard BEFORE INSERT OR UPDATE ON garden.garden_maintenance_contracts FOR EACH ROW EXECUTE FUNCTION garden.enforce_workspace_relations();
CREATE TRIGGER garden_sites_workspace_guard BEFORE INSERT OR UPDATE ON garden.garden_sites FOR EACH ROW EXECUTE FUNCTION garden.enforce_workspace_relations();
CREATE TRIGGER garden_jobs_workspace_guard BEFORE INSERT OR UPDATE ON garden.garden_jobs FOR EACH ROW EXECUTE FUNCTION garden.enforce_workspace_relations();
CREATE TRIGGER garden_assignments_workspace_guard BEFORE INSERT OR UPDATE ON garden.garden_job_assignments FOR EACH ROW EXECUTE FUNCTION garden.enforce_workspace_relations();
CREATE TRIGGER garden_activity_workspace_guard BEFORE INSERT OR UPDATE ON garden.garden_job_activity FOR EACH ROW EXECUTE FUNCTION garden.enforce_workspace_relations();
REVOKE ALL ON FUNCTION garden.enforce_workspace_relations() FROM PUBLIC;

CREATE OR REPLACE FUNCTION garden.guard_staff_job_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = garden, public, auth
AS $function$
BEGIN
  IF public.current_user_role() = 'admin' OR auth.role() = 'service_role' THEN RETURN NEW; END IF;

  IF public.current_user_role() <> 'staff'
    OR NOT garden.user_is_assigned(OLD.workspace_id, OLD.id, auth.uid())
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
    OR NEW.source_key IS DISTINCT FROM OLD.source_key
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
    OR NEW.time_zone IS DISTINCT FROM OLD.time_zone
    OR NEW.planned_duration_minutes IS DISTINCT FROM OLD.planned_duration_minutes
    OR NEW.route_order IS DISTINCT FROM OLD.route_order
    OR NEW.instructions IS DISTINCT FROM OLD.instructions
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.is_deleted IS DISTINCT FROM OLD.is_deleted
  THEN
    RAISE EXCEPTION 'Staff may only update completion status for assigned garden jobs' USING ERRCODE = '42501';
  END IF;

  IF NEW.status NOT IN ('in_progress', 'completed')
    OR OLD.status IN ('completed', 'cancelled')
    OR (NEW.status = 'in_progress' AND NEW.outcome IS NOT NULL)
    OR (NEW.status = 'completed' AND (NEW.outcome IS NULL OR NEW.completed_at IS NULL OR NEW.completed_by IS DISTINCT FROM auth.uid()))
    OR (NEW.status = 'in_progress' AND (NEW.completed_at IS NOT NULL OR NEW.completed_by IS NOT NULL OR NEW.completion_note IS NOT NULL))
  THEN
    RAISE EXCEPTION 'Invalid garden job status update' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER garden_jobs_staff_update_guard BEFORE UPDATE ON garden.garden_jobs FOR EACH ROW EXECUTE FUNCTION garden.guard_staff_job_updates();
REVOKE ALL ON FUNCTION garden.guard_staff_job_updates() FROM PUBLIC;

ALTER TABLE garden.garden_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE garden.garden_construction_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE garden.garden_maintenance_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE garden.garden_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE garden.garden_job_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE garden.garden_job_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY garden_sites_admin_all ON garden.garden_sites FOR ALL TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id))
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id));
CREATE POLICY garden_sites_assigned_staff_read ON garden.garden_sites FOR SELECT TO authenticated
  USING (garden.module_allowed(workspace_id) AND public.current_user_role() = 'staff' AND EXISTS (
    SELECT 1 FROM garden.garden_jobs job WHERE job.workspace_id = garden_sites.workspace_id AND job.site_id = garden_sites.id
      AND job.is_deleted = false AND garden.user_is_assigned(job.workspace_id, job.id, auth.uid())
  ));

CREATE POLICY garden_projects_admin_all ON garden.garden_construction_projects FOR ALL TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id))
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id));
CREATE POLICY garden_contracts_admin_all ON garden.garden_maintenance_contracts FOR ALL TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id))
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id));

CREATE POLICY garden_jobs_admin_all ON garden.garden_jobs FOR ALL TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id))
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id));
CREATE POLICY garden_jobs_assigned_staff_read ON garden.garden_jobs FOR SELECT TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'staff' AND garden.module_allowed(workspace_id) AND garden.user_is_assigned(workspace_id, id, auth.uid()));
CREATE POLICY garden_jobs_assigned_staff_update ON garden.garden_jobs FOR UPDATE TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'staff' AND garden.module_allowed(workspace_id) AND garden.user_is_assigned(workspace_id, id, auth.uid()))
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'staff' AND garden.module_allowed(workspace_id) AND garden.user_is_assigned(workspace_id, id, auth.uid()));

CREATE POLICY garden_assignments_admin_all ON garden.garden_job_assignments FOR ALL TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id))
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id));
CREATE POLICY garden_assignments_assignee_read ON garden.garden_job_assignments FOR SELECT TO authenticated
  USING (workspace_id = public.current_workspace_id() AND user_id = auth.uid() AND garden.module_allowed(workspace_id));

CREATE POLICY garden_activity_admin_all ON garden.garden_job_activity FOR ALL TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id))
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin' AND garden.module_allowed(workspace_id));
CREATE POLICY garden_activity_assigned_read ON garden.garden_job_activity FOR SELECT TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'staff' AND garden.module_allowed(workspace_id) AND garden.user_is_assigned(workspace_id, job_id, auth.uid()));
CREATE POLICY garden_activity_assigned_insert ON garden.garden_job_activity FOR INSERT TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'staff' AND actor_user_id = auth.uid() AND garden.module_allowed(workspace_id) AND garden.user_is_assigned(workspace_id, job_id, auth.uid()));

GRANT USAGE ON SCHEMA garden TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA garden TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA garden TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_garden_management_override_admin_console()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
BEGIN
  IF (
    (TG_OP <> 'INSERT' AND OLD.type = 'module' AND lower(OLD.key) = 'garden_management')
    OR (TG_OP <> 'DELETE' AND NEW.type = 'module' AND lower(NEW.key) = 'garden_management')
  ) AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Garden Management access can only be changed from the platform admin dashboard' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_garden_management_override_admin_console ON public.workspace_access_overrides;
CREATE TRIGGER enforce_garden_management_override_admin_console
  BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_access_overrides
  FOR EACH ROW EXECUTE FUNCTION public.enforce_garden_management_override_admin_console();
REVOKE ALL ON FUNCTION public.enforce_garden_management_override_admin_console() FROM PUBLIC;

ALTER TABLE notifications.workspace_disabled_types
  DROP CONSTRAINT IF EXISTS notifications_workspace_disabled_types_type_check;
ALTER TABLE notifications.workspace_disabled_types
  ADD CONSTRAINT notifications_workspace_disabled_types_type_check CHECK (notification_type IN (
    'marketplace_order_pending', 'order_approval_request', 'order_approval_approved',
    'loan_installment_overdue', 'expense_item_overdue', 'payroll_overdue', 'inventory_low_stock',
    'garden_job_assigned', 'garden_job_rescheduled', 'garden_job_completed'
  ));

CREATE OR REPLACE FUNCTION public.set_workspace_notification_type_disabled(p_notification_type text, p_disabled boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_notification_type text := NULLIF(BTRIM(COALESCE(p_notification_type, '')), '');
BEGIN
  IF v_workspace_id IS NULL OR public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'notification_settings_admin_required' USING ERRCODE = '42501';
  END IF;
  IF v_notification_type NOT IN (
    'marketplace_order_pending', 'order_approval_request', 'order_approval_approved',
    'loan_installment_overdue', 'expense_item_overdue', 'payroll_overdue', 'inventory_low_stock',
    'garden_job_assigned', 'garden_job_rescheduled', 'garden_job_completed'
  ) THEN
    RAISE EXCEPTION 'unsupported_notification_type' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_disabled, true) THEN
    INSERT INTO notifications.workspace_disabled_types (workspace_id, notification_type, disabled_by)
    VALUES (v_workspace_id, v_notification_type, auth.uid())
    ON CONFLICT (workspace_id, notification_type) DO UPDATE SET disabled_by = EXCLUDED.disabled_by, updated_at = now();
  ELSE
    DELETE FROM notifications.workspace_disabled_types WHERE workspace_id = v_workspace_id AND notification_type = v_notification_type;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION garden.notify_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = garden, public, notifications
AS $function$
DECLARE
  job_row garden.garden_jobs%ROWTYPE;
  site_name text;
  site_address text;
BEGIN
  IF NEW.unassigned_at IS NOT NULL OR NEW.is_deleted THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
    AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
    AND NEW.unassigned_at IS NOT DISTINCT FROM OLD.unassigned_at
    AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted
    AND NEW.version IS NOT DISTINCT FROM OLD.version THEN
    RETURN NEW;
  END IF;
  SELECT * INTO job_row FROM garden.garden_jobs WHERE id = NEW.job_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT name, address INTO site_name, site_address FROM garden.garden_sites WHERE id = job_row.site_id;
  PERFORM public.upsert_notification_event(
    NEW.workspace_id,
    NEW.user_id,
    'garden_job_assigned',
    job_row.id::text || ':' || NEW.version::text,
    timezone(job_row.time_zone, job_row.scheduled_at)::date,
    jsonb_build_object(
      'title', 'Garden job assigned',
      'body', job_row.title || ' · ' || site_name || ' · ' || to_char(job_row.scheduled_at, 'YYYY-MM-DD HH24:MI'),
      'route', '/garden',
      'action_label', 'Open job',
      'scope', 'user',
      'priority', 'normal',
      'job_id', job_row.id,
      'site_id', job_row.site_id,
      'job_title', job_row.title,
      'site_name', site_name,
      'site_address', site_address,
      'scheduled_at', to_char(job_row.scheduled_at, 'YYYY-MM-DD HH24:MI')
    )
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER garden_assignment_notification AFTER INSERT OR UPDATE OF unassigned_at, is_deleted ON garden.garden_job_assignments
  FOR EACH ROW WHEN (NEW.unassigned_at IS NULL AND NEW.is_deleted = false)
  EXECUTE FUNCTION garden.notify_assignment();

CREATE OR REPLACE FUNCTION garden.notify_job_schedule_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = garden, public, notifications
AS $function$
DECLARE
  assignment_row record;
  site_name text;
  site_address text;
BEGIN
  IF NEW.scheduled_at IS NOT DISTINCT FROM OLD.scheduled_at
    AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id THEN
    RETURN NEW;
  END IF;
  SELECT name, address INTO site_name, site_address FROM garden.garden_sites WHERE id = NEW.site_id;
  FOR assignment_row IN
    SELECT user_id, id FROM garden.garden_job_assignments
    WHERE workspace_id = NEW.workspace_id AND job_id = NEW.id AND unassigned_at IS NULL AND is_deleted = false
  LOOP
    PERFORM public.upsert_notification_event(
      NEW.workspace_id,
      assignment_row.user_id,
      'garden_job_rescheduled',
      NEW.id::text || ':' || NEW.version::text || ':' || assignment_row.id::text,
      timezone(NEW.time_zone, NEW.scheduled_at)::date,
      jsonb_build_object(
        'title', 'Garden job rescheduled',
        'body', NEW.title || ' · ' || site_name || ' · ' || to_char(NEW.scheduled_at, 'YYYY-MM-DD HH24:MI'),
        'route', '/garden',
        'action_label', 'Open job',
        'scope', 'user',
        'priority', 'normal',
        'job_id', NEW.id,
        'site_id', NEW.site_id,
        'job_title', NEW.title,
        'site_name', site_name,
        'site_address', site_address,
        'scheduled_at', to_char(NEW.scheduled_at, 'YYYY-MM-DD HH24:MI')
      )
    );
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER garden_job_schedule_notification AFTER UPDATE OF scheduled_at, site_id ON garden.garden_jobs
  FOR EACH ROW EXECUTE FUNCTION garden.notify_job_schedule_change();

CREATE OR REPLACE FUNCTION garden.notify_job_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = garden, public, notifications
AS $function$
DECLARE
  admin_row record;
  site_name text;
  site_address text;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;
  SELECT name, address INTO site_name, site_address FROM garden.garden_sites WHERE id = NEW.site_id;
  FOR admin_row IN
    SELECT id FROM public.profiles WHERE workspace_id = NEW.workspace_id AND role = 'admin'
  LOOP
    PERFORM public.upsert_notification_event(
      NEW.workspace_id,
      admin_row.id,
      'garden_job_completed',
      NEW.id::text || ':' || NEW.version::text,
      timezone(NEW.time_zone, NEW.scheduled_at)::date,
      jsonb_build_object(
        'title', 'Garden job completed',
        'body', NEW.title || ' · ' || site_name || ' · ' || COALESCE(NEW.outcome, 'ok'),
        'route', '/garden',
        'action_label', 'Open job',
        'scope', 'user',
        'priority', 'normal',
        'job_id', NEW.id,
        'site_id', NEW.site_id,
        'job_title', NEW.title,
        'site_name', site_name,
        'site_address', site_address,
        'scheduled_at', to_char(NEW.scheduled_at, 'YYYY-MM-DD HH24:MI'),
        'outcome', NEW.outcome
      )
    );
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER garden_job_completion_notification AFTER UPDATE OF status ON garden.garden_jobs
  FOR EACH ROW EXECUTE FUNCTION garden.notify_job_completion();

REVOKE ALL ON FUNCTION garden.notify_assignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION garden.notify_job_schedule_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION garden.notify_job_completion() FROM PUBLIC;

DO $publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE garden.garden_jobs; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE garden.garden_job_assignments; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END;
$publication$;

ALTER ROLE authenticator SET pgrst.db_schemas =
  'public, graphql_public, budget, crm, real_estate, activities, fx, clinics, fleet, car_rental, delivery, payment_accounts, garden';

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
