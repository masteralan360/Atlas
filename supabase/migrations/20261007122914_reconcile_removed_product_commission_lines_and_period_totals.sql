-- A line can disappear from a committed order after its immutable product
-- commission snapshot was accrued. Reconcile those orphaned snapshots to zero
-- before calculating the order's aggregate product commission target.
DO $patch_removed_line_reconciliation$
DECLARE
  v_definition text;
  v_original text;
  v_declaration_anchor text := E'  v_current_quantity numeric;\n';
  v_reconciliation_anchor text := E'    SELECT\n      COALESCE(sum(entry.amount), 0),\n      COALESCE(sum(entry.quantity * entry.basis_amount_per_unit), 0)\n    INTO v_product_total, v_product_basis\n';
  v_removed_line_loop text := E'    -- A removed line has a zero target. Counter its remaining immutable\n    -- line snapshot before deriving the order-level aggregate target.\n    FOR v_source IN\n      SELECT source.*\n      FROM crm.agent_product_commission_entries AS source\n      WHERE source.workspace_id = v_order.workspace_id\n        AND source.assignment_id = v_assignment.id\n        AND source.order_id = v_order.id\n        AND source.kind = ''accrual''\n        AND source.is_deleted = false\n        AND NOT EXISTS (\n          SELECT 1\n          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_order.items) = ''array'' THEN v_order.items ELSE ''[]''::jsonb END) AS current_line(value)\n          WHERE COALESCE(NULLIF(current_line.value->>''id'', ''''), NULLIF(current_line.value->>''line_id'', ''''), NULLIF(current_line.value->>''lineId'', '''')) = source.order_item_id\n        )\n      ORDER BY source.created_at, source.id\n    LOOP\n      SELECT COALESCE(sum(entry.quantity), 0), COALESCE(sum(entry.amount), 0)\n      INTO v_current_quantity, v_current_amount\n      FROM crm.agent_product_commission_entries AS entry\n      WHERE entry.workspace_id = v_order.workspace_id\n        AND entry.assignment_id = v_assignment.id\n        AND entry.order_id = v_order.id\n        AND entry.order_item_id = v_source.order_item_id\n        AND entry.is_deleted = false;\n\n      IF abs(v_current_quantity) > 0.000001 OR abs(v_current_amount) > 0.000001 THEN\n        INSERT INTO crm.agent_product_commission_entries (\n          id, workspace_id, order_id, assignment_id, agent_id, order_item_id, product_id,\n          product_name_snapshot, product_sku_snapshot, unit_snapshot, rule_id, order_return_id,\n          related_entry_id, kind, status, currency, commission_type, rate_percent,\n          fixed_source_amount, fixed_source_currency, fixed_conversion_rate, fixed_exchange_rate_source,\n          fixed_exchange_rate_timestamp, fixed_exchange_rates, quantity, basis_amount_per_unit,\n          commission_per_unit, amount, occurred_at, notes, created_by, created_at, updated_at, sync_status, version, is_deleted\n        ) VALUES (\n          gen_random_uuid(), v_order.workspace_id, v_order.id, v_assignment.id, v_assignment.agent_id, v_source.order_item_id, v_source.product_id,\n          v_source.product_name_snapshot, v_source.product_sku_snapshot, v_source.unit_snapshot, v_source.rule_id, NULL,\n          v_source.id, CASE WHEN v_current_amount > 0 THEN ''reversal'' ELSE ''adjustment'' END,\n          CASE WHEN v_current_amount > 0 THEN ''reversed'' ELSE ''earned'' END, v_source.currency, v_source.commission_type, v_source.rate_percent,\n          v_source.fixed_source_amount, v_source.fixed_source_currency, v_source.fixed_conversion_rate, v_source.fixed_exchange_rate_source,\n          v_source.fixed_exchange_rate_timestamp, v_source.fixed_exchange_rates, -v_current_quantity, v_source.basis_amount_per_unit,\n          v_source.commission_per_unit, -v_current_amount, v_order.updated_at,\n          ''Product commission reversed because its sales-order line was removed'', v_actor, now(), now(), ''synced'', 1, false\n        );\n        v_changed := v_changed + 1;\n      END IF;\n    END LOOP;\n\n';
BEGIN
  SELECT pg_get_functiondef('private.reconcile_product_sales_agent_commission(uuid,uuid)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');
  IF position('Product commission reversed because its sales-order line was removed' IN v_definition) > 0 THEN
    RETURN;
  END IF;
  v_original := v_definition;

  IF position(v_declaration_anchor IN v_definition) = 0
    OR position(v_reconciliation_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Product commission reconciler changed; review removed-line reconciliation';
  END IF;
  v_definition := replace(v_definition, v_declaration_anchor, v_declaration_anchor || '  v_current_amount numeric;' || E'\n');
  v_definition := replace(v_definition, v_reconciliation_anchor, v_removed_line_loop || v_reconciliation_anchor);
  IF v_definition = v_original
    OR position('v_current_amount numeric;' IN v_definition) = 0
    OR position('Product commission reversed because its sales-order line was removed' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not extend the product commission reconciler for removed order lines';
  END IF;
  EXECUTE v_definition;
END;
$patch_removed_line_reconciliation$;

-- Restate the affected tracked history with append-only counter-entries. The
-- workspace and partner are resolved by their business names; no generated
-- database IDs are embedded in this data migration.
DO $repair_removed_line_commission_history$
DECLARE
  v_workspace_id uuid;
  v_agent_id uuid;
  v_workspace_count bigint;
  v_agent_count bigint;
  v_stale_event_count bigint;
  v_stale_amount numeric;
  v_product_source crm.agent_product_commission_entries%ROWTYPE;
  v_aggregate_source crm.agent_commission_entries%ROWTYPE;
BEGIN
  SELECT count(*), (array_agg(workspace.id))[1]
  INTO v_workspace_count, v_workspace_id
  FROM public.workspaces AS workspace
  WHERE btrim(workspace.name) = 'حەسەن مامەد كروب'
    AND workspace.deleted_at IS NULL;

  IF v_workspace_count = 0 THEN
    RAISE NOTICE 'Target workspace is absent; historical commission restatement skipped';
    RETURN;
  END IF;
  IF v_workspace_count <> 1 THEN
    RAISE EXCEPTION 'Historical commission restatement requires one workspace named حەسەن مامەد كروب';
  END IF;

  SELECT count(*), (array_agg(agent.id))[1]
  INTO v_agent_count, v_agent_id
  FROM crm.agents AS agent
  JOIN crm.business_partners AS partner
    ON partner.id = agent.business_partner_id
   AND partner.workspace_id = agent.workspace_id
  WHERE agent.workspace_id = v_workspace_id
    AND partner.partner_name = 'مندوب ابراهيم'
    AND agent.agent_type = 'field_agent'
    AND agent.is_deleted = false;

  IF v_agent_count <> 1 THEN
    RAISE EXCEPTION 'Historical commission restatement requires one active field agent named مندوب ابراهيم';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces AS workspace
    WHERE workspace.id = v_workspace_id
      AND workspace.data_mode IN ('cloud', 'hybrid')
      AND workspace.sales_agent_commission_mode = 'tracked'
  ) THEN
    RAISE EXCEPTION 'Historical commission restatement requires tracked commissions in Cloud or Hybrid mode';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('removed-product-line-commission:' || v_workspace_id::text || ':' || v_agent_id::text, 0));
  LOCK TABLE crm.agent_product_commission_entries, crm.agent_commission_entries IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('atlas.reconciling_product_commission', 'on', true);

  SELECT count(*), COALESCE(sum(source.amount), 0)
  INTO v_stale_event_count, v_stale_amount
  FROM crm.agent_product_commission_entries AS source
  JOIN crm.sales_orders AS sales_order
    ON sales_order.id = source.order_id
   AND sales_order.workspace_id = source.workspace_id
  WHERE source.workspace_id = v_workspace_id
    AND source.agent_id = v_agent_id
    AND source.commission_mode = 'tracked'
    AND source.is_deleted = false
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sales_order.items) = 'array' THEN sales_order.items ELSE '[]'::jsonb END) AS current_line(value)
      WHERE COALESCE(NULLIF(current_line.value->>'id', ''), NULLIF(current_line.value->>'line_id', ''), NULLIF(current_line.value->>'lineId', '')) = source.order_item_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm.agent_product_commission_entries AS correction
      WHERE correction.related_entry_id = source.id
        AND correction.notes LIKE 'Removed order-line commission correction:%'
    );

  IF v_stale_event_count = 0 THEN
    RAISE NOTICE 'No uncorrected stale product commission events remain';
    RETURN;
  END IF;
  IF abs(v_stale_amount - 13650) > 0.000001 THEN
    RAISE EXCEPTION 'Expected stale tracked commission of 13650 IQD; found % across % rows', v_stale_amount, v_stale_event_count;
  END IF;

  FOR v_product_source IN
    SELECT source.*
    FROM crm.agent_product_commission_entries AS source
    JOIN crm.sales_orders AS sales_order
      ON sales_order.id = source.order_id
     AND sales_order.workspace_id = source.workspace_id
    WHERE source.workspace_id = v_workspace_id
      AND source.agent_id = v_agent_id
      AND source.commission_mode = 'tracked'
      AND source.is_deleted = false
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sales_order.items) = 'array' THEN sales_order.items ELSE '[]'::jsonb END) AS current_line(value)
        WHERE COALESCE(NULLIF(current_line.value->>'id', ''), NULLIF(current_line.value->>'line_id', ''), NULLIF(current_line.value->>'lineId', '')) = source.order_item_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.agent_product_commission_entries AS correction
        WHERE correction.related_entry_id = source.id
          AND correction.notes LIKE 'Removed order-line commission correction:%'
      )
    ORDER BY source.occurred_at, source.created_at, source.id
  LOOP
    SELECT aggregate_entry.*
    INTO v_aggregate_source
    FROM crm.agent_commission_entries AS aggregate_entry
    WHERE aggregate_entry.workspace_id = v_product_source.workspace_id
      AND aggregate_entry.order_id = v_product_source.order_id
      AND aggregate_entry.assignment_id = v_product_source.assignment_id
      AND aggregate_entry.agent_id = v_product_source.agent_id
      AND aggregate_entry.kind = 'accrual'
      AND aggregate_entry.is_deleted = false
    ORDER BY aggregate_entry.occurred_at, aggregate_entry.created_at, aggregate_entry.id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Missing tracked aggregate accrual for stale product commission entry %', v_product_source.id;
    END IF;

    INSERT INTO crm.agent_product_commission_entries (
      id, workspace_id, order_id, assignment_id, agent_id, order_item_id, product_id,
      product_name_snapshot, product_sku_snapshot, unit_snapshot, rule_id, order_return_id,
      related_entry_id, kind, status, currency, commission_type, rate_percent,
      fixed_source_amount, fixed_source_currency, fixed_conversion_rate, fixed_exchange_rate_source,
      fixed_exchange_rate_timestamp, fixed_exchange_rates, quantity, basis_amount_per_unit,
      commission_per_unit, amount, occurred_at, notes, created_by, created_at, updated_at, sync_status, version, is_deleted
    ) VALUES (
      gen_random_uuid(), v_product_source.workspace_id, v_product_source.order_id, v_product_source.assignment_id,
      v_product_source.agent_id, v_product_source.order_item_id, v_product_source.product_id,
      v_product_source.product_name_snapshot, v_product_source.product_sku_snapshot, v_product_source.unit_snapshot,
      v_product_source.rule_id, NULL, v_product_source.id,
      CASE WHEN v_product_source.amount > 0 THEN 'reversal' ELSE 'adjustment' END,
      CASE WHEN v_product_source.amount > 0 THEN 'reversed' ELSE 'earned' END,
      v_product_source.currency, v_product_source.commission_type, v_product_source.rate_percent,
      v_product_source.fixed_source_amount, v_product_source.fixed_source_currency, v_product_source.fixed_conversion_rate,
      v_product_source.fixed_exchange_rate_source, v_product_source.fixed_exchange_rate_timestamp,
      v_product_source.fixed_exchange_rates, -v_product_source.quantity, v_product_source.basis_amount_per_unit,
      v_product_source.commission_per_unit, -v_product_source.amount, v_product_source.occurred_at,
      'Removed order-line commission correction: ' || v_product_source.id::text, NULL, now(), now(), 'synced', 1, false
    );

    IF abs(v_product_source.amount) > 0.000001 THEN
      INSERT INTO crm.agent_commission_entries (
        id, workspace_id, order_id, assignment_id, agent_id, membership_id, plan_id, order_return_id, related_entry_id,
        kind, status, currency, calculation_basis, include_tax, include_delivery_charge,
        basis_amount, revenue_amount, cost_amount, tax_amount, delivery_charge_amount, rate_percent,
        plan_commission_amount, product_commission_amount, amount, occurred_at, payout_reference, settlement_source,
        notes, created_by, created_at, updated_at, sync_status, version, is_deleted
      ) VALUES (
        gen_random_uuid(), v_aggregate_source.workspace_id, v_aggregate_source.order_id, v_aggregate_source.assignment_id,
        v_aggregate_source.agent_id, v_aggregate_source.membership_id, v_aggregate_source.plan_id, NULL, v_aggregate_source.id,
        'adjustment', CASE WHEN v_product_source.amount > 0 THEN 'reversed' ELSE 'earned' END,
        v_aggregate_source.currency, v_aggregate_source.calculation_basis, v_aggregate_source.include_tax,
        v_aggregate_source.include_delivery_charge, v_aggregate_source.basis_amount, v_aggregate_source.revenue_amount,
        v_aggregate_source.cost_amount, v_aggregate_source.tax_amount, v_aggregate_source.delivery_charge_amount,
        v_aggregate_source.rate_percent, 0, -v_product_source.amount, -v_product_source.amount,
        v_product_source.occurred_at, NULL, 'automatic',
        'Removed order-line tracked commission correction: ' || v_product_source.id::text,
        NULL, now(), now(), 'synced', 1, false
      );
    END IF;
  END LOOP;
END;
$repair_removed_line_commission_history$;
