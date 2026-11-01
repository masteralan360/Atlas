-- Estimate a prospective tier commission for a Commerce Operations social order.
-- This is read-only: the actual sale and commission ledger remain server-authoritative.
CREATE OR REPLACE FUNCTION public.get_tiered_commission_order_draft_estimate(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_occurred_at timestamptz,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_plan text;
  v_can_view_all boolean;
  v_can_view_own boolean;
  v_agent_name text;
  v_program_id uuid;
  v_program_name text;
  v_cycle crm.tiered_commission_cycles%ROWTYPE;
  v_sales_before integer := 0;
  v_tier_id uuid;
  v_tier_name text;
  v_entries jsonb;
  v_total numeric;
  v_result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
  THEN
    RAISE EXCEPTION 'Tiered commission access is restricted to the current workspace' USING ERRCODE = '42501';
  END IF;

  IF p_occurred_at IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid order estimate input' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'Too many order lines for an estimate' USING ERRCODE = '22023';
  END IF;

  SELECT workspace.plan::text INTO v_plan
  FROM public.workspaces AS workspace
  WHERE workspace.id = p_workspace_id
    AND workspace.deleted_at IS NULL
    AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'commerce_operations')
    AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'sales_agent_commissions');
  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'Commerce Operations commission access is unavailable' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles AS profile
    WHERE profile.id = (SELECT auth.uid())
      AND COALESCE(profile.current_workspace, profile.workspace_id) = p_workspace_id
      AND (
        profile.role = 'admin'
        OR EXISTS (
          SELECT 1 FROM public.workspace_permissions AS permission
          WHERE permission.workspace_id = p_workspace_id
            AND permission.user_uuid = profile.id
            AND permission.key = 'commerceOperations.access'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Commerce Operations permission is required' USING ERRCODE = '42501';
  END IF;

  v_can_view_all := private.sales_agent_commissions_has_permission(p_workspace_id, 'salesAgentCommissions.viewAll');
  v_can_view_own := private.sales_agent_commissions_has_permission(p_workspace_id, 'salesAgentCommissions.viewOwn');
  IF NOT v_can_view_all AND NOT v_can_view_own THEN
    RAISE EXCEPTION 'Commission view permission is required' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(partner.partner_name, agent.id::text), assignment.program_id, program.name
    INTO v_agent_name, v_program_id, v_program_name
  FROM crm.tiered_commission_assignments AS assignment
  JOIN crm.tiered_commission_programs AS program
    ON program.id = assignment.program_id AND program.workspace_id = assignment.workspace_id
  JOIN crm.agents AS agent
    ON agent.id = assignment.agent_id AND agent.workspace_id = assignment.workspace_id
  JOIN crm.business_partners AS partner
    ON partner.id = agent.business_partner_id AND partner.workspace_id = agent.workspace_id
  WHERE assignment.workspace_id = p_workspace_id
    AND assignment.agent_id = p_agent_id
    AND assignment.unassigned_at IS NULL
    AND assignment.assigned_at <= p_occurred_at
    AND program.is_active
    AND agent.agent_type = 'seller'
    AND agent.status = 'active'
    AND agent.linked_user_id IS NOT NULL
    AND COALESCE(agent.is_deleted, false) = false
    AND (v_can_view_all OR (v_can_view_own AND agent.linked_user_id = (SELECT auth.uid())))
  LIMIT 1;
  IF v_program_id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_cycle
  FROM crm.tiered_commission_cycles AS cycle
  WHERE cycle.workspace_id = p_workspace_id AND cycle.status = 'active'
  LIMIT 1;
  IF v_cycle.id IS NULL
    OR date_trunc('month', timezone(v_cycle.time_zone, p_occurred_at))::date <> v_cycle.month_start
  THEN
    RETURN NULL;
  END IF;

  SELECT performance.qualifying_sales INTO v_sales_before
  FROM crm.tiered_commission_agent_months AS performance
  WHERE performance.workspace_id = p_workspace_id
    AND performance.cycle_id = v_cycle.id
    AND performance.agent_id = p_agent_id
    AND performance.program_id = v_program_id;
  v_sales_before := COALESCE(v_sales_before, 0);

  SELECT tier.id, tier.name INTO v_tier_id, v_tier_name
  FROM crm.tiered_commission_tiers AS tier
  WHERE tier.workspace_id = p_workspace_id
    AND tier.program_id = v_program_id
    AND tier.minimum_sales <= v_sales_before + 1
    AND (tier.maximum_sales IS NULL OR tier.maximum_sales >= v_sales_before + 1)
  ORDER BY tier.position DESC
  LIMIT 1;
  IF v_tier_id IS NULL THEN RETURN NULL; END IF;

  WITH supplied AS (
    SELECT value, ordinality
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(value, ordinality)
  ), eligible AS (
    SELECT
      supplied.ordinality,
      supplied.value->>'lineId' AS line_id,
      product.id AS product_id,
      product.name AS product_name,
      product.sku AS product_sku,
      parsed.quantity,
      rate.amount_per_unit_iqd,
      round(parsed.quantity * rate.amount_per_unit_iqd, 6) AS amount_iqd
    FROM supplied
    CROSS JOIN LATERAL (
      SELECT
        NULLIF(supplied.value->>'productId', '')::uuid AS product_id,
        NULLIF(supplied.value->>'quantity', '')::numeric AS quantity
    ) AS parsed
    JOIN public.products AS product
      ON product.id = parsed.product_id
      AND product.workspace_id = p_workspace_id
      AND COALESCE(product.is_deleted, false) = false
    JOIN crm.tiered_commission_product_rates AS rate
      ON rate.workspace_id = p_workspace_id
      AND rate.program_id = v_program_id
      AND rate.tier_id = v_tier_id
      AND rate.product_id = product.id
    WHERE parsed.quantity > 0
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'lineId', eligible.line_id,
      'productId', eligible.product_id,
      'productName', eligible.product_name,
      'productSku', eligible.product_sku,
      'quantity', eligible.quantity,
      'commissionPerUnitIqd', eligible.amount_per_unit_iqd,
      'amountIqd', eligible.amount_iqd
    ) ORDER BY eligible.ordinality), '[]'::jsonb),
    COALESCE(sum(eligible.amount_iqd), 0)
  INTO v_entries, v_total
  FROM eligible;

  v_result := jsonb_build_object(
    'agentId', p_agent_id,
    'agentName', v_agent_name,
    'programId', v_program_id,
    'programName', v_program_name,
    'tierId', v_tier_id,
    'tierName', v_tier_name,
    'qualifyingSalesBefore', v_sales_before,
    'qualifyingSalesAfter', v_sales_before + 1,
    'monthStart', v_cycle.month_start,
    'timeZone', v_cycle.time_zone,
    'entries', v_entries,
    'totalAmountIqd', v_total
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_tiered_commission_order_draft_estimate(uuid, uuid, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tiered_commission_order_draft_estimate(uuid, uuid, timestamptz, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
