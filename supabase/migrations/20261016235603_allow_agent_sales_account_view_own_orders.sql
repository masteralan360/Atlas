-- Agent Sales Account attribution is an additional own-record relationship
-- for sales orders. It remains independent from commission permissions.

CREATE OR REPLACE FUNCTION private.agent_sales_accounts_can_view_own_order(
  p_workspace_id uuid,
  p_sales_account_agent_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p_sales_account_agent_id IS NOT NULL
    AND (SELECT auth.uid()) IS NOT NULL
    AND public.current_user_has_view_own_permission('orders.view_own')
    AND EXISTS (
      SELECT 1
      FROM public.workspaces AS workspace
      WHERE workspace.id = p_workspace_id
        AND workspace.deleted_at IS NULL
        AND public.workspace_module_allowed(
          workspace.id,
          workspace.plan::text,
          'agent_sales_accounts'
        )
    )
    AND EXISTS (
      SELECT 1
      FROM crm.agents AS agent
      WHERE agent.id = p_sales_account_agent_id
        AND agent.workspace_id = p_workspace_id
        AND agent.agent_type = 'field_agent'
        AND agent.linked_user_id = (SELECT auth.uid())
        AND COALESCE(agent.is_deleted, false) = false
    );
$function$;

REVOKE ALL ON FUNCTION private.agent_sales_accounts_can_view_own_order(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.agent_sales_accounts_can_view_own_order(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS crm_sales_orders_select ON crm.sales_orders;
CREATE POLICY crm_sales_orders_select
  ON crm.sales_orders
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = sales_orders.workspace_id),
      'orders'
    )
    AND (
      NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
      OR created_by = (SELECT auth.uid())
      OR private.sales_agent_commissions_can_view_assigned_order(workspace_id, id)
      OR private.agent_sales_accounts_can_view_own_order(workspace_id, sales_account_agent_id)
    )
    AND (
      (business_partner_id IS NOT NULL AND crm.can_access_business_partner(workspace_id, business_partner_id, 'customer'))
      OR (
        business_partner_id IS NULL
        AND crm.can_access_customer_link(workspace_id, customer_id)
      )
    )
  );

DROP POLICY IF EXISTS crm_order_installments_select ON crm.order_installments;
CREATE POLICY crm_order_installments_select
  ON crm.order_installments
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = order_installments.workspace_id),
      'orders'
    )
    AND (
      (
        order_type = 'sales'
        AND EXISTS (
          SELECT 1 FROM crm.sales_orders AS sales_order
          WHERE sales_order.id = order_installments.order_id
            AND sales_order.workspace_id = order_installments.workspace_id
            AND (
              NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
              OR sales_order.created_by = (SELECT auth.uid())
              OR private.sales_agent_commissions_can_view_assigned_order(
                order_installments.workspace_id,
                sales_order.id
              )
              OR private.agent_sales_accounts_can_view_own_order(
                order_installments.workspace_id,
                sales_order.sales_account_agent_id
              )
            )
        )
      )
      OR (
        order_type = 'purchase'
        AND EXISTS (
          SELECT 1 FROM crm.purchase_orders AS purchase_order
          WHERE purchase_order.id = order_installments.order_id
            AND purchase_order.workspace_id = order_installments.workspace_id
            AND (
              NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
              OR purchase_order.created_by = (SELECT auth.uid())
            )
        )
      )
    )
  );

DROP POLICY IF EXISTS order_returns_select ON public.order_returns;
CREATE POLICY order_returns_select
  ON public.order_returns
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1 FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = order_returns.order_id
        AND sales_order.workspace_id = order_returns.workspace_id
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
          OR sales_order.created_by = (SELECT auth.uid())
          OR private.sales_agent_commissions_can_view_assigned_order(
            order_returns.workspace_id,
            sales_order.id
          )
          OR private.agent_sales_accounts_can_view_own_order(
            order_returns.workspace_id,
            sales_order.sales_account_agent_id
          )
        )
    )
  );

DROP POLICY IF EXISTS order_return_items_select ON public.order_return_items;
CREATE POLICY order_return_items_select
  ON public.order_return_items
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1 FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = order_return_items.order_id
        AND sales_order.workspace_id = order_return_items.workspace_id
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
          OR sales_order.created_by = (SELECT auth.uid())
          OR private.sales_agent_commissions_can_view_assigned_order(
            order_return_items.workspace_id,
            sales_order.id
          )
          OR private.agent_sales_accounts_can_view_own_order(
            order_return_items.workspace_id,
            sales_order.sales_account_agent_id
          )
        )
    )
  );
