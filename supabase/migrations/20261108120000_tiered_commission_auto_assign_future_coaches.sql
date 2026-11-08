ALTER TABLE crm.tiered_commission_programs
  ADD COLUMN IF NOT EXISTS auto_assign_new_agents boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS tiered_commission_one_auto_assign_program_per_workspace_idx
  ON crm.tiered_commission_programs (workspace_id)
  WHERE auto_assign_new_agents;

CREATE OR REPLACE FUNCTION private.tiered_commission_agent_is_eligible_coach(
  p_workspace_id uuid,
  p_agent_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM crm.agents AS agent
    WHERE agent.id = p_agent_id
      AND agent.workspace_id = p_workspace_id
      AND agent.agent_type = 'seller'
      AND agent.status = 'active'
      AND NULLIF(btrim(COALESCE(agent.linked_user_id::text, '')), '') IS NOT NULL
      AND COALESCE(agent.is_deleted, false) = false
      AND EXISTS (
        SELECT 1
        FROM public.commerce_operations_records AS coach
        WHERE coach.workspace_id = p_workspace_id
          AND coach.record_type = 'coach_profile'
          AND coach.related_partner_id = agent.business_partner_id
          AND COALESCE(coach.is_deleted, false) = false
      )
  );
$function$;

REVOKE ALL ON FUNCTION private.tiered_commission_agent_is_eligible_coach(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.save_tiered_commission_program(uuid, jsonb)
  RENAME TO save_tiered_commission_program_base;
REVOKE ALL ON FUNCTION public.save_tiered_commission_program_base(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_tiered_commission_program(p_workspace_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_program_id uuid;
  v_auto_assign_new_agents boolean;
BEGIN
  v_program_id := public.save_tiered_commission_program_base(p_workspace_id, p_payload);
  v_auto_assign_new_agents := COALESCE((p_payload->>'autoAssignNewAgents')::boolean, false);

  IF v_auto_assign_new_agents AND EXISTS (
    SELECT 1
    FROM crm.tiered_commission_programs AS program
    WHERE program.workspace_id = p_workspace_id
      AND program.auto_assign_new_agents
      AND program.id <> v_program_id
  ) THEN
    RAISE EXCEPTION 'tiered_commission_auto_assign_program_exists' USING ERRCODE = '23505';
  END IF;

  UPDATE crm.tiered_commission_programs
  SET auto_assign_new_agents = v_auto_assign_new_agents,
      updated_at = now()
  WHERE workspace_id = p_workspace_id
    AND id = v_program_id;

  RETURN v_program_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_tiered_commission_program(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_tiered_commission_program(uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.tiered_commission_auto_assign_eligible_agent(
  p_workspace_id uuid,
  p_agent_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_program_id uuid;
  v_cycle_id uuid;
BEGIN
  IF NOT private.tiered_commission_agent_is_eligible_coach(p_workspace_id, p_agent_id) THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('tiered-commission-settlement:' || p_workspace_id::text, 0));

  SELECT program.id INTO v_program_id
  FROM crm.tiered_commission_programs AS program
  WHERE program.workspace_id = p_workspace_id
    AND program.auto_assign_new_agents
  LIMIT 1;
  IF v_program_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM crm.tiered_commission_assignments AS assignment
    WHERE assignment.workspace_id = p_workspace_id
      AND assignment.agent_id = p_agent_id
      AND assignment.unassigned_at IS NULL
  ) THEN
    RETURN;
  END IF;

  INSERT INTO crm.tiered_commission_assignments(
    workspace_id, program_id, agent_id, assigned_at, assigned_by
  ) VALUES (
    p_workspace_id, v_program_id, p_agent_id, now(), NULL
  ) ON CONFLICT DO NOTHING;

  SELECT cycle.id INTO v_cycle_id
  FROM crm.tiered_commission_cycles AS cycle
  WHERE cycle.workspace_id = p_workspace_id AND cycle.status = 'active'
  LIMIT 1;

  IF v_cycle_id IS NOT NULL THEN
    INSERT INTO crm.tiered_commission_agent_months(
      workspace_id, cycle_id, program_id, agent_id,
      program_name_snapshot, current_tier_id, current_tier_name_snapshot
    )
    SELECT p_workspace_id, v_cycle_id, program.id, p_agent_id,
      program.name, tier.id, tier.name
    FROM crm.tiered_commission_programs AS program
    JOIN crm.tiered_commission_tiers AS tier
      ON tier.workspace_id = program.workspace_id
      AND tier.program_id = program.id
      AND tier.minimum_sales = 0
    WHERE program.workspace_id = p_workspace_id AND program.id = v_program_id
      AND EXISTS (
        SELECT 1
        FROM crm.tiered_commission_assignments AS assignment
        WHERE assignment.workspace_id = p_workspace_id
          AND assignment.program_id = v_program_id
          AND assignment.agent_id = p_agent_id
          AND assignment.unassigned_at IS NULL
      )
    ON CONFLICT (workspace_id, cycle_id, agent_id) DO NOTHING;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION private.tiered_commission_auto_assign_agent_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM private.tiered_commission_auto_assign_eligible_agent(NEW.workspace_id, NEW.id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.tiered_commission_auto_assign_coach_profile_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_agent_id uuid;
BEGIN
  IF NEW.record_type <> 'coach_profile'
     OR COALESCE(NEW.is_deleted, false)
     OR NEW.related_partner_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT agent.id INTO v_agent_id
  FROM crm.agents AS agent
  WHERE agent.workspace_id = NEW.workspace_id
    AND agent.business_partner_id = NEW.related_partner_id
  LIMIT 1;

  IF v_agent_id IS NOT NULL THEN
    PERFORM private.tiered_commission_auto_assign_eligible_agent(NEW.workspace_id, v_agent_id);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.tiered_commission_auto_assign_eligible_agent(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tiered_commission_auto_assign_agent_trigger()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tiered_commission_auto_assign_coach_profile_trigger()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tiered_commission_auto_assign_agent ON crm.agents;
CREATE TRIGGER tiered_commission_auto_assign_agent
AFTER INSERT OR UPDATE OF workspace_id, agent_type, status, linked_user_id, is_deleted
ON crm.agents
FOR EACH ROW EXECUTE FUNCTION private.tiered_commission_auto_assign_agent_trigger();

DROP TRIGGER IF EXISTS tiered_commission_auto_assign_coach_profile ON public.commerce_operations_records;
CREATE TRIGGER tiered_commission_auto_assign_coach_profile
AFTER INSERT OR UPDATE OF workspace_id, record_type, related_partner_id, is_deleted
ON public.commerce_operations_records
FOR EACH ROW EXECUTE FUNCTION private.tiered_commission_auto_assign_coach_profile_trigger();

CREATE OR REPLACE FUNCTION public.get_tiered_commission_dashboard(
  p_workspace_id uuid, p_month_start date DEFAULT NULL, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_cycle_id uuid;
  v_result jsonb;
BEGIN
  PERFORM private.tiered_commission_assert_admin(p_workspace_id, false);
  SELECT cycle.id INTO v_cycle_id FROM crm.tiered_commission_cycles AS cycle
    WHERE cycle.workspace_id = p_workspace_id
      AND ((p_month_start IS NULL AND cycle.status = 'active') OR cycle.month_start = p_month_start)
    LIMIT 1;

  SELECT jsonb_build_object(
    'cycle', (SELECT jsonb_build_object('id', cycle.id, 'monthStart', cycle.month_start, 'timeZone', cycle.time_zone,
      'status', cycle.status, 'activatedAt', cycle.activated_at, 'settledAt', cycle.settled_at)
      FROM crm.tiered_commission_cycles AS cycle WHERE cycle.id = v_cycle_id),
    'cycles', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', cycle.id, 'monthStart', cycle.month_start,
      'status', cycle.status, 'settledAt', cycle.settled_at, 'timeZone', cycle.time_zone) ORDER BY cycle.month_start DESC)
      FROM crm.tiered_commission_cycles AS cycle WHERE cycle.workspace_id = p_workspace_id), '[]'::jsonb),
    'programs', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', program.id, 'name', program.name,
      'description', program.description, 'isActive', program.is_active,
      'autoAssignNewAgents', program.auto_assign_new_agents,
      'agentIds', COALESCE((
        SELECT jsonb_agg(assignment.agent_id ORDER BY assignment.agent_id)
        FROM crm.tiered_commission_assignments AS assignment
        WHERE assignment.workspace_id = p_workspace_id AND assignment.program_id = program.id AND assignment.unassigned_at IS NULL
      ), '[]'::jsonb), 'tiers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', tier.id, 'name', tier.name, 'position', tier.position,
          'minimumSales', tier.minimum_sales, 'maximumSales', tier.maximum_sales) ORDER BY tier.position)
        FROM crm.tiered_commission_tiers AS tier WHERE tier.workspace_id = p_workspace_id AND tier.program_id = program.id
      ), '[]'::jsonb)) ORDER BY program.name) FROM crm.tiered_commission_programs AS program
      WHERE program.workspace_id = p_workspace_id), '[]'::jsonb),
    'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', agent.id, 'name', COALESCE(partner.partner_name, agent.id::text), 'programId',
      COALESCE(performance.program_id, assignment.program_id), 'programName',
      COALESCE(performance.program_name_snapshot, program.name), 'qualifyingSales', COALESCE(performance.qualifying_sales, 0),
      'currentTierId', performance.current_tier_id, 'currentTierName',
      COALESCE(performance.current_tier_name_snapshot, first_tier.name), 'nextTierName', next_tier.name,
      'salesToNextTier', CASE WHEN next_tier.minimum_sales IS NULL THEN NULL
        ELSE GREATEST(next_tier.minimum_sales - COALESCE(performance.qualifying_sales, 0), 0) END,
      'commissionTotalIqd', COALESCE(earned.amount_iqd, 0), 'assignmentId', assignment.id
    ) ORDER BY COALESCE(partner.partner_name, agent.id::text), agent.id)
      FROM crm.agents AS agent
      JOIN crm.business_partners AS partner ON partner.id = agent.business_partner_id AND partner.workspace_id = agent.workspace_id
      LEFT JOIN crm.tiered_commission_assignments AS assignment ON assignment.workspace_id = p_workspace_id
        AND assignment.agent_id = agent.id AND assignment.unassigned_at IS NULL
      LEFT JOIN crm.tiered_commission_programs AS program ON program.id = assignment.program_id AND program.workspace_id = p_workspace_id
      LEFT JOIN crm.tiered_commission_agent_months AS performance ON performance.workspace_id = p_workspace_id
        AND performance.cycle_id = v_cycle_id AND performance.agent_id = agent.id
      LEFT JOIN LATERAL (SELECT tier.name FROM crm.tiered_commission_tiers AS tier WHERE tier.program_id = assignment.program_id
        AND tier.minimum_sales = 0 ORDER BY tier.position LIMIT 1) AS first_tier ON true
      LEFT JOIN LATERAL (SELECT tier.name, tier.minimum_sales FROM crm.tiered_commission_tiers AS tier
        WHERE tier.program_id = COALESCE(performance.program_id, assignment.program_id)
          AND tier.minimum_sales > COALESCE(performance.qualifying_sales, 0) ORDER BY tier.position LIMIT 1) AS next_tier ON true
      LEFT JOIN LATERAL (SELECT COALESCE(sum(entry.amount_iqd) FILTER (WHERE entry.status <> 'correction_pending'), 0) AS amount_iqd FROM crm.tiered_commission_entries AS entry
        WHERE entry.workspace_id = p_workspace_id AND entry.cycle_id = v_cycle_id AND entry.agent_id = agent.id) AS earned ON true
      WHERE agent.workspace_id = p_workspace_id AND (
          performance.id IS NOT NULL OR (agent.agent_type = 'seller' AND agent.status = 'active'
            AND COALESCE(agent.is_deleted, false) = false AND assignment.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM crm.tiered_commission_cycles AS active_cycle
            WHERE active_cycle.id = v_cycle_id AND active_cycle.status = 'active'
          ))
        )
    ), '[]'::jsonb),
    'eligibleAgents', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', agent.id, 'name', COALESCE(partner.partner_name, agent.id::text),
      'isEligible', private.tiered_commission_agent_is_eligible_coach(p_workspace_id, agent.id)
    ) ORDER BY COALESCE(partner.partner_name, agent.id::text))
      FROM crm.agents AS agent
      JOIN crm.business_partners AS partner ON partner.id = agent.business_partner_id AND partner.workspace_id = agent.workspace_id
      WHERE agent.workspace_id = p_workspace_id AND (
        private.tiered_commission_agent_is_eligible_coach(p_workspace_id, agent.id)
        OR EXISTS (SELECT 1 FROM crm.tiered_commission_assignments AS current_assignment
          WHERE current_assignment.workspace_id = p_workspace_id AND current_assignment.agent_id = agent.id
            AND current_assignment.unassigned_at IS NULL)
      )
    ), '[]'::jsonb),
    'entries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', entry.id, 'agentId', entry.agent_id, 'salesOrderId', entry.sales_order_id, 'productId', entry.product_id,
      'productName', entry.product_name_snapshot, 'productSku', entry.product_sku_snapshot,
      'programName', entry.program_name_snapshot, 'tierName', entry.tier_name_snapshot,
      'quantity', entry.quantity, 'amountIqd', entry.amount_iqd, 'kind', entry.kind, 'status', entry.status,
      'occurredAt', entry.occurred_at, 'orderItemId', entry.order_item_id, 'relatedEntryId', entry.related_entry_id
    ) ORDER BY entry.occurred_at DESC, entry.id DESC) FROM (
      SELECT source.* FROM crm.tiered_commission_entries AS source
      WHERE source.workspace_id = p_workspace_id AND source.cycle_id = v_cycle_id
      ORDER BY source.occurred_at DESC, source.id DESC
      OFFSET (GREATEST(COALESCE(p_page, 1), 1) - 1) * LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100)
      LIMIT LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100)
    ) AS entry), '[]'::jsonb),
    'entryCount', (SELECT count(*) FROM crm.tiered_commission_entries AS entry
      WHERE entry.workspace_id = p_workspace_id AND entry.cycle_id = v_cycle_id),
    'entryPage', GREATEST(COALESCE(p_page, 1), 1),
    'entryPageSize', LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100),
    'pendingSales', (SELECT count(*) FROM crm.tiered_commission_sales AS sale WHERE sale.workspace_id = p_workspace_id AND sale.status = 'pending_cycle'),
    'audit', COALESCE((SELECT jsonb_agg(jsonb_build_object('eventType', audit.event_type, 'details', audit.details,
      'createdAt', audit.created_at) ORDER BY audit.created_at DESC) FROM crm.tiered_commission_audit AS audit
      WHERE audit.workspace_id = p_workspace_id AND (v_cycle_id IS NULL OR audit.cycle_id = v_cycle_id)), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

NOTIFY pgrst, 'reload schema';
