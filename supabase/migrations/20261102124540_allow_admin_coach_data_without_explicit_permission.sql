CREATE OR REPLACE FUNCTION public.get_coach_data_directory(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_coaches jsonb;
BEGIN
  -- Workspace admins have implicit module permissions in Atlas. The feature
  -- check below still prevents access when Commerce Operations is unavailable.
  IF v_user_id IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
    OR public.current_user_role() IS DISTINCT FROM 'admin'
    OR NOT EXISTS (
      SELECT 1
      FROM public.workspaces AS workspace
      WHERE workspace.id = p_workspace_id
        AND workspace.deleted_at IS NULL
        AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'commerce_operations')
    )
  THEN
    RAISE EXCEPTION 'Coach directory access is restricted to Commerce Operations administrators' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'userId', agent.linked_user_id,
    'name', partner.partner_name
  ) ORDER BY partner.partner_name, agent.id), '[]'::jsonb)
  INTO v_coaches
  FROM crm.agents AS agent
  JOIN crm.business_partners AS partner
    ON partner.id = agent.business_partner_id
    AND partner.workspace_id = agent.workspace_id
  WHERE agent.workspace_id = p_workspace_id
    AND agent.linked_user_id IS NOT NULL
    AND agent.agent_type = 'seller'
    AND COALESCE(agent.is_deleted, false) = false
    AND EXISTS (
      SELECT 1
      FROM public.workspace_permissions AS coach_permission
      WHERE coach_permission.workspace_id = p_workspace_id
        AND coach_permission.user_uuid = agent.linked_user_id
        AND coach_permission.key = 'coach'
    );

  RETURN jsonb_build_object('coaches', v_coaches);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_coach_data_for_admin(
  p_workspace_id uuid,
  p_coach_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_agent_id uuid;
BEGIN
  -- Workspace admins have implicit module permissions in Atlas. Keep the
  -- target coach scoped to this workspace and require the module feature.
  IF v_user_id IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
    OR public.current_user_role() IS DISTINCT FROM 'admin'
    OR NOT EXISTS (
      SELECT 1
      FROM public.workspaces AS workspace
      WHERE workspace.id = p_workspace_id
        AND workspace.deleted_at IS NULL
        AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'commerce_operations')
    )
  THEN
    RAISE EXCEPTION 'Coach data access is restricted to Commerce Operations administrators' USING ERRCODE = '42501';
  END IF;

  SELECT agent.id
  INTO v_agent_id
  FROM crm.agents AS agent
  WHERE agent.workspace_id = p_workspace_id
    AND agent.linked_user_id = p_coach_user_id
    AND agent.agent_type = 'seller'
    AND COALESCE(agent.is_deleted, false) = false
    AND EXISTS (
      SELECT 1
      FROM public.workspace_permissions AS coach_permission
      WHERE coach_permission.workspace_id = p_workspace_id
        AND coach_permission.user_uuid = agent.linked_user_id
        AND coach_permission.key = 'coach'
    )
  ORDER BY agent.created_at DESC, agent.id
  LIMIT 1;

  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'The selected coach is unavailable' USING ERRCODE = '42501';
  END IF;

  RETURN private.coach_data_snapshot(p_workspace_id, v_agent_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_coach_data_directory(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_coach_data_for_admin(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_coach_data_directory(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_coach_data_for_admin(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
