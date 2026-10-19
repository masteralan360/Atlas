BEGIN;
SELECT plan(17);

SELECT ok(
  to_regprocedure('public.can_access_service(uuid,uuid)') IS NOT NULL,
  'the centralized service access decision is installed'
);

SELECT ok(
  position('OR NOT EXISTS (' IN pg_get_functiondef('public.can_access_service(uuid,uuid)'::regprocedure)) > 0
  AND position('OR EXISTS (' IN pg_get_functiondef('public.can_access_service(uuid,uuid)'::regprocedure)) > 0
  AND position('public.service_access_category_members' IN pg_get_functiondef('public.can_access_service(uuid,uuid)'::regprocedure)) > 0
  AND position('service_legacy_workspace_access' IN pg_get_functiondef('public.can_access_service(uuid,uuid)'::regprocedure)) = 0,
  'unassigned services are open while assigned services use OR semantics across category memberships'
);

SELECT like(
  pg_get_functiondef('public.can_access_service(uuid,uuid)'::regprocedure),
  '%p_user_id = auth.uid()%current_workspace_id()%service_access_user_in_workspace%',
  'service access is bound to the authenticated user and an active workspace member'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'service_access_members_workspace_user_idx'
  )
  AND EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'service_access_services_workspace_service_idx'
  ),
  'membership and service assignments have lookup indexes'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.get_service_access_workspace_members(uuid)'::regprocedure
      AND prosecdef
  ),
  'workspace member options are loaded in one administrator-scoped query'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid = 'public.service_access_category_members'::regclass
      AND indisprimary
  )
  AND EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid = 'public.service_access_category_services'::regclass
      AND indisprimary
  ),
  'user-category and service-category assignments cannot be duplicated'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'service_access_categories_workspace_name_unique'
  ),
  'category names are unique within a workspace'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.service_access_categories'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.service_access_category_members'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.service_access_category_services'::regclass),
  'access category tables have row-level security enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND policyname = 'products_service_category_access'
      AND permissive = 'RESTRICTIVE'
  ),
  'product reads apply a restrictive service access policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND policyname = 'products_service_category_update'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_images'
      AND policyname = 'product_images_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_barcodes'
      AND policyname = 'product_barcodes_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_uoms'
      AND policyname = 'product_uoms_service_category_access'
      AND permissive = 'RESTRICTIVE'
  ),
  'service access covers product writes and linked catalog metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.get_accessible_service_ids(uuid)'::regprocedure
      AND NOT prosecdef
  ),
  'bulk accessible-service reads use one invoker-scoped query'
);

SELECT like(
  pg_get_functiondef('public.search_products_for_autocomplete(uuid,text,uuid[],uuid[],integer)'::regprocedure),
  '%can_access_service(auth.uid(), product.id)%',
  'the optimized autocomplete RPC filters service rows in its database query'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.sale_items'::regclass
      AND tgname = 'sale_items_enforce_service_access'
      AND NOT tgisinternal
  )
  AND like(
    pg_get_functiondef('public.enforce_service_access_on_sale_item()'::regprocedure),
    '%can_access_service(auth.uid(), NEW.product_id)%'
  ),
  'POS sale inserts validate service access in the database'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'crm.sales_orders'::regclass
      AND tgname = 'trg_enforce_service_sales_order_items'
      AND NOT tgisinternal
  )
  AND like(
    pg_get_functiondef('crm.enforce_service_order_items()'::regprocedure),
    '%can_access_service(auth.uid(), v_product_id)%'
  ),
  'sales-order and quick-order JSON lines validate service access in the database'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sales'
      AND policyname = 'sales_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sale_items'
      AND policyname = 'sale_items_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'crm'
      AND tablename = 'sales_orders'
      AND policyname = 'crm_sales_orders_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sale_returns'
      AND policyname = 'sale_returns_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sale_return_items'
      AND policyname = 'sale_return_items_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'order_returns'
      AND policyname = 'order_returns_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'order_return_items'
      AND policyname = 'order_return_items_service_category_access'
      AND permissive = 'RESTRICTIVE'
  )
  AND like(
    pg_get_functiondef('public.get_top_products(uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure),
    '%sale_service_details_visible(auth.uid(), sale.workspace_id, sale.id)%'
  ),
  'historical service details are hidden from users without current access'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.service_access_category_members'::regclass
      AND tgname = 'service_access_category_member_workspace_guard'
      AND NOT tgisinternal
  )
  AND EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.service_access_category_services'::regclass
      AND tgname = 'service_access_category_service_workspace_guard'
      AND NOT tgisinternal
  ),
  'membership and service assignments reject cross-workspace references'
);

SELECT ok(
  (SELECT count(*) = 5 FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'sale_returns_enforce_service_access',
        'sale_return_items_enforce_service_access',
        'order_returns_enforce_service_access',
        'order_return_items_enforce_service_access',
        'sale_product_exchanges_enforce_service_access'
      ))
  AND EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sale_product_exchanges'
      AND policyname = 'sale_product_exchanges_service_category_access'
      AND permissive = 'RESTRICTIVE'
  ),
  'service access is enforced on historical return and exchange workflows'
);

SELECT * FROM finish();
ROLLBACK;
