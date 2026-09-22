-- Fix 42P17: the original return helper read crm.sales_orders while it was
-- called by a crm.sales_orders UPDATE policy. Keep the helper to actor and
-- workspace authorization only; policies on return records own lifecycle and
-- View Own validation.
CREATE OR REPLACE FUNCTION public.current_user_can_return_sales_order(
  p_workspace_id uuid,
  p_order_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, crm
AS $function$
  SELECT
    p_workspace_id = public.current_workspace_id()
    AND p_order_id IS NOT NULL
    AND (
      public.current_user_role() = 'admin'
      OR (
        public.current_user_role() = 'staff'
        AND EXISTS (
          SELECT 1
          FROM public.workspace_permissions AS permission
          WHERE permission.workspace_id = p_workspace_id
            AND permission.user_uuid = (SELECT auth.uid())
            AND permission.key = 'orders.saleOrdersAccess'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.workspace_permissions AS permission
          WHERE permission.workspace_id = p_workspace_id
            AND permission.user_uuid = (SELECT auth.uid())
            AND permission.key = 'orders.requireSalesOrderRequest'
        )
      )
    );
$function$;

REVOKE ALL ON FUNCTION public.current_user_can_return_sales_order(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_can_return_sales_order(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS order_returns_insert ON public.order_returns;
CREATE POLICY order_returns_insert
  ON public.order_returns
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_can_return_sales_order(workspace_id, order_id)
    AND EXISTS (
      SELECT 1
      FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = order_returns.order_id
        AND sales_order.workspace_id = order_returns.workspace_id
        AND sales_order.status = 'completed'
        AND sales_order.return_status <> 'full'
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
          OR sales_order.created_by = (SELECT auth.uid())
        )
    )
    AND (
      public.current_user_role() = 'admin'
      OR returned_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS order_returns_update ON public.order_returns;
CREATE POLICY order_returns_update
  ON public.order_returns
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_can_return_sales_order(workspace_id, order_id)
    AND EXISTS (
      SELECT 1
      FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = order_returns.order_id
        AND sales_order.workspace_id = order_returns.workspace_id
        AND sales_order.status = 'completed'
        AND sales_order.return_status <> 'full'
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
          OR sales_order.created_by = (SELECT auth.uid())
        )
    )
    AND (
      public.current_user_role() = 'admin'
      OR returned_by = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_can_return_sales_order(workspace_id, order_id)
    AND EXISTS (
      SELECT 1
      FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = order_returns.order_id
        AND sales_order.workspace_id = order_returns.workspace_id
        AND sales_order.status = 'completed'
        AND sales_order.return_status <> 'full'
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
          OR sales_order.created_by = (SELECT auth.uid())
        )
    )
    AND (
      public.current_user_role() = 'admin'
      OR returned_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS order_return_items_insert ON public.order_return_items;
CREATE POLICY order_return_items_insert
  ON public.order_return_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.order_returns AS order_return
      JOIN crm.sales_orders AS sales_order
        ON sales_order.id = order_return_items.order_id
        AND sales_order.workspace_id = order_return_items.workspace_id
      WHERE order_return.id = order_return_items.return_id
        AND order_return.order_id = order_return_items.order_id
        AND order_return.workspace_id = order_return_items.workspace_id
        AND public.current_user_can_return_sales_order(
          order_return_items.workspace_id,
          order_return_items.order_id
        )
        AND sales_order.status = 'completed'
        AND sales_order.return_status <> 'full'
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
          OR sales_order.created_by = (SELECT auth.uid())
        )
        AND (
          public.current_user_role() = 'admin'
          OR order_return.returned_by = (SELECT auth.uid())
        )
    )
  );

DROP POLICY IF EXISTS order_return_items_update ON public.order_return_items;
CREATE POLICY order_return_items_update
  ON public.order_return_items
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.order_returns AS order_return
      JOIN crm.sales_orders AS sales_order
        ON sales_order.id = order_return_items.order_id
        AND sales_order.workspace_id = order_return_items.workspace_id
      WHERE order_return.id = order_return_items.return_id
        AND order_return.order_id = order_return_items.order_id
        AND order_return.workspace_id = order_return_items.workspace_id
        AND public.current_user_can_return_sales_order(
          order_return_items.workspace_id,
          order_return_items.order_id
        )
        AND sales_order.status = 'completed'
        AND sales_order.return_status <> 'full'
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
          OR sales_order.created_by = (SELECT auth.uid())
        )
        AND (
          public.current_user_role() = 'admin'
          OR order_return.returned_by = (SELECT auth.uid())
        )
    )
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.order_returns AS order_return
      JOIN crm.sales_orders AS sales_order
        ON sales_order.id = order_return_items.order_id
        AND sales_order.workspace_id = order_return_items.workspace_id
      WHERE order_return.id = order_return_items.return_id
        AND order_return.order_id = order_return_items.order_id
        AND order_return.workspace_id = order_return_items.workspace_id
        AND public.current_user_can_return_sales_order(
          order_return_items.workspace_id,
          order_return_items.order_id
        )
        AND sales_order.status = 'completed'
        AND sales_order.return_status <> 'full'
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
          OR sales_order.created_by = (SELECT auth.uid())
        )
        AND (
          public.current_user_role() = 'admin'
          OR order_return.returned_by = (SELECT auth.uid())
        )
    )
  );

-- The aggregate guard must not query order_returns: that table's SELECT policy
-- reads crm.sales_orders and would re-create the same circular dependency.
DROP POLICY IF EXISTS crm_sales_orders_return_update_guard ON crm.sales_orders;
CREATE POLICY crm_sales_orders_return_update_guard
  ON crm.sales_orders
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (
    (
      return_status = 'none'
      AND returned_amount = 0
      AND returned_at IS NULL
      AND returned_by IS NULL
    )
    OR public.current_user_role() = 'admin'
    OR (
      public.current_user_can_return_sales_order(workspace_id, id)
      AND status = 'completed'
      AND return_status <> 'full'
      AND (
        NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
        OR created_by = (SELECT auth.uid())
      )
    )
  )
  WITH CHECK (
    (
      return_status = 'none'
      AND returned_amount = 0
      AND returned_at IS NULL
      AND returned_by IS NULL
    )
    OR public.current_user_role() = 'admin'
    OR (
      public.current_user_can_return_sales_order(workspace_id, id)
      AND status = 'completed'
      AND return_status IN ('partial', 'full')
      AND returned_by = (SELECT auth.uid())
      AND (
        NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
        OR created_by = (SELECT auth.uid())
      )
    )
  );
