BEGIN;
SELECT plan(9);

SELECT ok(
  to_regprocedure('public.current_user_can_return_sales_order(uuid,uuid)') IS NOT NULL,
  'the sales-order return authorization helper is installed'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'order_returns'
      AND policyname = 'order_returns_insert'
  ),
  'order return inserts have an explicit policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'order_return_items'
      AND policyname = 'order_return_items_insert'
  ),
  'order return item inserts have an explicit policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'crm'
      AND tablename = 'sales_orders'
      AND policyname = 'crm_sales_orders_return_update_guard'
      AND permissive = 'RESTRICTIVE'
  ),
  'sales-order return aggregate updates have a restrictive policy'
);

SELECT like(
  pg_get_functiondef('public.current_user_can_return_sales_order(uuid,uuid)'::regprocedure),
  '%orders.saleOrdersAccess%',
  'the helper requires Sales Order Access'
);

SELECT like(
  pg_get_functiondef('public.current_user_can_return_sales_order(uuid,uuid)'::regprocedure),
  '%orders.requireSalesOrderRequest%',
  'the helper denies staff with required sales-order requests'
);

SELECT like(
  pg_get_functiondef('public.current_user_can_return_sales_order(uuid,uuid)'::regprocedure),
  '%orders.view_own%',
  'the helper applies the View Own scope'
);

SELECT like(
  (SELECT with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'order_returns' AND policyname = 'order_returns_insert'),
  '%returned_by%',
  'staff return headers are bound to the authenticated user'
);

SELECT like(
  (SELECT with_check FROM pg_policies WHERE schemaname = 'crm' AND tablename = 'sales_orders' AND policyname = 'crm_sales_orders_return_update_guard'),
  '%authorized_return%',
  'a staff aggregate update requires an authorized return record'
);

SELECT * FROM finish();
ROLLBACK;
