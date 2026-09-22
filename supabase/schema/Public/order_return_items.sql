CREATE TABLE public.order_return_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  return_id uuid NOT NULL REFERENCES public.order_returns(id),
  order_id uuid NOT NULL REFERENCES crm.sales_orders(id),
  order_item_id text NOT NULL,
  quantity numeric NOT NULL,
  unit_refund_amount numeric NOT NULL DEFAULT 0,
  refund_amount numeric NOT NULL DEFAULT 0,
  restored_storage_id uuid NULL REFERENCES public.storages(id),
  restored_batch_allocations jsonb NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT order_return_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT order_return_items_unit_refund_amount_check CHECK (unit_refund_amount >= 0),
  CONSTRAINT order_return_items_refund_amount_check CHECK (refund_amount >= 0),
  CONSTRAINT order_return_items_return_line_key UNIQUE (return_id, order_item_id),
  PRIMARY KEY (id)
);

ALTER TABLE public.order_return_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_return_items_select ON public.order_return_items;
CREATE POLICY order_return_items_select
  ON public.order_return_items
  FOR SELECT
  TO authenticated
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
        )
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
      WHERE order_return.id = order_return_items.return_id
        AND order_return.order_id = order_return_items.order_id
        AND order_return.workspace_id = order_return_items.workspace_id
        AND public.current_user_can_return_sales_order(
          order_return_items.workspace_id,
          order_return_items.order_id
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
      WHERE order_return.id = order_return_items.return_id
        AND order_return.order_id = order_return_items.order_id
        AND order_return.workspace_id = order_return_items.workspace_id
        AND public.current_user_can_return_sales_order(
          order_return_items.workspace_id,
          order_return_items.order_id
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
      WHERE order_return.id = order_return_items.return_id
        AND order_return.order_id = order_return_items.order_id
        AND order_return.workspace_id = order_return_items.workspace_id
        AND public.current_user_can_return_sales_order(
          order_return_items.workspace_id,
          order_return_items.order_id
        )
        AND (
          public.current_user_role() = 'admin'
          OR order_return.returned_by = (SELECT auth.uid())
        )
    )
  );
