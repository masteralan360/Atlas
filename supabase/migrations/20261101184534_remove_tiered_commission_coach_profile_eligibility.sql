-- Remove the Commerce Operations coach-profile marker as an assignment prerequisite.
-- Require active, non-deleted Seller agents linked to a user for assignment and earnings.

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
    IF v_expected_position = 1 AND v_minimum <> 0
    THEN RAISE EXCEPTION 'The first tier must start at zero qualifying sales' USING ERRCODE = '23514'; END IF;

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

CREATE OR REPLACE FUNCTION private.tiered_commission_reconcile_order(p_workspace_id uuid, p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order crm.sales_orders%ROWTYPE;
  v_commerce public.commerce_operations_records%ROWTYPE;
  v_existing crm.tiered_commission_sales%ROWTYPE;
  v_program_name text;
  v_tiers_snapshot jsonb;
  v_rates_snapshot jsonb;
  v_agent_id uuid;
  v_program_id uuid;
  v_cycle crm.tiered_commission_cycles%ROWTYPE;
  v_timezone text;
  v_occurred_at timestamptz;
  v_qualifies boolean;
  v_earning_enabled boolean;
  v_full_return boolean;
  v_sale_id uuid;
BEGIN
  SELECT * INTO v_order FROM crm.sales_orders WHERE id = p_order_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- Serialize sale attribution with the only cycle rollover operation. A sale
  -- event waiting behind settlement then observes the newly activated cycle.
  PERFORM pg_advisory_xact_lock(hashtextextended('tiered-commission-settlement:' || p_workspace_id::text, 0));
  SELECT * INTO v_commerce FROM public.commerce_operations_records
    WHERE workspace_id = p_workspace_id AND related_order_id = p_order_id AND record_type = 'order_details'
    ORDER BY updated_at DESC, id DESC LIMIT 1;
  SELECT workspace.id IS NOT NULL
      AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'commerce_operations')
      AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'sales_agent_commissions')
    INTO v_earning_enabled
  FROM public.workspaces AS workspace
  WHERE workspace.id = p_workspace_id AND workspace.deleted_at IS NULL;
  v_earning_enabled := COALESCE(v_earning_enabled, false);

  v_full_return := lower(COALESCE(to_jsonb(v_order)->>'return_status', 'none')) = 'full'
    OR private.tiered_commission_order_fully_returned(p_workspace_id, p_order_id, v_order.items);

  v_qualifies := v_commerce.id IS NOT NULL AND NOT COALESCE(v_commerce.is_deleted, false)
    AND lower(COALESCE(v_commerce.payload->>'channel', '')) = 'social'
    AND lower(COALESCE(v_commerce.payload->>'platform', '')) = 'coach'
    AND lower(COALESCE(v_commerce.payload->>'fulfillmentStatus', 'completed')) NOT IN ('cancelled', 'canceled', 'returned', 'refunded')
    AND lower(COALESCE(v_order.status, '')) = 'completed'
    AND COALESCE(v_order.is_paid, false)
    AND NOT COALESCE(v_order.is_deleted, false);
  BEGIN v_agent_id := NULLIF(v_commerce.payload->>'agentId', '')::uuid; EXCEPTION WHEN invalid_text_representation THEN v_agent_id := NULL; END;
  v_qualifies := v_qualifies AND v_agent_id IS NOT NULL;

  -- If attribution or sale eligibility changed, reverse the previous snapshot;
  -- settled period corrections are appended and audited instead of rewritten.
  FOR v_existing IN SELECT * FROM crm.tiered_commission_sales WHERE workspace_id = p_workspace_id AND sales_order_id = p_order_id FOR UPDATE LOOP
    IF NOT v_qualifies OR v_existing.agent_id <> v_agent_id THEN
      PERFORM private.tiered_commission_reverse_sale(v_existing.id, true, true);
    ELSIF v_full_return AND v_existing.status = 'processed' THEN
      PERFORM private.tiered_commission_reverse_sale(v_existing.id, true, false);
    END IF;
  END LOOP;
  IF NOT v_qualifies OR NOT v_earning_enabled THEN RETURN; END IF;
  UPDATE crm.tiered_commission_sales AS pending_sale
  SET items_snapshot = COALESCE(v_order.items, '[]'::jsonb), updated_at = now()
  WHERE pending_sale.workspace_id = p_workspace_id AND pending_sale.sales_order_id = p_order_id
    AND pending_sale.agent_id = v_agent_id AND pending_sale.status = 'pending_cycle';
  FOR v_existing IN SELECT * FROM crm.tiered_commission_sales WHERE workspace_id = p_workspace_id
    AND sales_order_id = p_order_id AND agent_id = v_agent_id AND status = 'processed' AND NOT v_full_return FOR UPDATE
  LOOP
    PERFORM private.tiered_commission_reverse_sale(v_existing.id, false);
  END LOOP;
  IF EXISTS (SELECT 1 FROM crm.tiered_commission_sales WHERE workspace_id = p_workspace_id
    AND sales_order_id = p_order_id AND agent_id = v_agent_id AND status = 'processed') THEN RETURN; END IF;

  UPDATE crm.tiered_commission_sales AS prior_sale
  SET status = 'pending_cycle', cycle_id = NULL, counted_sales = false, items_snapshot = COALESCE(v_order.items, '[]'::jsonb), updated_at = now()
  WHERE prior_sale.workspace_id = p_workspace_id AND prior_sale.sales_order_id = p_order_id
    AND prior_sale.agent_id = v_agent_id AND prior_sale.status = 'reversed'
    AND NOT EXISTS (SELECT 1 FROM crm.tiered_commission_entries AS entry WHERE entry.sale_id = prior_sale.id);

  SELECT assignment.program_id INTO v_program_id
  FROM crm.tiered_commission_assignments AS assignment
  JOIN crm.tiered_commission_programs AS program ON program.id = assignment.program_id AND program.workspace_id = assignment.workspace_id
  JOIN crm.agents AS agent ON agent.id = assignment.agent_id AND agent.workspace_id = assignment.workspace_id
  WHERE assignment.workspace_id = p_workspace_id AND assignment.agent_id = v_agent_id
    AND assignment.unassigned_at IS NULL AND assignment.assigned_at <= COALESCE(v_order.created_at, v_commerce.record_date)
    AND program.is_active AND agent.agent_type = 'seller' AND agent.status = 'active'
    AND COALESCE(agent.is_deleted, false) = false AND agent.linked_user_id IS NOT NULL
  LIMIT 1;
  IF v_program_id IS NULL THEN RETURN; END IF;

  SELECT program.name INTO v_program_name FROM crm.tiered_commission_programs AS program
    WHERE program.workspace_id = p_workspace_id AND program.id = v_program_id AND program.is_active;
  IF v_program_name IS NULL THEN RETURN; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', tier.id, 'name', tier.name, 'position', tier.position,
    'minimumSales', tier.minimum_sales, 'maximumSales', tier.maximum_sales) ORDER BY tier.position), '[]'::jsonb)
    INTO v_tiers_snapshot FROM crm.tiered_commission_tiers AS tier
    WHERE tier.workspace_id = p_workspace_id AND tier.program_id = v_program_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('tierId', rate.tier_id, 'productId', rate.product_id,
    'amountPerUnitIqd', rate.amount_per_unit_iqd, 'productName', product.name, 'productSku', product.sku)), '[]'::jsonb)
    INTO v_rates_snapshot FROM crm.tiered_commission_product_rates AS rate
    JOIN public.products AS product ON product.id = rate.product_id AND product.workspace_id = rate.workspace_id
    WHERE rate.workspace_id = p_workspace_id AND rate.program_id = v_program_id
      AND COALESCE(product.is_deleted, false) = false;

  v_occurred_at := COALESCE(v_order.created_at, v_commerce.record_date);
  SELECT workspace.time_zone INTO v_timezone FROM public.workspaces AS workspace WHERE workspace.id = p_workspace_id;
  SELECT * INTO v_cycle FROM crm.tiered_commission_cycles WHERE workspace_id = p_workspace_id AND status = 'active' FOR UPDATE;
  INSERT INTO crm.tiered_commission_sales(workspace_id, cycle_id, sales_order_id, commerce_record_id, agent_id, program_id,
    program_name_snapshot, tiers_snapshot, rates_snapshot, items_snapshot, occurred_at, status)
  VALUES (p_workspace_id, CASE WHEN v_cycle.month_start = date_trunc('month', timezone(v_cycle.time_zone, v_occurred_at))::date THEN v_cycle.id ELSE NULL END,
    p_order_id, v_commerce.id, v_agent_id, v_program_id, v_program_name, v_tiers_snapshot, v_rates_snapshot,
    COALESCE(v_order.items, '[]'::jsonb), v_occurred_at, 'pending_cycle')
  ON CONFLICT (workspace_id, sales_order_id, agent_id) DO NOTHING
  RETURNING id INTO v_sale_id;
  IF v_sale_id IS NULL THEN SELECT id INTO v_sale_id FROM crm.tiered_commission_sales
    WHERE workspace_id = p_workspace_id AND sales_order_id = p_order_id AND agent_id = v_agent_id; END IF;

  IF v_cycle.id IS NOT NULL AND v_cycle.month_start = date_trunc('month', timezone(v_cycle.time_zone, v_occurred_at))::date THEN
    PERFORM private.tiered_commission_process_sale(v_sale_id, v_cycle.id);
  ELSIF v_cycle.id IS NOT NULL AND date_trunc('month', timezone(v_timezone, v_occurred_at))::date < v_cycle.month_start THEN
    INSERT INTO crm.tiered_commission_audit(workspace_id, cycle_id, sales_order_id, agent_id, event_type, details)
    VALUES (p_workspace_id, v_cycle.id, p_order_id, v_agent_id, 'sale_outside_active_cycle', jsonb_build_object('occurredAt', v_occurred_at));
  END IF;
END;
$function$;

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
      'description', program.description, 'isActive', program.is_active, 'agentIds', COALESCE((
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
      'isEligible', agent.agent_type = 'seller' AND agent.status = 'active'
        AND agent.linked_user_id IS NOT NULL AND COALESCE(agent.is_deleted, false) = false
    ) ORDER BY COALESCE(partner.partner_name, agent.id::text))
      FROM crm.agents AS agent
      JOIN crm.business_partners AS partner ON partner.id = agent.business_partner_id AND partner.workspace_id = agent.workspace_id
      WHERE agent.workspace_id = p_workspace_id AND (
        (agent.agent_type = 'seller' AND agent.status = 'active' AND agent.linked_user_id IS NOT NULL
          AND COALESCE(agent.is_deleted, false) = false)
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

