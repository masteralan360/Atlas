-- Evaluate user/workspace-wide order permissions once per statement instead
-- of once for every sales order row scanned by the server-paged list.
DROP POLICY IF EXISTS crm_sales_orders_actor_select_guard ON crm.sales_orders;
CREATE POLICY crm_sales_orders_actor_select_guard
  ON crm.sales_orders
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = (SELECT public.current_workspace_id())
    AND (SELECT public.current_user_can_view_sales_orders((SELECT public.current_workspace_id())))
    AND (
      NOT (SELECT public.current_user_has_coach_permission((SELECT public.current_workspace_id())))
      OR created_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS crm_sales_orders_select ON crm.sales_orders;
CREATE POLICY crm_sales_orders_select
  ON crm.sales_orders
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = (SELECT public.current_workspace_id())
    AND (
      (SELECT public.workspace_module_allowed(
        (SELECT public.current_workspace_id()),
        (SELECT workspace.plan::text
         FROM public.workspaces AS workspace
         WHERE workspace.id = (SELECT public.current_workspace_id())),
        'orders'
      ))
      OR (SELECT public.current_user_has_coach_permission((SELECT public.current_workspace_id())))
    )
    AND (
      NOT (SELECT public.current_user_has_view_own_permission('orders.view_own'))
      OR created_by = (SELECT auth.uid())
      OR private.sales_agent_commissions_can_view_assigned_order(
        (SELECT public.current_workspace_id()), id
      )
      OR private.agent_sales_accounts_can_view_own_order(
        (SELECT public.current_workspace_id()), sales_account_agent_id
      )
    )
    AND (
      (
        business_partner_id IS NOT NULL
        AND crm.can_access_business_partner(
          (SELECT public.current_workspace_id()), business_partner_id, 'customer'
        )
      )
      OR (
        business_partner_id IS NULL
        AND crm.can_access_customer_link(
          (SELECT public.current_workspace_id()), customer_id
        )
      )
      OR (SELECT public.current_user_has_coach_permission((SELECT public.current_workspace_id())))
    )
  );

-- Service visibility still depends on each row's item snapshot, but the user
-- and workspace context are request-wide and can be initialized once.
DROP POLICY IF EXISTS crm_sales_orders_service_category_access ON crm.sales_orders;
CREATE POLICY crm_sales_orders_service_category_access
  ON crm.sales_orders
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    public.sales_order_service_details_visible(
      (SELECT auth.uid()),
      (SELECT public.current_workspace_id()),
      items
    )
  );

-- Most users have no storage exclusions. In that case all order items are
-- visible, so expanding every JSON array and invoking the storage access
-- function for every line is unnecessary.
DO $optimize_orders_list_storage_checks$
DECLARE
  v_signature constant regprocedure :=
    'crm.get_orders_list_page_optimized(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, text, text, text, text, text, boolean, integer, integer, boolean)'::regprocedure;
  v_definition text;
  v_original text;
  v_visible_projection text := E'      COALESCE(visible.items, ''[]''::jsonb) AS visible_items,\n      COALESCE(visible.visible_count, 0) AS visible_item_count,\n      COALESCE(jsonb_array_length(raw_orders.items), 0) AS original_item_count,\n      COALESCE(visible.visible_subtotal, 0) AS visible_subtotal';
  v_fast_visible_projection text := E'      CASE\n        WHEN (SELECT storage_restricted FROM normalized)\n          THEN COALESCE(visible.items, ''[]''::jsonb)\n        ELSE COALESCE(raw_orders.items, ''[]''::jsonb)\n      END AS visible_items,\n      CASE\n        WHEN (SELECT storage_restricted FROM normalized)\n          THEN COALESCE(visible.visible_count, 0)\n        ELSE COALESCE(jsonb_array_length(raw_orders.items), 0)\n      END AS visible_item_count,\n      COALESCE(jsonb_array_length(raw_orders.items), 0) AS original_item_count,\n      CASE\n        WHEN (SELECT storage_restricted FROM normalized)\n          THEN COALESCE(visible.visible_subtotal, 0)\n        ELSE 0\n      END AS visible_subtotal';
  v_item_expansion text := E'      FROM jsonb_array_elements(COALESCE(raw_orders.items, ''[]''::jsonb)) WITH ORDINALITY AS item(value, ordinality)';
  v_guarded_item_expansion text := E'      FROM jsonb_array_elements(\n        CASE\n          WHEN (SELECT storage_restricted FROM normalized)\n            THEN COALESCE(raw_orders.items, ''[]''::jsonb)\n          ELSE ''[]''::jsonb\n        END\n      ) WITH ORDINALITY AS item(value, ordinality)';
  v_source_storage_check text := E'          WHEN public.current_user_can_access_storage(redacted_orders.workspace_id, NULLIF(redacted_orders.order_json ->> ''source_storage_id'', '''')::uuid)\n            THEN redacted_orders.order_json -> ''source_storage_id''';
  v_fast_source_storage_check text := E'          WHEN NOT (SELECT storage_restricted FROM normalized)\n            THEN redacted_orders.order_json -> ''source_storage_id''\n          WHEN public.current_user_can_access_storage(redacted_orders.workspace_id, NULLIF(redacted_orders.order_json ->> ''source_storage_id'', '''')::uuid)\n            THEN redacted_orders.order_json -> ''source_storage_id''';
  v_destination_storage_check text := E'          WHEN public.current_user_can_access_storage(redacted_orders.workspace_id, NULLIF(redacted_orders.order_json ->> ''destination_storage_id'', '''')::uuid)\n            THEN redacted_orders.order_json -> ''destination_storage_id''';
  v_fast_destination_storage_check text := E'          WHEN NOT (SELECT storage_restricted FROM normalized)\n            THEN redacted_orders.order_json -> ''destination_storage_id''\n          WHEN public.current_user_can_access_storage(redacted_orders.workspace_id, NULLIF(redacted_orders.order_json ->> ''destination_storage_id'', '''')::uuid)\n            THEN redacted_orders.order_json -> ''destination_storage_id''';
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');
  v_original := v_definition;

  v_definition := replace(v_definition, v_visible_projection, v_fast_visible_projection);
  v_definition := replace(v_definition, v_item_expansion, v_guarded_item_expansion);
  v_definition := replace(v_definition, v_source_storage_check, v_fast_source_storage_check);
  v_definition := replace(v_definition, v_destination_storage_check, v_fast_destination_storage_check);

  IF v_definition = v_original
    OR position('ELSE ''[]''::jsonb' IN v_definition) = 0
    OR position('WHEN NOT (SELECT storage_restricted FROM normalized)' IN v_definition) = 0
    OR position('THEN COALESCE(visible.items' IN v_definition) = 0
    OR position('THEN COALESCE(visible.visible_count' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Could not safely optimize storage checks in %', v_signature;
  END IF;

  EXECUTE v_definition;
END;
$optimize_orders_list_storage_checks$;

NOTIFY pgrst, 'reload schema';
