-- Independent Commerce Operations tiered performance commission engine.
-- This schema intentionally does not read or write the legacy commission
-- plans, product commission rules, or commission ledger.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'Asia/Baghdad';

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.workspaces'::regclass
      AND conname = 'workspaces_time_zone_valid'
  ) THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_time_zone_valid
      CHECK (NULLIF(btrim(time_zone), '') IS NOT NULL);
  END IF;
END;
$block$;

CREATE TABLE IF NOT EXISTS crm.tiered_commission_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (NULLIF(btrim(name), '') IS NOT NULL),
  description text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS crm.tiered_commission_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  program_id uuid NOT NULL,
  name text NOT NULL CHECK (NULLIF(btrim(name), '') IS NOT NULL),
  position integer NOT NULL CHECK (position > 0),
  minimum_sales integer NOT NULL CHECK (minimum_sales >= 0),
  maximum_sales integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tiered_commission_tiers_range_check
    CHECK (maximum_sales IS NULL OR maximum_sales >= minimum_sales),
  CONSTRAINT tiered_commission_tiers_program_fk
    FOREIGN KEY (workspace_id, program_id)
    REFERENCES crm.tiered_commission_programs(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, program_id, id),
  CONSTRAINT tiered_commission_tiers_position_unique
    UNIQUE (workspace_id, program_id, position) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT tiered_commission_tiers_minimum_unique
    UNIQUE (workspace_id, program_id, minimum_sales) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE IF NOT EXISTS crm.tiered_commission_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  program_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES crm.agents(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz NULL,
  assigned_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT tiered_commission_assignments_program_fk
    FOREIGN KEY (workspace_id, program_id)
    REFERENCES crm.tiered_commission_programs(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, program_id, agent_id, assigned_at),
  CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS tiered_commission_assignments_one_active_program_idx
  ON crm.tiered_commission_assignments (workspace_id, agent_id)
  WHERE unassigned_at IS NULL;
CREATE INDEX IF NOT EXISTS tiered_commission_assignments_program_idx
  ON crm.tiered_commission_assignments (workspace_id, program_id, agent_id)
  WHERE unassigned_at IS NULL;

CREATE TABLE IF NOT EXISTS crm.tiered_commission_product_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  program_id uuid NOT NULL,
  tier_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  amount_per_unit_iqd numeric(18, 6) NOT NULL CHECK (amount_per_unit_iqd > 0),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tiered_commission_product_rates_tier_fk
    FOREIGN KEY (workspace_id, program_id, tier_id)
    REFERENCES crm.tiered_commission_tiers(workspace_id, program_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, program_id, tier_id, product_id)
);

CREATE TABLE IF NOT EXISTS crm.tiered_commission_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  month_start date NOT NULL,
  time_zone text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  settled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, month_start),
  CHECK ((status = 'active' AND settled_at IS NULL) OR (status = 'settled' AND settled_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS tiered_commission_cycles_one_active_idx
  ON crm.tiered_commission_cycles (workspace_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS crm.tiered_commission_agent_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  cycle_id uuid NOT NULL REFERENCES crm.tiered_commission_cycles(id) ON DELETE RESTRICT,
  program_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES crm.agents(id) ON DELETE RESTRICT,
  program_name_snapshot text NOT NULL,
  qualifying_sales integer NOT NULL DEFAULT 0 CHECK (qualifying_sales >= 0),
  current_tier_id uuid NULL,
  current_tier_name_snapshot text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, cycle_id, agent_id)
);

CREATE TABLE IF NOT EXISTS crm.tiered_commission_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  cycle_id uuid NULL REFERENCES crm.tiered_commission_cycles(id) ON DELETE RESTRICT,
  sales_order_id uuid NOT NULL REFERENCES crm.sales_orders(id) ON DELETE RESTRICT,
  commerce_record_id uuid NULL REFERENCES public.commerce_operations_records(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL REFERENCES crm.agents(id) ON DELETE RESTRICT,
  program_id uuid NOT NULL REFERENCES crm.tiered_commission_programs(id) ON DELETE RESTRICT,
  program_name_snapshot text NOT NULL,
  tiers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  rates_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  items_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_cycle', 'processed', 'reversed')),
  counted_sales boolean NOT NULL DEFAULT false,
  tier_id_snapshot uuid NULL,
  tier_name_snapshot text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sales_order_id, agent_id)
);
CREATE INDEX IF NOT EXISTS tiered_commission_sales_pending_idx
  ON crm.tiered_commission_sales (workspace_id, occurred_at, sales_order_id)
  WHERE status = 'pending_cycle';

CREATE TABLE IF NOT EXISTS crm.tiered_commission_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  cycle_id uuid NOT NULL REFERENCES crm.tiered_commission_cycles(id) ON DELETE RESTRICT,
  sale_id uuid NOT NULL REFERENCES crm.tiered_commission_sales(id) ON DELETE RESTRICT,
  sales_order_id uuid NOT NULL REFERENCES crm.sales_orders(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES crm.agents(id) ON DELETE RESTRICT,
  program_id uuid NOT NULL,
  tier_id uuid NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  order_item_id text NOT NULL,
  program_name_snapshot text NOT NULL,
  tier_name_snapshot text NOT NULL,
  product_name_snapshot text NOT NULL,
  product_sku_snapshot text NULL,
  commission_per_unit_iqd numeric(18, 6) NOT NULL CHECK (commission_per_unit_iqd > 0),
  quantity numeric(18, 6) NOT NULL CHECK (quantity <> 0),
  amount_iqd numeric(18, 6) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('accrual', 'reversal', 'reinstatement')),
  status text NOT NULL CHECK (status IN ('earned', 'settled', 'correction_pending')),
  related_entry_id uuid NULL REFERENCES crm.tiered_commission_entries(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  config_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  CONSTRAINT tiered_commission_entries_amount_check
    CHECK (abs(amount_iqd - round(quantity * commission_per_unit_iqd, 6)) <= 0.000001),
  CHECK ((kind = 'accrual' AND quantity > 0 AND amount_iqd > 0 AND related_entry_id IS NULL)
      OR (kind = 'reversal' AND quantity < 0 AND amount_iqd < 0 AND related_entry_id IS NOT NULL)
      OR (kind = 'reinstatement' AND quantity > 0 AND amount_iqd > 0 AND related_entry_id IS NOT NULL)),
  CONSTRAINT tiered_commission_entries_program_fk
    FOREIGN KEY (workspace_id, program_id)
    REFERENCES crm.tiered_commission_programs(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS tiered_commission_entries_cycle_agent_idx
  ON crm.tiered_commission_entries (workspace_id, cycle_id, agent_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS tiered_commission_entries_order_idx
  ON crm.tiered_commission_entries (workspace_id, sales_order_id, order_item_id);

CREATE TABLE IF NOT EXISTS crm.tiered_commission_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  cycle_id uuid NULL REFERENCES crm.tiered_commission_cycles(id) ON DELETE SET NULL,
  sales_order_id uuid NULL REFERENCES crm.sales_orders(id) ON DELETE SET NULL,
  agent_id uuid NULL REFERENCES crm.agents(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $block$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'tiered_commission_programs', 'tiered_commission_tiers',
    'tiered_commission_assignments', 'tiered_commission_product_rates',
    'tiered_commission_cycles', 'tiered_commission_agent_months',
    'tiered_commission_sales', 'tiered_commission_entries', 'tiered_commission_audit'
  ] LOOP
    EXECUTE format('ALTER TABLE crm.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE crm.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('GRANT ALL ON TABLE crm.%I TO service_role', v_table);
  END LOOP;
END;
$block$;

CREATE OR REPLACE FUNCTION private.tiered_commission_assert_admin(p_workspace_id uuid, p_settlement boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_plan text;
BEGIN
  IF (SELECT auth.uid()) IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
    OR public.current_user_role() IS DISTINCT FROM 'admin'
  THEN
    RAISE EXCEPTION 'Tiered commission access is restricted to workspace administrators' USING ERRCODE = '42501';
  END IF;

  SELECT workspace.plan::text INTO v_plan
  FROM public.workspaces AS workspace
  WHERE workspace.id = p_workspace_id AND workspace.deleted_at IS NULL
    AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'commerce_operations')
    AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'sales_agent_commissions');
  IF v_plan IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.id = (SELECT auth.uid())
        AND COALESCE(profile.current_workspace, profile.workspace_id) = p_workspace_id
        AND (
          profile.role = 'admin'
          OR EXISTS (
            SELECT 1
            FROM public.workspace_permissions AS permission
            WHERE permission.workspace_id = p_workspace_id
              AND permission.user_uuid = profile.id
              AND permission.key = 'commerceOperations.access'
          )
        )
    )
  THEN
    RAISE EXCEPTION 'Commerce Operations access is unavailable' USING ERRCODE = '42501';
  END IF;

  IF p_settlement
    AND NOT private.sales_agent_commissions_has_permission(p_workspace_id, 'salesAgentCommissions.pay')
  THEN
    RAISE EXCEPTION 'Settlement permission is required' USING ERRCODE = '42501';
  ELSIF NOT p_settlement
    AND NOT private.sales_agent_commissions_has_permission(p_workspace_id, 'salesAgentCommissions.managePlans')
    AND NOT private.sales_agent_commissions_has_permission(p_workspace_id, 'salesAgentCommissions.viewAll')
  THEN
    RAISE EXCEPTION 'Commission management permission is required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

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
        AND EXISTS (
          SELECT 1 FROM public.commerce_operations_records AS coach
          WHERE coach.workspace_id = p_workspace_id AND coach.record_type = 'coach_profile'
            AND coach.related_partner_id = agent.business_partner_id AND COALESCE(coach.is_deleted, false) = false
        )
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

CREATE OR REPLACE FUNCTION public.save_tiered_commission_product_rates(p_workspace_id uuid, p_product_id uuid, p_rates jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_rate jsonb;
  v_program_id uuid;
  v_tier_id uuid;
  v_amount numeric;
BEGIN
  PERFORM private.tiered_commission_assert_admin(p_workspace_id, false);
  IF NOT private.sales_agent_commissions_has_permission(p_workspace_id, 'salesAgentCommissions.managePlans') THEN
    RAISE EXCEPTION 'Commission management permission is required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND workspace_id = p_workspace_id AND COALESCE(is_deleted, false) = false)
    OR jsonb_typeof(p_rates) <> 'array'
  THEN RAISE EXCEPTION 'Product commission configuration is invalid' USING ERRCODE = '23514'; END IF;

  FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) LOOP
    v_program_id := (v_rate->>'programId')::uuid;
    v_tier_id := (v_rate->>'tierId')::uuid;
    v_amount := (v_rate->>'amountIqd')::numeric;
    IF v_amount <= 0 OR NOT EXISTS (
      SELECT 1 FROM crm.tiered_commission_tiers AS tier
      JOIN crm.tiered_commission_programs AS program ON program.id = tier.program_id AND program.workspace_id = tier.workspace_id
      WHERE tier.workspace_id = p_workspace_id AND tier.program_id = v_program_id AND tier.id = v_tier_id
        AND (program.is_active OR EXISTS (
          SELECT 1 FROM crm.tiered_commission_product_rates AS current_rate
          WHERE current_rate.workspace_id = p_workspace_id AND current_rate.product_id = p_product_id
            AND current_rate.program_id = v_program_id AND current_rate.tier_id = v_tier_id
        ))
    ) THEN RAISE EXCEPTION 'Select an available tier and a valid IQD commission amount' USING ERRCODE = '23514'; END IF;
    INSERT INTO crm.tiered_commission_product_rates(workspace_id, program_id, tier_id, product_id, amount_per_unit_iqd, created_by)
    VALUES (p_workspace_id, v_program_id, v_tier_id, p_product_id, v_amount, (SELECT auth.uid()))
    ON CONFLICT (workspace_id, program_id, tier_id, product_id)
    DO UPDATE SET amount_per_unit_iqd = EXCLUDED.amount_per_unit_iqd, updated_at = now();
  END LOOP;

  DELETE FROM crm.tiered_commission_product_rates AS rate
  WHERE rate.workspace_id = p_workspace_id AND rate.product_id = p_product_id
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rates) AS value
      WHERE (value->>'programId')::uuid = rate.program_id
        AND (value->>'tierId')::uuid = rate.tier_id
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_tiered_commission_product_configuration(p_workspace_id uuid, p_product_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_result jsonb;
BEGIN
  PERFORM private.tiered_commission_assert_admin(p_workspace_id, false);
  IF p_product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = p_product_id AND workspace_id = p_workspace_id AND COALESCE(is_deleted, false) = false
  ) THEN RAISE EXCEPTION 'Product not found' USING ERRCODE = 'P0002'; END IF;
  SELECT jsonb_build_object(
    'programs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', program.id, 'name', program.name, 'isActive', program.is_active,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', tier.id, 'name', tier.name, 'position', tier.position,
          'minimumSales', tier.minimum_sales, 'maximumSales', tier.maximum_sales
        ) ORDER BY tier.position) FROM crm.tiered_commission_tiers AS tier
          WHERE tier.workspace_id = p_workspace_id AND tier.program_id = program.id), '[]'::jsonb)
      ) ORDER BY program.name)
      FROM crm.tiered_commission_programs AS program
      WHERE program.workspace_id = p_workspace_id
        AND (program.is_active OR EXISTS (
          SELECT 1 FROM crm.tiered_commission_product_rates AS rate
          WHERE rate.workspace_id = p_workspace_id AND rate.program_id = program.id AND rate.product_id = p_product_id
        ))
    ), '[]'::jsonb),
    'rates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'programId', rate.program_id, 'tierId', rate.tier_id,
        'amountIqd', rate.amount_per_unit_iqd
      ) ORDER BY rate.program_id, tier.position)
      FROM crm.tiered_commission_product_rates AS rate
      JOIN crm.tiered_commission_tiers AS tier ON tier.id = rate.tier_id
      WHERE rate.workspace_id = p_workspace_id AND rate.product_id = p_product_id
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION private.tiered_commission_order_fully_returned(
  p_workspace_id uuid, p_order_id uuid, p_items jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT jsonb_typeof(p_items) = 'array'
    AND jsonb_array_length(p_items) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_items) AS item(value)
      WHERE COALESCE(NULLIF(item.value->>'quantity', '')::numeric, 0) > GREATEST(
        COALESCE(NULLIF(item.value->>'returnedQuantity', '')::numeric,
          NULLIF(item.value->>'returned_quantity', '')::numeric, 0),
        COALESCE((
          SELECT sum(return_item.quantity)
          FROM public.order_return_items AS return_item
          JOIN public.order_returns AS order_return ON order_return.id = return_item.return_id
            AND order_return.workspace_id = return_item.workspace_id
          WHERE return_item.workspace_id = p_workspace_id AND return_item.order_id = p_order_id
            AND return_item.order_item_id = COALESCE(NULLIF(item.value->>'id', ''), item.value->>'productId')
            AND COALESCE(return_item.is_deleted, false) = false
            AND order_return.status = 'posted' AND COALESCE(order_return.is_deleted, false) = false
        ), 0)
      )
    );
$function$;

CREATE OR REPLACE FUNCTION private.tiered_commission_process_sale(p_sale_id uuid, p_cycle_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale crm.tiered_commission_sales%ROWTYPE;
  v_cycle crm.tiered_commission_cycles%ROWTYPE;
  v_performance crm.tiered_commission_agent_months%ROWTYPE;
  v_item jsonb;
  v_product_id uuid;
  v_tier_id uuid;
  v_tier_name text;
  v_item_id text;
  v_quantity numeric;
  v_returned_quantity numeric;
  v_rate numeric;
  v_product_name text;
  v_product_sku text;
BEGIN
  SELECT * INTO v_sale FROM crm.tiered_commission_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_cycle FROM crm.tiered_commission_cycles WHERE id = p_cycle_id FOR UPDATE;
  IF NOT FOUND OR v_cycle.status <> 'active' OR v_sale.status = 'processed' OR v_sale.status = 'reversed' THEN RETURN; END IF;

  IF private.tiered_commission_order_fully_returned(v_sale.workspace_id, v_sale.sales_order_id, v_sale.items_snapshot) THEN
    UPDATE crm.tiered_commission_sales SET cycle_id = v_cycle.id, status = 'reversed', counted_sales = false, updated_at = now()
      WHERE id = v_sale.id;
    INSERT INTO crm.tiered_commission_audit(workspace_id, cycle_id, sales_order_id, agent_id, event_type, details)
      VALUES (v_sale.workspace_id, v_cycle.id, v_sale.sales_order_id, v_sale.agent_id,
        'sale_fully_returned_before_processing', jsonb_build_object('saleId', v_sale.id));
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_sale.workspace_id::text || ':' || v_cycle.id::text || ':' || v_sale.agent_id::text, 0));
  INSERT INTO crm.tiered_commission_agent_months(workspace_id, cycle_id, program_id, agent_id, program_name_snapshot)
  VALUES (v_sale.workspace_id, v_cycle.id, v_sale.program_id, v_sale.agent_id, v_sale.program_name_snapshot)
  ON CONFLICT (workspace_id, cycle_id, agent_id) DO NOTHING;
  SELECT * INTO v_performance FROM crm.tiered_commission_agent_months
    WHERE workspace_id = v_sale.workspace_id AND cycle_id = v_cycle.id AND agent_id = v_sale.agent_id FOR UPDATE;
  IF v_performance.program_id <> v_sale.program_id THEN
    RAISE EXCEPTION 'Agent has conflicting program assignment in this monthly cycle' USING ERRCODE = '23514';
  END IF;

  UPDATE crm.tiered_commission_agent_months SET qualifying_sales = qualifying_sales + 1, updated_at = now()
    WHERE id = v_performance.id RETURNING * INTO v_performance;
  SELECT (tier.value->>'id')::uuid, tier.value->>'name' INTO v_tier_id, v_tier_name
  FROM jsonb_array_elements(v_sale.tiers_snapshot) AS tier(value)
  WHERE (tier.value->>'minimumSales')::integer <= v_performance.qualifying_sales
    AND (NULLIF(tier.value->>'maximumSales', '') IS NULL
      OR (tier.value->>'maximumSales')::integer >= v_performance.qualifying_sales)
  ORDER BY (tier.value->>'position')::integer DESC LIMIT 1;
  IF v_tier_id IS NULL THEN RAISE EXCEPTION 'No tier matches qualifying sales count' USING ERRCODE = '23514'; END IF;
  UPDATE crm.tiered_commission_agent_months SET current_tier_id = v_tier_id,
    current_tier_name_snapshot = v_tier_name, program_name_snapshot = v_sale.program_name_snapshot, updated_at = now()
    WHERE id = v_performance.id;

  UPDATE crm.tiered_commission_sales SET cycle_id = v_cycle.id, status = 'processed', counted_sales = true,
    tier_id_snapshot = v_tier_id, tier_name_snapshot = v_tier_name, updated_at = now()
    WHERE id = v_sale.id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_sale.items_snapshot) = 'array' THEN v_sale.items_snapshot ELSE '[]'::jsonb END) LOOP
    BEGIN v_product_id := NULLIF(v_item->>'productId', '')::uuid; EXCEPTION WHEN invalid_text_representation THEN v_product_id := NULL; END;
    IF v_product_id IS NULL THEN CONTINUE; END IF;
    v_item_id := COALESCE(NULLIF(v_item->>'id', ''), v_product_id::text);
    v_quantity := GREATEST(COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0), 0);
    SELECT COALESCE(sum(return_item.quantity), 0)
      INTO v_returned_quantity
    FROM public.order_return_items AS return_item
    JOIN public.order_returns AS order_return ON order_return.id = return_item.return_id
      AND order_return.workspace_id = return_item.workspace_id
    WHERE return_item.workspace_id = v_sale.workspace_id AND return_item.order_id = v_sale.sales_order_id
      AND return_item.order_item_id = v_item_id AND COALESCE(return_item.is_deleted, false) = false
      AND order_return.status = 'posted' AND COALESCE(order_return.is_deleted, false) = false;
    v_quantity := GREATEST(v_quantity - GREATEST(COALESCE(NULLIF(v_item->>'returnedQuantity', '')::numeric,
      NULLIF(v_item->>'returned_quantity', '')::numeric, 0), v_returned_quantity), 0);
    IF v_quantity <= 0 THEN CONTINUE; END IF;
    v_rate := NULL;
    SELECT (rate.value->>'amountPerUnitIqd')::numeric,
      COALESCE(NULLIF(v_item->>'productName', ''), rate.value->>'productName'), rate.value->>'productSku'
      INTO v_rate, v_product_name, v_product_sku
    FROM jsonb_array_elements(v_sale.rates_snapshot) AS rate(value)
    WHERE (rate.value->>'tierId')::uuid = v_tier_id AND (rate.value->>'productId')::uuid = v_product_id;
    IF v_rate IS NULL THEN CONTINUE; END IF;
    INSERT INTO crm.tiered_commission_entries(
      workspace_id, cycle_id, sale_id, sales_order_id, agent_id, program_id, tier_id, product_id, order_item_id,
      program_name_snapshot, tier_name_snapshot, product_name_snapshot, product_sku_snapshot,
      commission_per_unit_iqd, quantity, amount_iqd, kind, status, occurred_at, config_snapshot
    ) VALUES (
      v_sale.workspace_id, v_cycle.id, v_sale.id, v_sale.sales_order_id, v_sale.agent_id, v_sale.program_id, v_tier_id,
      v_product_id, v_item_id, v_sale.program_name_snapshot, v_tier_name, v_product_name, v_product_sku,
      v_rate, v_quantity, round(v_rate * v_quantity, 6), 'accrual', 'earned', v_sale.occurred_at,
      jsonb_build_object('amountPerUnitIqd', v_rate, 'quantity', v_quantity, 'tierName', v_tier_name,
        'programName', v_sale.program_name_snapshot)
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION private.tiered_commission_reverse_sale(
  p_sale_id uuid, p_full_reversal boolean DEFAULT false, p_invalidate_sale boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale crm.tiered_commission_sales%ROWTYPE;
  v_order crm.sales_orders%ROWTYPE;
  v_entry crm.tiered_commission_entries%ROWTYPE;
  v_item jsonb;
  v_returned numeric;
  v_returned_from_records numeric;
  v_already numeric;
  v_adjustment numeric;
  v_status text;
BEGIN
  SELECT * INTO v_sale FROM crm.tiered_commission_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND OR v_sale.status = 'reversed' THEN RETURN; END IF;
  SELECT * INTO v_order FROM crm.sales_orders WHERE id = v_sale.sales_order_id;
  FOR v_entry IN SELECT * FROM crm.tiered_commission_entries
    WHERE sale_id = v_sale.id AND kind = 'accrual' ORDER BY id FOR UPDATE
  LOOP
    IF p_full_reversal THEN
      v_returned := v_entry.quantity;
    ELSE
      SELECT value INTO v_item FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_order.items) = 'array' THEN v_order.items ELSE '[]'::jsonb END)
      WHERE COALESCE(value->>'id', value->>'productId') = v_entry.order_item_id LIMIT 1;
      SELECT COALESCE(sum(return_item.quantity), 0)
        INTO v_returned_from_records
      FROM public.order_return_items AS return_item
      JOIN public.order_returns AS order_return ON order_return.id = return_item.return_id
        AND order_return.workspace_id = return_item.workspace_id
      WHERE return_item.workspace_id = v_entry.workspace_id AND return_item.order_id = v_entry.sales_order_id
        AND return_item.order_item_id = v_entry.order_item_id AND COALESCE(return_item.is_deleted, false) = false
        AND order_return.status = 'posted' AND COALESCE(order_return.is_deleted, false) = false;
      v_returned := LEAST(v_entry.quantity, GREATEST(COALESCE(NULLIF(v_item->>'returnedQuantity', '')::numeric,
        NULLIF(v_item->>'returned_quantity', '')::numeric, 0), v_returned_from_records, 0));
    END IF;
    SELECT GREATEST(COALESCE(-sum(quantity), 0), 0) INTO v_already FROM crm.tiered_commission_entries
      WHERE related_entry_id = v_entry.id AND kind IN ('reversal', 'reinstatement');
    v_adjustment := LEAST(v_returned, v_entry.quantity) - v_already;
    IF v_adjustment = 0 THEN CONTINUE; END IF;
    v_status := CASE WHEN EXISTS (SELECT 1 FROM crm.tiered_commission_cycles WHERE id = v_entry.cycle_id AND status = 'settled')
      THEN 'correction_pending' ELSE 'earned' END;
    INSERT INTO crm.tiered_commission_entries(
      workspace_id, cycle_id, sale_id, sales_order_id, agent_id, program_id, tier_id, product_id, order_item_id,
      program_name_snapshot, tier_name_snapshot, product_name_snapshot, product_sku_snapshot,
      commission_per_unit_iqd, quantity, amount_iqd, kind, status, related_entry_id, occurred_at, config_snapshot
    ) VALUES (
      v_entry.workspace_id, v_entry.cycle_id, v_entry.sale_id, v_entry.sales_order_id, v_entry.agent_id,
      v_entry.program_id, v_entry.tier_id, v_entry.product_id, v_entry.order_item_id,
      v_entry.program_name_snapshot, v_entry.tier_name_snapshot, v_entry.product_name_snapshot, v_entry.product_sku_snapshot,
      v_entry.commission_per_unit_iqd, -v_adjustment, round(-v_adjustment * v_entry.commission_per_unit_iqd, 6),
      CASE WHEN v_adjustment > 0 THEN 'reversal' ELSE 'reinstatement' END,
      v_status, v_entry.id, now(),
      v_entry.config_snapshot || CASE WHEN v_adjustment > 0
        THEN jsonb_build_object('reversedQuantity', v_adjustment)
        ELSE jsonb_build_object('reinstatedQuantity', -v_adjustment) END
    );
    IF v_status = 'correction_pending' THEN
      INSERT INTO crm.tiered_commission_audit(workspace_id, cycle_id, sales_order_id, agent_id, event_type, details)
      VALUES (v_entry.workspace_id, v_entry.cycle_id, v_entry.sales_order_id, v_entry.agent_id,
        CASE WHEN v_adjustment > 0 THEN 'settled_commission_reversal' ELSE 'settled_commission_reinstatement' END,
        jsonb_build_object('entryId', v_entry.id, 'quantity', abs(v_adjustment),
          'amountIqd', round(abs(v_adjustment) * v_entry.commission_per_unit_iqd, 6)));
    END IF;
  END LOOP;

  IF p_full_reversal AND v_sale.counted_sales AND v_sale.cycle_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM crm.tiered_commission_cycles WHERE id = v_sale.cycle_id AND status = 'active')
  THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_sale.workspace_id::text || ':' || v_sale.cycle_id::text || ':' || v_sale.agent_id::text, 0));
    UPDATE crm.tiered_commission_agent_months AS performance
      SET qualifying_sales = GREATEST(performance.qualifying_sales - 1, 0), updated_at = now()
      WHERE workspace_id = v_sale.workspace_id AND cycle_id = v_sale.cycle_id AND agent_id = v_sale.agent_id;
    UPDATE crm.tiered_commission_agent_months AS performance
    SET current_tier_id = (SELECT tier.id FROM crm.tiered_commission_tiers AS tier
        WHERE tier.workspace_id = performance.workspace_id AND tier.program_id = performance.program_id
          AND tier.minimum_sales <= performance.qualifying_sales
          AND (tier.maximum_sales IS NULL OR tier.maximum_sales >= performance.qualifying_sales)
        ORDER BY tier.position DESC LIMIT 1),
        current_tier_name_snapshot = (SELECT tier.name FROM crm.tiered_commission_tiers AS tier
        WHERE tier.workspace_id = performance.workspace_id AND tier.program_id = performance.program_id
          AND tier.minimum_sales <= performance.qualifying_sales
          AND (tier.maximum_sales IS NULL OR tier.maximum_sales >= performance.qualifying_sales)
        ORDER BY tier.position DESC LIMIT 1), updated_at = now()
    WHERE performance.workspace_id = v_sale.workspace_id AND performance.cycle_id = v_sale.cycle_id
      AND performance.agent_id = v_sale.agent_id;
    UPDATE crm.tiered_commission_sales SET counted_sales = false,
      status = CASE WHEN p_invalidate_sale THEN 'reversed' ELSE 'processed' END, updated_at = now()
      WHERE id = v_sale.id;
  ELSIF p_full_reversal AND p_invalidate_sale AND v_sale.cycle_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM crm.tiered_commission_cycles WHERE id = v_sale.cycle_id AND status = 'settled'
  ) THEN
    INSERT INTO crm.tiered_commission_audit(workspace_id, cycle_id, sales_order_id, agent_id, event_type, details)
    VALUES (v_sale.workspace_id, v_sale.cycle_id, v_sale.sales_order_id, v_sale.agent_id,
      'settled_sale_invalidated', jsonb_build_object('saleId', v_sale.id));
    UPDATE crm.tiered_commission_sales SET status = 'reversed', updated_at = now() WHERE id = v_sale.id;
  ELSIF p_full_reversal AND p_invalidate_sale THEN
    UPDATE crm.tiered_commission_sales SET status = 'reversed', counted_sales = false, updated_at = now() WHERE id = v_sale.id;
  ELSIF p_full_reversal THEN
    UPDATE crm.tiered_commission_sales SET status = 'processed', counted_sales = false, updated_at = now() WHERE id = v_sale.id;
  ELSIF NOT v_sale.counted_sales AND v_sale.status = 'processed' AND v_sale.cycle_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM crm.tiered_commission_cycles WHERE id = v_sale.cycle_id AND status = 'active')
  THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_sale.workspace_id::text || ':' || v_sale.cycle_id::text || ':' || v_sale.agent_id::text, 0));
    UPDATE crm.tiered_commission_agent_months SET qualifying_sales = qualifying_sales + 1, updated_at = now()
      WHERE workspace_id = v_sale.workspace_id AND cycle_id = v_sale.cycle_id AND agent_id = v_sale.agent_id;
    UPDATE crm.tiered_commission_agent_months AS performance
    SET current_tier_id = (SELECT tier.id FROM crm.tiered_commission_tiers AS tier
        WHERE tier.workspace_id = performance.workspace_id AND tier.program_id = performance.program_id
          AND tier.minimum_sales <= performance.qualifying_sales
          AND (tier.maximum_sales IS NULL OR tier.maximum_sales >= performance.qualifying_sales)
        ORDER BY tier.position DESC LIMIT 1),
        current_tier_name_snapshot = (SELECT tier.name FROM crm.tiered_commission_tiers AS tier
        WHERE tier.workspace_id = performance.workspace_id AND tier.program_id = performance.program_id
          AND tier.minimum_sales <= performance.qualifying_sales
          AND (tier.maximum_sales IS NULL OR tier.maximum_sales >= performance.qualifying_sales)
        ORDER BY tier.position DESC LIMIT 1), updated_at = now()
    WHERE performance.workspace_id = v_sale.workspace_id AND performance.cycle_id = v_sale.cycle_id
      AND performance.agent_id = v_sale.agent_id;
    UPDATE crm.tiered_commission_sales SET counted_sales = true, updated_at = now() WHERE id = v_sale.id;
  END IF;
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
    AND COALESCE(agent.is_deleted, false) = false
    AND EXISTS (SELECT 1 FROM public.commerce_operations_records AS coach WHERE coach.workspace_id = p_workspace_id
      AND coach.record_type = 'coach_profile' AND coach.related_partner_id = agent.business_partner_id AND NOT COALESCE(coach.is_deleted, false))
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

CREATE OR REPLACE FUNCTION private.tiered_commission_order_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA = 'crm' THEN
    PERFORM private.tiered_commission_reconcile_order(NEW.workspace_id, NEW.id);
  ELSE
    PERFORM private.tiered_commission_reconcile_order(NEW.workspace_id, NEW.related_order_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tiered_commission_sales_order_changed ON crm.sales_orders;
CREATE TRIGGER tiered_commission_sales_order_changed
AFTER INSERT OR UPDATE OF status, is_paid, is_deleted, items, created_at, return_status, returned_amount ON crm.sales_orders
FOR EACH ROW EXECUTE FUNCTION private.tiered_commission_order_trigger();

DROP TRIGGER IF EXISTS tiered_commission_commerce_attribution_changed ON public.commerce_operations_records;
CREATE TRIGGER tiered_commission_commerce_attribution_changed
AFTER INSERT OR UPDATE OF payload, related_order_id, record_type, is_deleted ON public.commerce_operations_records
FOR EACH ROW WHEN (NEW.record_type = 'order_details' AND NEW.related_order_id IS NOT NULL)
EXECUTE FUNCTION private.tiered_commission_order_trigger();

CREATE OR REPLACE FUNCTION private.tiered_commission_order_return_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM private.tiered_commission_reconcile_order(NEW.workspace_id, NEW.order_id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tiered_commission_order_return_changed ON public.order_returns;
CREATE TRIGGER tiered_commission_order_return_changed
AFTER INSERT OR UPDATE OF status, is_deleted ON public.order_returns
FOR EACH ROW EXECUTE FUNCTION private.tiered_commission_order_return_trigger();

DROP TRIGGER IF EXISTS tiered_commission_order_return_item_changed ON public.order_return_items;
CREATE TRIGGER tiered_commission_order_return_item_changed
AFTER INSERT OR UPDATE OF quantity, is_deleted ON public.order_return_items
FOR EACH ROW EXECUTE FUNCTION private.tiered_commission_order_return_trigger();

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
        AND EXISTS (SELECT 1 FROM public.commerce_operations_records AS coach
          WHERE coach.workspace_id = p_workspace_id AND coach.record_type = 'coach_profile'
            AND coach.related_partner_id = agent.business_partner_id AND NOT COALESCE(coach.is_deleted, false))
    ) ORDER BY COALESCE(partner.partner_name, agent.id::text))
      FROM crm.agents AS agent
      JOIN crm.business_partners AS partner ON partner.id = agent.business_partner_id AND partner.workspace_id = agent.workspace_id
      WHERE agent.workspace_id = p_workspace_id AND (
        (agent.agent_type = 'seller' AND agent.status = 'active' AND agent.linked_user_id IS NOT NULL
          AND COALESCE(agent.is_deleted, false) = false
          AND EXISTS (SELECT 1 FROM public.commerce_operations_records AS coach
            WHERE coach.workspace_id = p_workspace_id AND coach.record_type = 'coach_profile'
              AND coach.related_partner_id = agent.business_partner_id AND NOT COALESCE(coach.is_deleted, false)))
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

CREATE OR REPLACE FUNCTION public.settle_and_activate_tiered_commission_month(p_workspace_id uuid, p_expected_cycle_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_cycle crm.tiered_commission_cycles%ROWTYPE;
  v_next_cycle crm.tiered_commission_cycles%ROWTYPE;
  v_assignment record;
  v_tier crm.tiered_commission_tiers%ROWTYPE;
  v_sale record;
  v_next_month date;
  v_pending integer := 0;
  v_previous_cycle crm.tiered_commission_cycles%ROWTYPE;
  v_previous_next_cycle crm.tiered_commission_cycles%ROWTYPE;
BEGIN
  PERFORM private.tiered_commission_assert_admin(p_workspace_id, true);
  PERFORM pg_advisory_xact_lock(hashtextextended('tiered-commission-settlement:' || p_workspace_id::text, 0));
  SELECT * INTO v_previous_cycle FROM crm.tiered_commission_cycles
    WHERE workspace_id = p_workspace_id AND id = p_expected_cycle_id FOR UPDATE;
  IF FOUND AND v_previous_cycle.status = 'settled' THEN
    SELECT * INTO v_previous_next_cycle FROM crm.tiered_commission_cycles
      WHERE workspace_id = p_workspace_id AND month_start = (v_previous_cycle.month_start + interval '1 month')::date;
    IF FOUND THEN
      SELECT COALESCE((audit.details->>'deferredSalesProcessed')::integer, 0) INTO v_pending
      FROM crm.tiered_commission_audit AS audit
      WHERE audit.workspace_id = p_workspace_id AND audit.cycle_id = v_previous_next_cycle.id
        AND audit.event_type = 'monthly_cycle_activated'
      ORDER BY audit.created_at DESC LIMIT 1;
      RETURN jsonb_build_object('settledCycleId', v_previous_cycle.id, 'activeCycleId', v_previous_next_cycle.id,
        'activeMonthStart', v_previous_next_cycle.month_start, 'deferredSalesProcessed', COALESCE(v_pending, 0),
        'alreadySettled', true);
    END IF;
    RAISE EXCEPTION 'The requested commission month has already been settled' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO v_cycle FROM crm.tiered_commission_cycles
    WHERE workspace_id = p_workspace_id AND id = p_expected_cycle_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'There is no active commission month to settle' USING ERRCODE = 'P0002'; END IF;
  IF v_cycle.month_start >= date_trunc('month', timezone(v_cycle.time_zone, now()))::date THEN
    RAISE EXCEPTION 'The active commission month cannot be settled before its calendar month ends' USING ERRCODE = '23514';
  END IF;

  UPDATE crm.tiered_commission_entries SET status = 'settled', settled_at = now()
    WHERE workspace_id = p_workspace_id AND cycle_id = v_cycle.id AND status = 'earned';
  UPDATE crm.tiered_commission_cycles SET status = 'settled', settled_at = now(), settled_by = (SELECT auth.uid())
    WHERE id = v_cycle.id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'The commission month has already been settled' USING ERRCODE = '23505'; END IF;

  v_next_month := (v_cycle.month_start + interval '1 month')::date;
  INSERT INTO crm.tiered_commission_cycles(workspace_id, month_start, time_zone)
  VALUES (p_workspace_id, v_next_month, v_cycle.time_zone) RETURNING * INTO v_next_cycle;

  FOR v_assignment IN
    SELECT assignment.agent_id, assignment.program_id, program.name AS program_name
    FROM crm.tiered_commission_assignments AS assignment
    JOIN crm.tiered_commission_programs AS program ON program.id = assignment.program_id AND program.workspace_id = assignment.workspace_id
    WHERE assignment.workspace_id = p_workspace_id AND assignment.unassigned_at IS NULL AND program.is_active
    ORDER BY assignment.agent_id
  LOOP
    SELECT * INTO v_tier FROM crm.tiered_commission_tiers WHERE workspace_id = p_workspace_id
      AND program_id = v_assignment.program_id AND minimum_sales = 0 LIMIT 1;
    INSERT INTO crm.tiered_commission_agent_months(workspace_id, cycle_id, program_id, agent_id,
      program_name_snapshot, current_tier_id, current_tier_name_snapshot)
    VALUES (p_workspace_id, v_next_cycle.id, v_assignment.program_id, v_assignment.agent_id,
      v_assignment.program_name, v_tier.id, v_tier.name);
  END LOOP;

  FOR v_sale IN SELECT id FROM crm.tiered_commission_sales
    WHERE workspace_id = p_workspace_id AND status = 'pending_cycle'
      AND date_trunc('month', timezone(v_cycle.time_zone, occurred_at))::date = v_next_month
    ORDER BY occurred_at, sales_order_id, id
  LOOP
    PERFORM private.tiered_commission_process_sale(v_sale.id, v_next_cycle.id);
    IF EXISTS (SELECT 1 FROM crm.tiered_commission_sales AS processed_sale
      WHERE processed_sale.id = v_sale.id AND processed_sale.status = 'processed') THEN
      v_pending := v_pending + 1;
    END IF;
  END LOOP;

  INSERT INTO crm.tiered_commission_audit(workspace_id, cycle_id, event_type, details, created_by)
    VALUES (p_workspace_id, v_next_cycle.id, 'monthly_cycle_activated',
      jsonb_build_object('previousCycleId', v_cycle.id, 'deferredSalesProcessed', v_pending), (SELECT auth.uid()));
  RETURN jsonb_build_object('settledCycleId', v_cycle.id, 'activeCycleId', v_next_cycle.id,
    'activeMonthStart', v_next_cycle.month_start, 'deferredSalesProcessed', v_pending);
END;
$function$;

REVOKE ALL ON FUNCTION private.tiered_commission_assert_admin(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tiered_commission_process_sale(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tiered_commission_reverse_sale(uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tiered_commission_order_fully_returned(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tiered_commission_reconcile_order(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tiered_commission_order_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.tiered_commission_order_return_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_tiered_commission_program(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_tiered_commission_product_rates(uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_tiered_commission_product_configuration(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_tiered_commission_dashboard(uuid, date, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.settle_and_activate_tiered_commission_month(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_tiered_commission_program(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_tiered_commission_product_rates(uuid, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tiered_commission_product_configuration(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tiered_commission_dashboard(uuid, date, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_and_activate_tiered_commission_month(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
