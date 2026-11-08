CREATE OR REPLACE FUNCTION public.get_coach_recent_intake_orders(
  p_workspace_id uuid,
  p_coach_user_id uuid,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 10,
  p_created_from timestamptz DEFAULT NULL,
  p_created_before timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_page integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size integer := COALESCE(p_page_size, 10);
  v_offset bigint;
  v_total_count bigint := 0;
  v_unpaid_count bigint := 0;
  v_totals jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM p_workspace_id
    OR NOT EXISTS (
      SELECT 1
      FROM public.workspaces AS workspace
      WHERE workspace.id = p_workspace_id
        AND workspace.deleted_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'Coach intake access is restricted to the current workspace' USING ERRCODE = '42501';
  END IF;

  IF v_page_size NOT IN (5, 10, 20) OR p_created_from >= p_created_before THEN
    RAISE EXCEPTION 'Invalid coach intake page or date range' USING ERRCODE = '22023';
  END IF;

  IF public.current_user_role() = 'staff' THEN
    IF p_coach_user_id IS DISTINCT FROM v_user_id
      OR NOT public.current_user_has_coach_permission(p_workspace_id)
    THEN
      RAISE EXCEPTION 'Coach intake access is limited to your own Sale Orders' USING ERRCODE = '42501';
    END IF;
  ELSIF public.current_user_role() = 'admin' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.workspaces AS workspace
      WHERE workspace.id = p_workspace_id
        AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'commerce_operations')
    ) THEN
      RAISE EXCEPTION 'Coach intake access is unavailable' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Coach intake access is restricted to staff coaches and workspace administrators' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
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
  ) THEN
    RAISE EXCEPTION 'The selected coach is unavailable' USING ERRCODE = '42501';
  END IF;

  v_offset := (v_page - 1)::bigint * v_page_size;

  SELECT
    count(*),
    count(*) FILTER (WHERE COALESCE(sales_order.is_paid, false) = false)
  INTO v_total_count, v_unpaid_count
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.workspace_id = p_workspace_id
    AND sales_order.created_by = p_coach_user_id
    AND COALESCE(sales_order.is_deleted, false) = false
    AND (p_created_from IS NULL OR sales_order.created_at >= p_created_from)
    AND (p_created_before IS NULL OR sales_order.created_at < p_created_before);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'currency', totals.currency,
    'total', totals.total
  ) ORDER BY totals.currency), '[]'::jsonb)
  INTO v_totals
  FROM (
    SELECT lower(COALESCE(NULLIF(sales_order.currency, ''), 'usd')) AS currency,
      sum(COALESCE(sales_order.total, 0)) AS total
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.workspace_id = p_workspace_id
      AND sales_order.created_by = p_coach_user_id
      AND COALESCE(sales_order.is_deleted, false) = false
      AND (p_created_from IS NULL OR sales_order.created_at >= p_created_from)
      AND (p_created_before IS NULL OR sales_order.created_at < p_created_before)
    GROUP BY lower(COALESCE(NULLIF(sales_order.currency, ''), 'usd'))
  ) AS totals;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', page_rows.id,
    'orderNumber', page_rows.order_number,
    'customerName', page_rows.customer_name,
    'status', page_rows.status,
    'isPaid', COALESCE(page_rows.is_paid, false),
    'total', COALESCE(page_rows.total, 0),
    'currency', lower(COALESCE(NULLIF(page_rows.currency, ''), 'usd')),
    'createdAt', page_rows.created_at
  ) ORDER BY page_rows.created_at DESC NULLS LAST, page_rows.id DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT sales_order.id,
      sales_order.order_number,
      sales_order.customer_name,
      sales_order.status,
      sales_order.is_paid,
      sales_order.total,
      sales_order.currency,
      sales_order.created_at
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.workspace_id = p_workspace_id
      AND sales_order.created_by = p_coach_user_id
      AND COALESCE(sales_order.is_deleted, false) = false
      AND (p_created_from IS NULL OR sales_order.created_at >= p_created_from)
      AND (p_created_before IS NULL OR sales_order.created_at < p_created_before)
    ORDER BY sales_order.created_at DESC NULLS LAST, sales_order.id DESC
    LIMIT v_page_size
    OFFSET v_offset
  ) AS page_rows;

  RETURN jsonb_build_object(
    'items', v_items,
    'totalCount', v_total_count,
    'unpaidCount', v_unpaid_count,
    'totalsByCurrency', v_totals
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_coach_recent_intake_orders(uuid, uuid, integer, integer, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_coach_recent_intake_orders(uuid, uuid, integer, integer, timestamptz, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
