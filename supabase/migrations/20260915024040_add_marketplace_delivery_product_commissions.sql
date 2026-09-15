-- Marketplace delivery is an operational attribution, not a sales-account
-- relationship. The field agent linked to the user who confirms delivery earns
-- only the qualifying product commission from that delivery. The marketplace
-- customer remains the sales order's financial counterparty.

ALTER TABLE crm.sales_order_agent_assignments
  DROP CONSTRAINT IF EXISTS sales_order_agent_assignments_source_check,
  ADD CONSTRAINT sales_order_agent_assignments_source_check
    CHECK (
      assignment_source IN (
        'manual',
        'sales_account',
        'order_creator_product',
        'marketplace_delivery_product'
      )
    );

COMMENT ON COLUMN crm.sales_order_agent_assignments.assignment_source IS
  'manual is user-selected, sales_account follows the selected agent account, order_creator_product is product-only attribution derived from the sale creator, and marketplace_delivery_product is product-only attribution derived from the marketplace delivery actor.';

-- The existing core reconciler is responsible for whole-order commission-plan
-- terms. Marketplace delivery assignments, like creator-derived assignments,
-- must be excluded so they never accidentally earn a normal sales plan.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
BEGIN
  SELECT pg_get_functiondef(
    'public.reconcile_sales_agent_commission_core(uuid, uuid)'::regprocedure
  )
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');

  IF position('marketplace_delivery_product' IN v_definition) = 0 THEN
    v_replaced := replace(
      v_definition,
      E'      AND COALESCE(assignment.assignment_source, ''manual'') <> ''order_creator_product''\n',
      E'      AND COALESCE(assignment.assignment_source, ''manual'') NOT IN (''order_creator_product'', ''marketplace_delivery_product'')\n'
    );
    IF v_replaced = v_definition THEN
      RAISE EXCEPTION 'Could not exclude marketplace product-only assignments from core commission reconciliation';
    END IF;
    EXECUTE v_replaced;
  END IF;
END;
$block$;

-- This source is server-derived. A caller cannot claim marketplace delivery
-- commission through the table API; only the private helper below sets the
-- transaction-local guard before inserting it.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
BEGIN
  SELECT pg_get_functiondef(
    'private.enforce_sales_order_agent_assignment_row()'::regprocedure
  )
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');

  IF position('atlas.ensuring_marketplace_delivery_product_commission' IN v_definition) = 0 THEN
    v_replaced := replace(
      v_definition,
      E'  RETURN NEW;\nEND;',
      E'  IF NEW.assignment_source = ''marketplace_delivery_product''\n    AND current_setting(''atlas.ensuring_marketplace_delivery_product_commission'', true) IS DISTINCT FROM ''on''\n  THEN\n    RAISE EXCEPTION ''Marketplace delivery product attribution is system-derived''\n      USING ERRCODE = ''42501'';\n  END IF;\n\n  RETURN NEW;\nEND;'
    );
    IF v_replaced = v_definition THEN
      RAISE EXCEPTION 'Could not protect marketplace delivery product assignments from direct writes';
    END IF;
    EXECUTE v_replaced;
  END IF;
END;
$block$;

CREATE OR REPLACE FUNCTION private.ensure_marketplace_delivery_product_commission_assignment(
  p_order_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order crm.sales_orders%ROWTYPE;
  v_marketplace_order public.marketplace_orders%ROWTYPE;
  v_agent crm.agents%ROWTYPE;
  v_event_at timestamptz;
  v_previous_assignment_id uuid;
  v_previous_unassigned_at timestamptz;
  v_inserted integer := 0;
BEGIN
  SELECT *
  INTO v_order
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_order.source_channel <> 'marketplace'
    OR v_order.marketplace_order_id IS NULL
    OR v_order.status <> 'completed'
    OR COALESCE(v_order.commission_enabled, true) = false
    OR COALESCE(v_order.return_status, 'none') = 'full'
    OR COALESCE(v_order.is_deleted, false)
  THEN
    RETURN 0;
  END IF;

  SELECT *
  INTO v_marketplace_order
  FROM public.marketplace_orders AS marketplace_order
  WHERE marketplace_order.id = v_order.marketplace_order_id
    AND marketplace_order.workspace_id = v_order.workspace_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_marketplace_order.status <> 'delivered'
    OR v_marketplace_order.delivered_by IS NULL
  THEN
    RETURN 0;
  END IF;

  SELECT agent.*
  INTO v_agent
  FROM crm.agents AS agent
  WHERE agent.workspace_id = v_order.workspace_id
    AND agent.linked_user_id = v_marketplace_order.delivered_by
    AND agent.agent_type = 'field_agent'
    AND agent.status = 'active'
    AND COALESCE(agent.is_deleted, false) = false
  ORDER BY agent.id
  LIMIT 1;

  IF NOT FOUND OR EXISTS (
    SELECT 1
    FROM crm.sales_order_agent_assignments AS assignment
    WHERE assignment.workspace_id = v_order.workspace_id
      AND assignment.order_id = v_order.id
      AND assignment.agent_id = v_agent.id
      AND assignment.unassigned_at IS NULL
      AND assignment.is_deleted = false
  ) THEN
    RETURN 0;
  END IF;

  v_event_at := GREATEST(
    COALESCE(v_order.actual_delivery_date, '-infinity'::timestamptz),
    COALESCE(v_marketplace_order.delivered_at, '-infinity'::timestamptz),
    COALESCE(v_order.updated_at, v_order.created_at, now())
  );

  -- Preserve a monotonic assignment timestamp when an earlier assignment for
  -- this agent was unassigned and the delivery is subsequently reconciled.
  SELECT assignment.id, assignment.unassigned_at
  INTO v_previous_assignment_id, v_previous_unassigned_at
  FROM crm.sales_order_agent_assignments AS assignment
  WHERE assignment.workspace_id = v_order.workspace_id
    AND assignment.order_id = v_order.id
    AND assignment.agent_id = v_agent.id
    AND assignment.is_deleted = false
  ORDER BY assignment.assigned_at DESC, assignment.id
  LIMIT 1;
  IF FOUND THEN
    v_event_at := GREATEST(v_event_at, COALESCE(v_previous_unassigned_at, v_event_at));
  END IF;

  -- Do not persist an empty attribution. For selected-recipient rules, the
  -- delivery agent must be explicitly selected; all-assigned rules apply to
  -- this assignment automatically.
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v_order.items) = 'array' THEN v_order.items ELSE '[]'::jsonb END
    ) AS item(value)
    JOIN LATERAL (
      SELECT rule.*
      FROM crm.product_commission_rules AS rule
      WHERE rule.workspace_id = v_order.workspace_id
        AND rule.product_id = NULLIF(COALESCE(item.value->>'product_id', item.value->>'productId'), '')::uuid
        AND rule.is_deleted = false
        AND rule.is_active = true
        AND rule.effective_from <= v_event_at
        AND (rule.effective_to IS NULL OR v_event_at < rule.effective_to)
      ORDER BY rule.effective_from DESC, rule.id
      LIMIT 1
    ) AS active_rule ON true
    WHERE GREATEST(
      COALESCE(NULLIF(item.value->>'quantity', '')::numeric, 0)
        - GREATEST(COALESCE(
            NULLIF(item.value->>'returned_quantity', '')::numeric,
            NULLIF(item.value->>'returnedQuantity', '')::numeric,
            0
          ), 0),
      0
    ) > 0
      AND (
        active_rule.recipient_scope = 'all_assigned'
        OR EXISTS (
          SELECT 1
          FROM crm.product_commission_rule_agents AS recipient
          WHERE recipient.workspace_id = v_order.workspace_id
            AND recipient.rule_id = active_rule.id
            AND recipient.agent_id = v_agent.id
            AND recipient.is_deleted = false
        )
      )
  ) THEN
    RETURN 0;
  END IF;

  PERFORM set_config('atlas.ensuring_marketplace_delivery_product_commission', 'on', true);
  INSERT INTO crm.sales_order_agent_assignments (
    id,
    workspace_id,
    order_id,
    agent_id,
    assignment_source,
    assigned_at,
    assigned_by,
    reassignment_reason,
    previous_assignment_id,
    created_at,
    updated_at,
    sync_status,
    version,
    is_deleted
  ) VALUES (
    gen_random_uuid(),
    v_order.workspace_id,
    v_order.id,
    v_agent.id,
    'marketplace_delivery_product',
    v_event_at,
    v_marketplace_order.delivered_by,
    'Automatically attributed from the field agent who delivered the marketplace order',
    v_previous_assignment_id,
    now(),
    now(),
    'synced',
    1,
    false
  )
  ON CONFLICT (workspace_id, order_id, agent_id)
    WHERE unassigned_at IS NULL AND is_deleted = false
    DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$function$;

-- Insert the new derived assignment between the normal core pass and product
-- line reconciliation. This keeps the entire calculation atomic and ensures a
-- newly delivered order receives its immutable product snapshots immediately.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
BEGIN
  SELECT pg_get_functiondef(
    'public.reconcile_sales_agent_commission(uuid, uuid)'::regprocedure
  )
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');

  IF position('private.ensure_marketplace_delivery_product_commission_assignment' IN v_definition) = 0 THEN
    v_replaced := replace(
      v_definition,
      E'  v_changed := v_changed + private.ensure_order_creator_product_commission_assignment(p_order_id);\n',
      E'  v_changed := v_changed + private.ensure_order_creator_product_commission_assignment(p_order_id);\n  v_changed := v_changed + private.ensure_marketplace_delivery_product_commission_assignment(p_order_id);\n'
    );
    IF v_replaced = v_definition THEN
      RAISE EXCEPTION 'Could not add marketplace delivery product attribution to commission reconciliation';
    END IF;
    EXECUTE v_replaced;
  END IF;
END;
$block$;

-- Marketplace delivery commits the CRM order and the marketplace delivery actor
-- in one procedure. Reconcile at its tail, after both records are final, so
-- every successful delivery gets the assignment and commission lines in the
-- same transaction. Workspaces without the optional commissions module remain
-- unaffected.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
  v_return_anchor text := E'  RETURN jsonb_build_object(\n';
  v_return_anchor_offset integer;
  v_return_position integer;
BEGIN
  SELECT pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  )
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');

  IF position('reconcile_sales_agent_commission(v_sales_order_id, NULL)' IN v_definition) = 0 THEN
    -- The delivery procedure contains early returns for intermediate states.
    -- Append only before its final JSON return, without assuming the exact
    -- preceding marketplace-order UPDATE shape.
    v_return_anchor_offset := strpos(reverse(v_definition), reverse(v_return_anchor));
    IF v_return_anchor_offset = 0 THEN
      RAISE EXCEPTION 'Could not add marketplace delivery commission reconciliation to the delivery transaction';
    END IF;
    v_return_position := length(v_definition)
      - v_return_anchor_offset
      - length(v_return_anchor)
      + 2;
    IF v_return_position < 1 THEN
      RAISE EXCEPTION 'Could not add marketplace delivery commission reconciliation to the delivery transaction';
    END IF;
    v_replaced := substring(v_definition FROM 1 FOR v_return_position - 1)
      || E'  IF v_sales_order_id IS NOT NULL\n    AND EXISTS (\n      SELECT 1\n      FROM public.workspaces AS workspace\n      WHERE workspace.id = v_order.workspace_id\n        AND workspace.deleted_at IS NULL\n        AND public.workspace_module_allowed(\n          workspace.id,\n          workspace.plan::text,\n          ''sales_agent_commissions''\n        )\n    )\n  THEN\n    PERFORM public.reconcile_sales_agent_commission(v_sales_order_id, NULL);\n  END IF;\n\n'
      || substring(v_definition FROM v_return_position);
    EXECUTE v_replaced;
  END IF;
END;
$block$;

REVOKE ALL ON FUNCTION private.ensure_marketplace_delivery_product_commission_assignment(uuid) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
