CREATE OR REPLACE FUNCTION public.current_user_has_coach_permission(
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.current_user_role() = 'staff'
    AND private.current_user_has_workspace_permission(p_workspace_id, 'coach');
$function$;

REVOKE ALL ON FUNCTION public.current_user_has_coach_permission(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_has_coach_permission(uuid) TO authenticated, service_role;

-- Keep the existing write-access guard intact, including its behavior when
-- workspace permissions are disabled, except that Coach alone is read-only.
CREATE OR REPLACE FUNCTION public.current_user_can_access_sales_orders(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    JOIN public.profiles AS profile
      ON profile.id = (SELECT auth.uid())
    WHERE workspace.id = p_workspace_id
      AND profile.current_workspace = workspace.id
      AND workspace.deleted_at IS NULL
      AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'orders')
      AND (
        profile.role = 'admin'
        OR (
          NOT public.workspace_capability_allowed(
            workspace.id,
            workspace.plan::text,
            'workspaceManagementPermissions'
          )
          AND NOT (
            profile.role = 'staff'
            AND private.current_user_has_workspace_permission(workspace.id, 'coach')
          )
        )
        OR EXISTS (
          SELECT 1
          FROM public.workspace_permissions AS permission
          WHERE permission.workspace_id = workspace.id
            AND permission.user_uuid = profile.id
            AND permission.key = 'orders.saleOrdersAccess'
        )
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.current_user_can_access_sales_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_can_access_sales_orders(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_user_can_view_sales_orders(
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.current_user_can_access_sales_orders(p_workspace_id)
    OR (
      public.current_user_has_coach_permission(p_workspace_id)
      AND EXISTS (
        SELECT 1
        FROM public.workspaces AS workspace
        WHERE workspace.id = p_workspace_id
          AND workspace.deleted_at IS NULL
      )
    );
$function$;

REVOKE ALL ON FUNCTION public.current_user_can_view_sales_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_can_view_sales_orders(uuid) TO authenticated, service_role;

-- The Coach grant also makes Sale Orders available on plans without the
-- Orders module. Row access remains limited to orders created by that Coach.
DROP POLICY IF EXISTS crm_sales_orders_select ON crm.sales_orders;
CREATE POLICY crm_sales_orders_select
  ON crm.sales_orders
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (
      public.workspace_module_allowed(
        workspace_id,
        (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = sales_orders.workspace_id),
        'orders'
      )
      OR public.current_user_has_coach_permission(workspace_id)
    )
    AND (
      NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
      OR created_by = (SELECT auth.uid())
      OR private.sales_agent_commissions_can_view_assigned_order(workspace_id, id)
      OR private.agent_sales_accounts_can_view_own_order(workspace_id, sales_account_agent_id)
    )
    AND (
      (
        business_partner_id IS NOT NULL
        AND crm.can_access_business_partner(workspace_id, business_partner_id, 'customer')
      )
      OR (
        business_partner_id IS NULL
        AND crm.can_access_customer_link(workspace_id, customer_id)
      )
      OR public.current_user_has_coach_permission(workspace_id)
    )
  );

-- Coach receives read access to the sales-order module without the persisted
-- orders.saleOrdersAccess key. The existing actor guard continues to protect
-- writes with that explicit key.
DROP POLICY IF EXISTS crm_sales_orders_actor_select_guard ON crm.sales_orders;
CREATE POLICY crm_sales_orders_actor_select_guard
  ON crm.sales_orders
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    public.current_user_can_view_sales_orders(workspace_id)
    AND (
      NOT public.current_user_has_coach_permission(workspace_id)
      OR created_by = (SELECT auth.uid())
    )
  );

-- Service-category row privacy must not hide a Coach's own Sale Order. The
-- override applies only to the order row and only while Coach is assigned.
DROP POLICY IF EXISTS crm_sales_orders_service_category_access ON crm.sales_orders;
CREATE POLICY crm_sales_orders_service_category_access
  ON crm.sales_orders
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    (
      public.current_user_has_coach_permission(workspace_id)
      AND created_by = (SELECT auth.uid())
    )
    OR public.sales_order_service_details_visible(auth.uid(), workspace_id, items)
  );

-- Preserve order-installment reads for a Coach's own Sale Orders on plans that
-- do not include Orders. Purchase-order installments keep the original gate.
DROP POLICY IF EXISTS crm_order_installments_select ON crm.order_installments;
CREATE POLICY crm_order_installments_select
  ON crm.order_installments
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (
      public.workspace_module_allowed(
        workspace_id,
        (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = order_installments.workspace_id),
        'orders'
      )
      OR (
        order_type = 'sales'
        AND public.current_user_has_coach_permission(workspace_id)
      )
    )
    AND (
      (
        order_type = 'sales'
        AND EXISTS (
          SELECT 1
          FROM crm.sales_orders AS sales_order
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
          SELECT 1
          FROM crm.purchase_orders AS purchase_order
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

-- Keep the automatic Coach grant read-only for sales installments, even when
-- the workspace's Orders plan module is enabled. Independent access remains
-- governed by the existing sales-order access helper.
DROP POLICY IF EXISTS crm_order_installments_coach_insert_guard ON crm.order_installments;
CREATE POLICY crm_order_installments_coach_insert_guard
  ON crm.order_installments
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    order_type <> 'sales'
    OR NOT public.current_user_has_coach_permission(workspace_id)
    OR public.current_user_can_access_sales_orders(workspace_id)
  );

DROP POLICY IF EXISTS crm_order_installments_coach_update_guard ON crm.order_installments;
CREATE POLICY crm_order_installments_coach_update_guard
  ON crm.order_installments
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (
    order_type <> 'sales'
    OR NOT public.current_user_has_coach_permission(workspace_id)
    OR public.current_user_can_access_sales_orders(workspace_id)
  )
  WITH CHECK (
    order_type <> 'sales'
    OR NOT public.current_user_has_coach_permission(workspace_id)
    OR public.current_user_can_access_sales_orders(workspace_id)
  );

DROP POLICY IF EXISTS crm_order_installments_coach_delete_guard ON crm.order_installments;
CREATE POLICY crm_order_installments_coach_delete_guard
  ON crm.order_installments
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (
    order_type <> 'sales'
    OR NOT public.current_user_has_coach_permission(workspace_id)
    OR public.current_user_can_access_sales_orders(workspace_id)
  );

-- The Coach permission is managed separately from workspace permissions, so
-- the signed-in staff member and admins can still read the Coach grant when
-- the workspace-management-permissions capability is not enabled.
DROP POLICY IF EXISTS workspace_permissions_select ON public.workspace_permissions;
CREATE POLICY workspace_permissions_select
  ON public.workspace_permissions
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (
      public.workspace_plan_has_capability(
        (SELECT workspace.plan FROM public.workspaces AS workspace WHERE workspace.id = workspace_permissions.workspace_id),
        'workspaceManagementPermissions'
      )
      OR key = 'coach'
    )
    AND (
      user_uuid = auth.uid()
      OR public.current_user_role() = 'admin'
    )
  );
