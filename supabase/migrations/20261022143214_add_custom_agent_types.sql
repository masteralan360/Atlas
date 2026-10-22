CREATE TABLE IF NOT EXISTS crm.agent_types (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  mode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced',
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  CONSTRAINT agent_types_pkey PRIMARY KEY (id),
  CONSTRAINT agent_types_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_types_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT agent_types_name_check CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  CONSTRAINT agent_types_mode_check CHECK (mode IN ('driver', 'courier', 'field_agent', 'seller'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_crm_agent_types_workspace_name_active
  ON crm.agent_types (workspace_id, lower(BTRIM(name)))
  WHERE COALESCE(is_deleted, false) = false;

CREATE INDEX IF NOT EXISTS idx_crm_agent_types_workspace_mode
  ON crm.agent_types (workspace_id, mode)
  WHERE COALESCE(is_deleted, false) = false;

ALTER TABLE crm.agents
  ADD COLUMN IF NOT EXISTS custom_agent_type_id uuid NULL;

ALTER TABLE crm.agents
  DROP CONSTRAINT IF EXISTS agents_type_check;

ALTER TABLE crm.agents
  ADD CONSTRAINT agents_type_check
  CHECK (agent_type IN ('driver', 'field_agent', 'courier', 'seller'));

ALTER TABLE crm.agents
  DROP CONSTRAINT IF EXISTS agents_custom_type_workspace_fkey;

ALTER TABLE crm.agents
  ADD CONSTRAINT agents_custom_type_workspace_fkey
  FOREIGN KEY (workspace_id, custom_agent_type_id)
  REFERENCES crm.agent_types(workspace_id, id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_crm_agents_workspace_custom_type
  ON crm.agents (workspace_id, custom_agent_type_id)
  WHERE custom_agent_type_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.current_user_has_workspace_permission(
  p_workspace_id uuid,
  p_permission_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND p_workspace_id = (SELECT public.current_workspace_id())
    AND EXISTS (
      SELECT 1
      FROM public.workspace_permissions AS permission
      WHERE permission.workspace_id = p_workspace_id
        AND permission.user_uuid = (SELECT auth.uid())
        AND permission.key = p_permission_key
    );
$function$;

REVOKE ALL ON FUNCTION public.current_user_has_workspace_permission(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_has_workspace_permission(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_crm_agent_custom_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, crm
AS $function$
DECLARE
  v_mode text;
  v_is_deleted boolean;
BEGIN
  IF NEW.custom_agent_type_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE((SELECT auth.role()), '') <> 'service_role'
    AND (
      (
        public.current_user_role() IS DISTINCT FROM 'admin'
        AND public.current_user_role() IS DISTINCT FROM 'staff'
      )
      OR (
        public.current_user_role() IS DISTINCT FROM 'admin'
        AND NOT public.current_user_has_workspace_permission(NEW.workspace_id, 'agents.access')
      )
    )
  THEN
    RAISE EXCEPTION 'Agents access permission is required to assign a custom agent type'
      USING ERRCODE = '42501';
  END IF;

  SELECT agent_type.mode, COALESCE(agent_type.is_deleted, false)
    INTO v_mode, v_is_deleted
  FROM crm.agent_types AS agent_type
  WHERE agent_type.id = NEW.custom_agent_type_id
    AND agent_type.workspace_id = NEW.workspace_id;

  IF v_mode IS NULL OR v_is_deleted THEN
    RAISE EXCEPTION 'Custom agent type must be active and belong to the agent workspace'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.agent_type IS DISTINCT FROM v_mode THEN
    RAISE EXCEPTION 'Agent mode must match the selected custom agent type'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_crm_agent_custom_type ON crm.agents;
CREATE TRIGGER enforce_crm_agent_custom_type
  BEFORE INSERT OR UPDATE OF workspace_id, agent_type, custom_agent_type_id ON crm.agents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_crm_agent_custom_type();

CREATE OR REPLACE FUNCTION public.enforce_crm_agent_type_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, crm
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.is_deleted, false)
      AND NOT COALESCE(OLD.is_deleted, false)
      AND public.current_user_role() <> 'admin'
    THEN
      RAISE EXCEPTION 'Only workspace administrators can delete custom agent types'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'Custom agent types cannot be moved between workspaces'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.mode IS DISTINCT FROM OLD.mode AND EXISTS (
      SELECT 1 FROM crm.agents AS agent
      WHERE agent.workspace_id = OLD.workspace_id
        AND agent.custom_agent_type_id = OLD.id
        AND COALESCE(agent.is_deleted, false) = false
    ) THEN
      RAISE EXCEPTION 'Reassign agents before changing a custom agent type mode'
        USING ERRCODE = '23514';
    END IF;

    IF COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false) AND EXISTS (
      SELECT 1 FROM crm.agents AS agent
      WHERE agent.workspace_id = OLD.workspace_id
        AND agent.custom_agent_type_id = OLD.id
        AND COALESCE(agent.is_deleted, false) = false
    ) THEN
      RAISE EXCEPTION 'Reassign agents before deleting this custom agent type'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_crm_agent_type_lifecycle ON crm.agent_types;
CREATE TRIGGER enforce_crm_agent_type_lifecycle
  BEFORE UPDATE ON crm.agent_types
  FOR EACH ROW EXECUTE FUNCTION public.enforce_crm_agent_type_lifecycle();

ALTER TABLE crm.agent_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_agent_types_select ON crm.agent_types;
CREATE POLICY crm_agent_types_select ON crm.agent_types
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (
      public.current_user_role() = 'admin'
      OR public.current_user_has_workspace_permission(agent_types.workspace_id, 'agents.access')
    )
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = agent_types.workspace_id),
      'agents'
    )
  );

DROP POLICY IF EXISTS crm_agent_types_insert ON crm.agent_types;
CREATE POLICY crm_agent_types_insert ON crm.agent_types
  FOR INSERT TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND (
      public.current_user_role() = 'admin'
      OR public.current_user_has_workspace_permission(agent_types.workspace_id, 'agents.access')
    )
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = agent_types.workspace_id),
      'agents'
    )
  );

DROP POLICY IF EXISTS crm_agent_types_update ON crm.agent_types;
CREATE POLICY crm_agent_types_update ON crm.agent_types
  FOR UPDATE TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND (
      public.current_user_role() = 'admin'
      OR public.current_user_has_workspace_permission(agent_types.workspace_id, 'agents.access')
    )
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = agent_types.workspace_id),
      'agents'
    )
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND (
      public.current_user_role() = 'admin'
      OR public.current_user_has_workspace_permission(agent_types.workspace_id, 'agents.access')
    )
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = agent_types.workspace_id),
      'agents'
    )
  );

DROP POLICY IF EXISTS crm_agent_types_delete ON crm.agent_types;
CREATE POLICY crm_agent_types_delete ON crm.agent_types
  FOR DELETE TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
    AND (
      public.current_user_role() = 'admin'
      OR public.current_user_has_workspace_permission(agent_types.workspace_id, 'agents.access')
    )
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = agent_types.workspace_id),
      'agents'
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON crm.agent_types TO authenticated;
GRANT ALL ON crm.agent_types TO service_role;


DO $seller_functions$
DECLARE
  v_function record;
  v_updated_definition text;
  v_updated_count integer := 0;
BEGIN
  FOR v_function IN
    SELECT pg_get_functiondef(p.oid) AS definition
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE (n.nspname, p.proname) IN (
      ('private', 'sales_agent_commissions_is_agent_user'),
      ('private', 'sales_agent_commissions_plan_is_own'),
      ('private', 'sales_agent_commissions_order_is_own'),
      ('private', 'enforce_agent_commission_membership_row'),
      ('private', 'enforce_sales_order_agent_assignment_row'),
      ('private', 'enforce_agent_commission_entry_row'),
      ('private', 'enforce_product_commission_rule_agent_row'),
      ('private', 'ensure_order_creator_product_commission_assignment'),
      ('private', 'record_sales_agent_commission_settlement'),
      ('private', 'ensure_marketplace_delivery_product_commission_assignment'),
      ('private', 'agent_sales_accounts_can_view_own_order'),
      ('crm', 'get_orders_list_page'),
      ('crm', 'get_orders_list_page_optimized')
    )
  LOOP
    v_updated_definition := replace(
      v_function.definition,
      $needle$agent_type = 'field_agent'$needle$,
      $replacement$agent_type IN ('field_agent', 'seller')$replacement$
    );

    IF v_updated_definition = v_function.definition THEN
      RAISE EXCEPTION 'Expected Field Agent eligibility predicate was not found in a Seller workflow function';
    END IF;

    EXECUTE v_updated_definition;
    v_updated_count := v_updated_count + 1;
  END LOOP;

  IF v_updated_count <> 13 THEN
    RAISE EXCEPTION 'Expected to update 13 Seller workflow functions, updated %', v_updated_count;
  END IF;
END;
$seller_functions$;

DO $seller_policies$
DECLARE
  v_policy record;
  v_updated_qual text;
  v_updated_count integer := 0;
BEGIN
  FOR v_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'crm'
      AND policyname IN (
        'product_commission_rule_agents_select',
        'product_commission_rules_select'
      )
  LOOP
    v_updated_qual := regexp_replace(
      v_policy.qual,
      $pattern$agent_type = 'field_agent'(::text)?$pattern$,
      $replacement$agent_type IN ('field_agent', 'seller')$replacement$
    );

    IF v_updated_qual = v_policy.qual THEN
      RAISE EXCEPTION 'Expected Field Agent eligibility predicate was not found in policy %', v_policy.policyname;
    END IF;

    EXECUTE format(
      'ALTER POLICY %I ON %I.%I USING (%s)',
      v_policy.policyname,
      v_policy.schemaname,
      v_policy.tablename,
      v_updated_qual
    );
    v_updated_count := v_updated_count + 1;
  END LOOP;

  IF v_updated_count <> 2 THEN
    RAISE EXCEPTION 'Expected to update 2 Seller product commission policies, updated %', v_updated_count;
  END IF;
END;
$seller_policies$;

NOTIFY pgrst, 'reload schema';
