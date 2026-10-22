CREATE TABLE crm.agent_types (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  mode text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  version bigint NULL DEFAULT 1,
  is_deleted boolean NULL DEFAULT false,
  CONSTRAINT agent_types_pkey PRIMARY KEY (id),
  CONSTRAINT agent_types_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_types_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT agent_types_name_check CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  CONSTRAINT agent_types_mode_check CHECK (
    mode IN ('driver', 'courier', 'field_agent', 'seller')
  )
);

CREATE UNIQUE INDEX ux_crm_agent_types_workspace_name_active
  ON crm.agent_types (workspace_id, lower(BTRIM(name)))
  WHERE COALESCE(is_deleted, false) = false;

CREATE INDEX idx_crm_agent_types_workspace_mode
  ON crm.agent_types (workspace_id, mode)
  WHERE COALESCE(is_deleted, false) = false;

ALTER TABLE crm.agent_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_agent_types_select ON crm.agent_types;
CREATE POLICY crm_agent_types_select ON crm.agent_types
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (
      public.current_user_role() = 'admin'
      OR public.current_user_has_workspace_permission(workspace_id, 'agents.access')
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
      OR public.current_user_has_workspace_permission(workspace_id, 'agents.access')
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
      OR public.current_user_has_workspace_permission(workspace_id, 'agents.access')
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
      OR public.current_user_has_workspace_permission(workspace_id, 'agents.access')
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
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = agent_types.workspace_id),
      'agents'
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON crm.agent_types TO authenticated;
GRANT ALL ON crm.agent_types TO service_role;
