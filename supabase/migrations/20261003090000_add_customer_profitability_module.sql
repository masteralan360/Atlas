-- Customer Profitability is an admin-granted reporting module. Its records
-- attach existing financial sources to a customer, engagement, and vehicle;
-- they do not create ledger entries or payment movements.

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
    ELSE false
  END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_customer_profitability_override_admin_console()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
BEGIN
  IF (
      (TG_OP <> 'INSERT' AND OLD.type = 'module' AND lower(OLD.key) = 'customer_profitability')
      OR (TG_OP <> 'DELETE' AND NEW.type = 'module' AND lower(NEW.key) = 'customer_profitability')
    )
    AND auth.role() IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'Customer Profitability access can only be changed from the platform admin dashboard'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_customer_profitability_override_admin_console
  ON public.workspace_access_overrides;
CREATE TRIGGER enforce_customer_profitability_override_admin_console
  BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_access_overrides
  FOR EACH ROW EXECUTE FUNCTION public.enforce_customer_profitability_override_admin_console();

CREATE OR REPLACE FUNCTION public.customer_profitability_module_allowed(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    WHERE workspace.id = p_workspace_id
      AND workspace.deleted_at IS NULL
      AND public.workspace_module_allowed(p_workspace_id, workspace.plan::text, 'customer_profitability')
  );
$function$;

CREATE TABLE IF NOT EXISTS public.customer_profitability_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  business_partner_id uuid NOT NULL REFERENCES crm.business_partners(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  notes text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS customer_profitability_engagements_workspace_partner_idx
  ON public.customer_profitability_engagements (workspace_id, business_partner_id)
  WHERE COALESCE(is_deleted, false) = false;

CREATE TABLE IF NOT EXISTS public.customer_profitability_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN (
    'sales_order', 'purchase_order', 'expense_item', 'payroll_payment', 'direct_transaction'
  )),
  source_record_id text NOT NULL,
  source_subrecord_id text NOT NULL DEFAULT '',
  financial_kind text NOT NULL CHECK (financial_kind IN ('revenue', 'expense')),
  business_partner_id uuid NOT NULL REFERENCES crm.business_partners(id) ON DELETE RESTRICT,
  engagement_id uuid NULL REFERENCES public.customer_profitability_engagements(id) ON DELETE RESTRICT,
  vehicle_id uuid NULL REFERENCES fleet.fleet_vehicles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_profitability_attributions_source_unique
  ON public.customer_profitability_attributions (
    workspace_id, source_type, source_record_id, source_subrecord_id
  );
CREATE INDEX IF NOT EXISTS customer_profitability_attributions_workspace_partner_idx
  ON public.customer_profitability_attributions (workspace_id, business_partner_id)
  WHERE COALESCE(is_deleted, false) = false;
CREATE INDEX IF NOT EXISTS customer_profitability_attributions_workspace_engagement_idx
  ON public.customer_profitability_attributions (workspace_id, engagement_id)
  WHERE engagement_id IS NOT NULL AND COALESCE(is_deleted, false) = false;

CREATE OR REPLACE FUNCTION public.assert_customer_profitability_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, crm, fleet
AS $function$
DECLARE
  v_engagement_id uuid := NULLIF(to_jsonb(NEW)->>'engagement_id', '')::uuid;
  v_vehicle_id uuid := NULLIF(to_jsonb(NEW)->>'vehicle_id', '')::uuid;
  v_partner_workspace_id uuid;
  v_partner_role text;
  v_engagement_partner_id uuid;
  v_engagement_workspace_id uuid;
  v_vehicle_workspace_id uuid;
BEGIN
  SELECT partner.workspace_id, partner.role
    INTO v_partner_workspace_id, v_partner_role
  FROM crm.business_partners AS partner
  WHERE partner.id = NEW.business_partner_id
    AND COALESCE(partner.is_deleted, false) = false;

  IF v_partner_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'Customer must belong to the same workspace'
      USING ERRCODE = '23514';
  END IF;

  IF v_partner_role NOT IN ('customer', 'both', 'online_customer') THEN
    RAISE EXCEPTION 'Customer profitability links require a customer business partner'
      USING ERRCODE = '23514';
  END IF;

  IF v_engagement_id IS NOT NULL THEN
    SELECT engagement.workspace_id, engagement.business_partner_id
      INTO v_engagement_workspace_id, v_engagement_partner_id
    FROM public.customer_profitability_engagements AS engagement
    WHERE engagement.id = v_engagement_id
      AND COALESCE(engagement.is_deleted, false) = false;

    IF v_engagement_workspace_id IS DISTINCT FROM NEW.workspace_id
       OR v_engagement_partner_id IS DISTINCT FROM NEW.business_partner_id THEN
      RAISE EXCEPTION 'Service contract must belong to the selected customer and workspace'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_vehicle_id IS NOT NULL THEN
    SELECT vehicle.workspace_id
      INTO v_vehicle_workspace_id
    FROM fleet.fleet_vehicles AS vehicle
    WHERE vehicle.id = v_vehicle_id
      AND COALESCE(vehicle.is_deleted, false) = false;

    IF v_vehicle_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Vehicle must belong to the same workspace'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS assert_customer_profitability_engagement_links
  ON public.customer_profitability_engagements;
CREATE TRIGGER assert_customer_profitability_engagement_links
  BEFORE INSERT OR UPDATE OF workspace_id, business_partner_id
  ON public.customer_profitability_engagements
  FOR EACH ROW EXECUTE FUNCTION public.assert_customer_profitability_links();

DROP TRIGGER IF EXISTS assert_customer_profitability_attribution_links
  ON public.customer_profitability_attributions;
CREATE TRIGGER assert_customer_profitability_attribution_links
  BEFORE INSERT OR UPDATE OF workspace_id, business_partner_id, engagement_id, vehicle_id
  ON public.customer_profitability_attributions
  FOR EACH ROW EXECUTE FUNCTION public.assert_customer_profitability_links();

ALTER TABLE public.customer_profitability_engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_profitability_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_profitability_engagements_select
  ON public.customer_profitability_engagements;
CREATE POLICY customer_profitability_engagements_select
  ON public.customer_profitability_engagements
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.customer_profitability_module_allowed(workspace_id)
  );

DROP POLICY IF EXISTS customer_profitability_engagements_write
  ON public.customer_profitability_engagements;
CREATE POLICY customer_profitability_engagements_write
  ON public.customer_profitability_engagements
  FOR ALL TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.customer_profitability_module_allowed(workspace_id)
    AND public.current_user_role() IN ('admin', 'staff')
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.customer_profitability_module_allowed(workspace_id)
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS customer_profitability_attributions_select
  ON public.customer_profitability_attributions;
CREATE POLICY customer_profitability_attributions_select
  ON public.customer_profitability_attributions
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.customer_profitability_module_allowed(workspace_id)
  );

DROP POLICY IF EXISTS customer_profitability_attributions_write
  ON public.customer_profitability_attributions;
CREATE POLICY customer_profitability_attributions_write
  ON public.customer_profitability_attributions
  FOR ALL TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.customer_profitability_module_allowed(workspace_id)
    AND public.current_user_role() IN ('admin', 'staff')
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.customer_profitability_module_allowed(workspace_id)
    AND public.current_user_role() IN ('admin', 'staff')
  );

GRANT SELECT, INSERT, UPDATE ON public.customer_profitability_engagements TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.customer_profitability_attributions TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_plan_has_module(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_profitability_module_allowed(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_customer_profitability_override_admin_console() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_customer_profitability_links() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
