-- Expose the immutable tier-based commission snapshot for one authorized order.
CREATE OR REPLACE FUNCTION public.get_tiered_commission_order_preview(
  p_workspace_id uuid,
  p_order_id uuid
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
  v_result jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
  THEN
    RAISE EXCEPTION 'Tiered commission access is restricted to the current workspace' USING ERRCODE = '42501';
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

  SELECT jsonb_build_object(
    'agentId', sale.agent_id,
    'agentName', COALESCE(partner.partner_name, sale.agent_id::text),
    'programName', sale.program_name_snapshot,
    'tierName', sale.tier_name_snapshot,
    'saleStatus', sale.status,
    'monthStart', cycle.month_start,
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', entry.id,
        'productId', entry.product_id,
        'productName', entry.product_name_snapshot,
        'productSku', entry.product_sku_snapshot,
        'programName', entry.program_name_snapshot,
        'tierName', entry.tier_name_snapshot,
        'quantity', entry.quantity,
        'commissionPerUnitIqd', entry.commission_per_unit_iqd,
        'amountIqd', entry.amount_iqd,
        'kind', entry.kind,
        'status', entry.status,
        'occurredAt', entry.occurred_at,
        'relatedEntryId', entry.related_entry_id
      ) ORDER BY entry.occurred_at, entry.id)
      FROM crm.tiered_commission_entries AS entry
      WHERE entry.workspace_id = p_workspace_id
        AND entry.sales_order_id = p_order_id
        AND entry.agent_id = sale.agent_id
    ), '[]'::jsonb),
    'totalAmountIqd', COALESCE((
      SELECT sum(entry.amount_iqd)
      FROM crm.tiered_commission_entries AS entry
      WHERE entry.workspace_id = p_workspace_id
        AND entry.sales_order_id = p_order_id
        AND entry.agent_id = sale.agent_id
    ), 0)
  ) INTO v_result
  FROM crm.tiered_commission_sales AS sale
  JOIN crm.agents AS agent
    ON agent.id = sale.agent_id AND agent.workspace_id = sale.workspace_id
  JOIN crm.business_partners AS partner
    ON partner.id = agent.business_partner_id AND partner.workspace_id = agent.workspace_id
  LEFT JOIN crm.tiered_commission_cycles AS cycle
    ON cycle.id = sale.cycle_id AND cycle.workspace_id = sale.workspace_id
  WHERE sale.workspace_id = p_workspace_id
    AND sale.sales_order_id = p_order_id
    AND (v_can_view_all OR (v_can_view_own AND agent.linked_user_id = (SELECT auth.uid())))
  LIMIT 1;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_tiered_commission_order_preview(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tiered_commission_order_preview(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
