CREATE OR REPLACE FUNCTION private.coach_data_snapshot(
  p_workspace_id uuid,
  p_agent_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_partner_id uuid;
  v_partner_name text;
  v_partner_phone text;
  v_partner_city text;
  v_coach jsonb;
  v_cycle_id uuid;
  v_tier jsonb;
BEGIN
  SELECT agent.business_partner_id, partner.partner_name, partner.phone, partner.city
  INTO v_partner_id, v_partner_name, v_partner_phone, v_partner_city
  FROM crm.agents AS agent
  JOIN crm.business_partners AS partner
    ON partner.id = agent.business_partner_id
    AND partner.workspace_id = agent.workspace_id
  WHERE agent.workspace_id = p_workspace_id
    AND agent.id = p_agent_id
    AND agent.agent_type = 'seller'
    AND COALESCE(agent.is_deleted, false) = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('coach', NULL, 'tier', NULL);
  END IF;

  SELECT jsonb_build_object(
    'name', COALESCE(NULLIF(btrim(v_partner_name), ''), NULLIF(btrim(record.title), '')),
    'phone', COALESCE(NULLIF(btrim(record.payload->>'phone'), ''), v_partner_phone),
    'city', COALESCE(NULLIF(btrim(record.payload->>'city'), ''), v_partner_city)
  )
  INTO v_coach
  FROM public.commerce_operations_records AS record
  WHERE record.workspace_id = p_workspace_id
    AND record.record_type = 'coach_profile'
    AND record.related_partner_id = v_partner_id
    AND COALESCE(record.is_deleted, false) = false
  ORDER BY record.updated_at DESC, record.id DESC
  LIMIT 1;

  v_coach := COALESCE(v_coach, jsonb_build_object(
    'name', v_partner_name,
    'phone', v_partner_phone,
    'city', v_partner_city
  ));

  SELECT cycle.id
  INTO v_cycle_id
  FROM crm.tiered_commission_cycles AS cycle
  WHERE cycle.workspace_id = p_workspace_id
    AND cycle.status = 'active'
  LIMIT 1;

  IF v_cycle_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'cycleMonthStart', cycle.month_start,
      'timeZone', cycle.time_zone,
      'programName', COALESCE(performance.program_name_snapshot, program.name),
      'currentTierName', COALESCE(performance.current_tier_name_snapshot, current_tier.name),
      'qualifyingSales', COALESCE(performance.qualifying_sales, 0),
      'nextTierName', next_tier.name,
      'salesToNextTier', CASE WHEN next_tier.minimum_sales IS NULL THEN NULL
        ELSE GREATEST(next_tier.minimum_sales - COALESCE(performance.qualifying_sales, 0), 0) END,
      'commissionTotalIqd', COALESCE(earned.amount_iqd, 0)
    )
    INTO v_tier
    FROM crm.tiered_commission_cycles AS cycle
    LEFT JOIN crm.tiered_commission_agent_months AS performance
      ON performance.workspace_id = p_workspace_id
      AND performance.cycle_id = cycle.id
      AND performance.agent_id = p_agent_id
    LEFT JOIN crm.tiered_commission_assignments AS assignment
      ON assignment.workspace_id = p_workspace_id
      AND assignment.agent_id = p_agent_id
      AND assignment.unassigned_at IS NULL
    LEFT JOIN crm.tiered_commission_programs AS program
      ON program.workspace_id = p_workspace_id
      AND program.id = COALESCE(performance.program_id, assignment.program_id)
    LEFT JOIN LATERAL (
      SELECT tier.name
      FROM crm.tiered_commission_tiers AS tier
      WHERE tier.workspace_id = p_workspace_id
        AND tier.program_id = COALESCE(performance.program_id, assignment.program_id)
        AND tier.minimum_sales <= COALESCE(performance.qualifying_sales, 0)
        AND (tier.maximum_sales IS NULL OR tier.maximum_sales >= COALESCE(performance.qualifying_sales, 0))
      ORDER BY tier.position DESC
      LIMIT 1
    ) AS current_tier ON true
    LEFT JOIN LATERAL (
      SELECT tier.name, tier.minimum_sales
      FROM crm.tiered_commission_tiers AS tier
      WHERE tier.workspace_id = p_workspace_id
        AND tier.program_id = COALESCE(performance.program_id, assignment.program_id)
        AND tier.minimum_sales > COALESCE(performance.qualifying_sales, 0)
      ORDER BY tier.position
      LIMIT 1
    ) AS next_tier ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(entry.amount_iqd) FILTER (WHERE entry.status <> 'correction_pending'), 0) AS amount_iqd
      FROM crm.tiered_commission_entries AS entry
      WHERE entry.workspace_id = p_workspace_id
        AND entry.cycle_id = cycle.id
        AND entry.agent_id = p_agent_id
    ) AS earned ON true
    WHERE cycle.id = v_cycle_id;
  END IF;

  RETURN jsonb_build_object('coach', v_coach, 'tier', v_tier);
END;
$function$;

REVOKE ALL ON FUNCTION private.coach_data_snapshot(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_coach_data(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_agent_id uuid;
BEGIN
  IF v_user_id IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
    OR public.current_user_role() IS DISTINCT FROM 'staff'
    OR NOT private.current_user_has_workspace_permission(p_workspace_id, 'coach')
  THEN
    RAISE EXCEPTION 'Coach data access is restricted to the signed-in coach' USING ERRCODE = '42501';
  END IF;

  SELECT agent.id
  INTO v_agent_id
  FROM crm.agents AS agent
  WHERE agent.workspace_id = p_workspace_id
    AND agent.linked_user_id = v_user_id
    AND agent.agent_type = 'seller'
    AND COALESCE(agent.is_deleted, false) = false
  ORDER BY agent.created_at DESC, agent.id
  LIMIT 1;

  RETURN private.coach_data_snapshot(p_workspace_id, v_agent_id);
END;
$function$;

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
  IF v_user_id IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
    OR public.current_user_role() IS DISTINCT FROM 'admin'
    OR NOT private.current_user_has_workspace_permission(p_workspace_id, 'commerceOperations.access')
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
  IF v_user_id IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
    OR public.current_user_role() IS DISTINCT FROM 'admin'
    OR NOT private.current_user_has_workspace_permission(p_workspace_id, 'commerceOperations.access')
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

REVOKE ALL ON FUNCTION public.get_coach_data(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_coach_data_directory(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_coach_data_for_admin(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_coach_data(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_coach_data_directory(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_coach_data_for_admin(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
