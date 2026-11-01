-- Allow a no-tier state at zero sales by permitting the first tier to start at one sale.

CREATE OR REPLACE FUNCTION public.save_tiered_commission_program(p_workspace_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_program_id uuid;
  v_program_name text;
  v_description text;
  v_active boolean;
  v_tier jsonb;
  v_tier_id uuid;
  v_tier_name text;
  v_position integer;
  v_expected_position integer := 0;
  v_minimum integer;
  v_previous_minimum integer := -1;
  v_next_minimum integer;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_agent_id uuid;
  v_existing_sales integer;
  v_active_cycle_id uuid;
  v_now timestamptz := now();
  v_timezone text;
BEGIN
  PERFORM private.tiered_commission_assert_admin(p_workspace_id, false);
  PERFORM pg_advisory_xact_lock(hashtextextended('tiered-commission-settlement:' || p_workspace_id::text, 0));
  IF NOT private.sales_agent_commissions_has_permission(p_workspace_id, 'salesAgentCommissions.managePlans') THEN
    RAISE EXCEPTION 'Commission management permission is required' USING ERRCODE = '42501';
  END IF;
  SET CONSTRAINTS crm.tiered_commission_tiers_position_unique, crm.tiered_commission_tiers_minimum_unique DEFERRED;
  v_program_name := btrim(COALESCE(p_payload->>'name', ''));
  v_description := NULLIF(btrim(COALESCE(p_payload->>'description', '')), '');
  v_active := COALESCE((p_payload->>'isActive')::boolean, true);
  IF p_payload IS NULL OR jsonb_typeof(p_payload->'tiers') <> 'array'
     OR jsonb_typeof(p_payload->'agentIds') <> 'array'
  THEN
    RAISE EXCEPTION 'A program name, at least one tier, and an agent list are required' USING ERRCODE = '22023';
  END IF;
  IF v_program_name = '' OR jsonb_array_length(p_payload->'tiers') = 0 THEN
    RAISE EXCEPTION 'A program name, at least one tier, and an agent list are required' USING ERRCODE = '22023';
  END IF;

  IF NULLIF(p_payload->>'id', '') IS NULL THEN
    INSERT INTO crm.tiered_commission_programs(workspace_id, name, description, is_active, created_by)
    VALUES (p_workspace_id, v_program_name, v_description, v_active, (SELECT auth.uid()))
    RETURNING id INTO v_program_id;
  ELSE
    v_program_id := (p_payload->>'id')::uuid;
    UPDATE crm.tiered_commission_programs
    SET name = v_program_name, description = v_description, is_active = v_active, updated_at = v_now
    WHERE workspace_id = p_workspace_id AND id = v_program_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Commission program not found' USING ERRCODE = 'P0002'; END IF;
  END IF;

  FOR v_tier IN
    SELECT item.value FROM jsonb_array_elements(p_payload->'tiers') AS item(value)
    ORDER BY (item.value->>'position')::integer
  LOOP
    v_expected_position := v_expected_position + 1;
    v_position := (v_tier->>'position')::integer;
    v_minimum := (v_tier->>'minimumSales')::integer;
    v_tier_name := btrim(COALESCE(v_tier->>'name', ''));
    IF v_position <> v_expected_position OR v_minimum < 0 OR v_minimum <= v_previous_minimum OR v_tier_name = ''
    THEN RAISE EXCEPTION 'Tier positions and minimum sales must be unique, ascending, and valid' USING ERRCODE = '23514'; END IF;
    IF v_expected_position = 1 AND v_minimum NOT IN (0, 1)
    THEN RAISE EXCEPTION 'The first tier must start at zero or one qualifying sale' USING ERRCODE = '23514'; END IF;

    SELECT (next_tier.value->>'minimumSales')::integer INTO v_next_minimum
    FROM jsonb_array_elements(p_payload->'tiers') AS next_tier(value)
    WHERE (next_tier.value->>'position')::integer = v_position + 1;
    v_tier_id := CASE WHEN NULLIF(v_tier->>'id', '') IS NULL THEN gen_random_uuid() ELSE (v_tier->>'id')::uuid END;
    IF EXISTS (SELECT 1 FROM crm.tiered_commission_tiers WHERE id = v_tier_id AND workspace_id = p_workspace_id AND program_id = v_program_id) THEN
      UPDATE crm.tiered_commission_tiers
      SET name = v_tier_name, position = v_position, minimum_sales = v_minimum,
          maximum_sales = CASE WHEN v_next_minimum IS NULL THEN NULL ELSE v_next_minimum - 1 END,
          updated_at = v_now
      WHERE id = v_tier_id;
    ELSE
      INSERT INTO crm.tiered_commission_tiers(workspace_id, program_id, id, name, position, minimum_sales, maximum_sales)
      VALUES (p_workspace_id, v_program_id, v_tier_id, v_tier_name, v_position, v_minimum,
        CASE WHEN v_next_minimum IS NULL THEN NULL ELSE v_next_minimum - 1 END);
    END IF;
    v_ids := array_append(v_ids, v_tier_id);
    v_previous_minimum := v_minimum;
  END LOOP;

  DELETE FROM crm.tiered_commission_tiers
  WHERE workspace_id = p_workspace_id AND program_id = v_program_id AND NOT (id = ANY(v_ids));

  UPDATE crm.tiered_commission_agent_months AS performance
  SET current_tier_id = (
        SELECT tier.id FROM crm.tiered_commission_tiers AS tier
        WHERE tier.workspace_id = p_workspace_id AND tier.program_id = v_program_id
          AND tier.minimum_sales <= performance.qualifying_sales
          AND (tier.maximum_sales IS NULL OR tier.maximum_sales >= performance.qualifying_sales)
        ORDER BY tier.position DESC LIMIT 1
      ),
      current_tier_name_snapshot = (
        SELECT tier.name FROM crm.tiered_commission_tiers AS tier
        WHERE tier.workspace_id = p_workspace_id AND tier.program_id = v_program_id
          AND tier.minimum_sales <= performance.qualifying_sales
          AND (tier.maximum_sales IS NULL OR tier.maximum_sales >= performance.qualifying_sales)
        ORDER BY tier.position DESC LIMIT 1
      ),
      program_name_snapshot = v_program_name, updated_at = v_now
  WHERE performance.workspace_id = p_workspace_id AND performance.program_id = v_program_id
    AND EXISTS (SELECT 1 FROM crm.tiered_commission_cycles AS cycle
      WHERE cycle.id = performance.cycle_id AND cycle.status = 'active');

  -- Retain each agent's single current assignment and close any assignment
  -- they removed or moved to another program without rewriting prior entries.
  UPDATE crm.tiered_commission_assignments AS assignment
  SET unassigned_at = v_now
  WHERE assignment.workspace_id = p_workspace_id AND assignment.unassigned_at IS NULL
    AND assignment.program_id = v_program_id
    AND NOT (assignment.agent_id = ANY(ARRAY(SELECT (value #>> '{}')::uuid FROM jsonb_array_elements(p_payload->'agentIds'))));

  FOR v_agent_id IN
    SELECT DISTINCT (agent_value #>> '{}')::uuid
    FROM jsonb_array_elements(p_payload->'agentIds') AS agent_value
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM crm.agents AS agent
      WHERE agent.id = v_agent_id AND agent.workspace_id = p_workspace_id
        AND agent.agent_type = 'seller' AND agent.status = 'active'
        AND COALESCE(agent.is_deleted, false) = false
        AND NULLIF(btrim(COALESCE(agent.linked_user_id::text, '')), '') IS NOT NULL
    ) THEN RAISE EXCEPTION 'Only active Commerce Operations coach agents can be assigned' USING ERRCODE = '23514'; END IF;

    SELECT performance.qualifying_sales INTO v_existing_sales
    FROM crm.tiered_commission_agent_months AS performance
    JOIN crm.tiered_commission_cycles AS cycle ON cycle.id = performance.cycle_id
    WHERE performance.workspace_id = p_workspace_id AND performance.agent_id = v_agent_id
      AND cycle.status = 'active' AND performance.program_id <> v_program_id
    FOR UPDATE OF performance;
    IF v_existing_sales > 0 THEN
      RAISE EXCEPTION 'An agent with monthly sales cannot change commission programs before settlement' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM crm.tiered_commission_sales AS pending_sale
      WHERE pending_sale.workspace_id = p_workspace_id AND pending_sale.agent_id = v_agent_id
        AND pending_sale.program_id <> v_program_id AND pending_sale.status = 'pending_cycle') THEN
      RAISE EXCEPTION 'An agent with sales waiting for monthly activation cannot change commission programs' USING ERRCODE = '23514';
    END IF;

    UPDATE crm.tiered_commission_assignments
    SET unassigned_at = v_now
    WHERE workspace_id = p_workspace_id AND agent_id = v_agent_id AND unassigned_at IS NULL AND program_id <> v_program_id;

    IF NOT EXISTS (
      SELECT 1 FROM crm.tiered_commission_assignments
      WHERE workspace_id = p_workspace_id AND program_id = v_program_id AND agent_id = v_agent_id AND unassigned_at IS NULL
    ) THEN
      INSERT INTO crm.tiered_commission_assignments(workspace_id, program_id, agent_id, assigned_at, assigned_by)
      VALUES (p_workspace_id, v_program_id, v_agent_id, v_now, (SELECT auth.uid()));
    END IF;
  END LOOP;

  SELECT workspace.time_zone INTO v_timezone FROM public.workspaces AS workspace WHERE workspace.id = p_workspace_id;
  IF v_active AND NOT EXISTS (SELECT 1 FROM crm.tiered_commission_cycles WHERE workspace_id = p_workspace_id) THEN
    INSERT INTO crm.tiered_commission_cycles(workspace_id, month_start, time_zone)
    VALUES (p_workspace_id, date_trunc('month', timezone(v_timezone, v_now))::date, v_timezone);
  END IF;
  SELECT cycle.id INTO v_active_cycle_id FROM crm.tiered_commission_cycles AS cycle
  WHERE cycle.workspace_id = p_workspace_id AND cycle.status = 'active' FOR UPDATE;
  IF v_active_cycle_id IS NOT NULL THEN
    INSERT INTO crm.tiered_commission_agent_months(
      workspace_id, cycle_id, program_id, agent_id, program_name_snapshot, current_tier_id, current_tier_name_snapshot
    )
    SELECT p_workspace_id, v_active_cycle_id, assignment.program_id, assignment.agent_id,
      program.name, tier.id, tier.name
    FROM crm.tiered_commission_assignments AS assignment
    JOIN crm.tiered_commission_programs AS program
      ON program.id = assignment.program_id AND program.workspace_id = assignment.workspace_id
    JOIN crm.tiered_commission_tiers AS tier
      ON tier.workspace_id = assignment.workspace_id AND tier.program_id = assignment.program_id AND tier.minimum_sales = 0
    WHERE assignment.workspace_id = p_workspace_id AND assignment.unassigned_at IS NULL
    ON CONFLICT (workspace_id, cycle_id, agent_id) DO UPDATE
      SET program_id = EXCLUDED.program_id, program_name_snapshot = EXCLUDED.program_name_snapshot,
        current_tier_id = EXCLUDED.current_tier_id, current_tier_name_snapshot = EXCLUDED.current_tier_name_snapshot,
        updated_at = v_now
      WHERE crm.tiered_commission_agent_months.qualifying_sales = 0;
  END IF;
  RETURN v_program_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';

