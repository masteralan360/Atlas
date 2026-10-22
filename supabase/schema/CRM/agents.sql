CREATE TABLE crm.agents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  business_partner_id uuid NOT NULL,
  custom_agent_type_id uuid NULL,
  zone text NOT NULL,
  agent_type text NOT NULL,
  car_model text NULL,
  plate_number text NULL,
  linked_user_id uuid NULL,
  sales_account_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active'::text,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  CONSTRAINT agents_pkey PRIMARY KEY (id),
  CONSTRAINT agents_business_partner_id_key UNIQUE (business_partner_id),
  CONSTRAINT agents_business_partner_id_fkey
    FOREIGN KEY (business_partner_id) REFERENCES crm.business_partners(id) ON DELETE CASCADE,
  CONSTRAINT agents_linked_user_id_fkey
    FOREIGN KEY (linked_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT agents_type_check CHECK (
    agent_type IN ('driver', 'field_agent', 'courier', 'seller')
  ),
  CONSTRAINT agents_status_check CHECK (
    status IN ('active', 'inactive', 'blocked')
  ),
  CONSTRAINT agents_driver_vehicle_check CHECK (
    agent_type <> 'driver'
    OR (
      NULLIF(BTRIM(car_model), '') IS NOT NULL
      AND NULLIF(BTRIM(plate_number), '') IS NOT NULL
    )
  )
);

ALTER TABLE crm.agents
  ADD CONSTRAINT agents_custom_type_workspace_fkey
  FOREIGN KEY (workspace_id, custom_agent_type_id)
  REFERENCES crm.agent_types(workspace_id, id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_crm_agents_workspace
  ON crm.agents (workspace_id);

CREATE INDEX IF NOT EXISTS idx_crm_agents_workspace_status
  ON crm.agents (workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_crm_agents_workspace_type
  ON crm.agents (workspace_id, agent_type);

CREATE INDEX IF NOT EXISTS idx_crm_agents_linked_user
  ON crm.agents (linked_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_crm_agents_workspace_linked_user
  ON crm.agents (workspace_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL
    AND COALESCE(is_deleted, false) = false;

ALTER TABLE crm.agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_agents_select ON crm.agents;
CREATE POLICY crm_agents_select
  ON crm.agents
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = agents.workspace_id),
      'agents'
    )
  );

DROP POLICY IF EXISTS crm_agents_insert ON crm.agents;
CREATE POLICY crm_agents_insert
  ON crm.agents
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = agents.workspace_id),
      'agents'
    )
  );

DROP POLICY IF EXISTS crm_agents_update ON crm.agents;
CREATE POLICY crm_agents_update
  ON crm.agents
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = agents.workspace_id),
      'agents'
    )
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = agents.workspace_id),
      'agents'
    )
  );

DROP POLICY IF EXISTS crm_agents_delete ON crm.agents;
CREATE POLICY crm_agents_delete
  ON crm.agents
  FOR DELETE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT w.plan::text FROM public.workspaces w WHERE w.id = agents.workspace_id),
      'agents'
    )
  );
