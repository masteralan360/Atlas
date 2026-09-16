-- Targeted recovery of six pre-September-10 orders for Ibrahim. The old
-- reconciler required customer payment; current commission eligibility does
-- not. Resolve business identities by name, never by generated database IDs.
-- This privileged, one-time operation calls the existing reconciler with the
-- original creator's verified workspace context. One duplicated legacy line
-- ID in SO-2026-00033 is made unique before reconciliation; quantities, prices
-- and inventory stay intact. No profiles, privileges, rules or payments change.
DO $backfill_ibrahim_product_commissions$
DECLARE
  v_workspace_id uuid;
  v_agent_id uuid;
  v_count bigint;
  v_order crm.sales_orders%ROWTYPE;
  v_assignment crm.sales_order_agent_assignments%ROWTYPE;
  v_expected record;
  v_event_at timestamptz;
  v_lines jsonb;
  v_targets jsonb := '[]'::jsonb;
  v_target jsonb;
  v_order_ids uuid[] := ARRAY[]::uuid[];
  v_actor uuid;
  v_original_order jsonb;
  v_items jsonb;
  v_line_count bigint;
  v_aggregate_count bigint;
  v_quantity numeric;
  v_amount numeric;
  v_protected jsonb := '{}'::jsonb;
  v_relation text;
  v_projection text;
  v_digest text;
  v_original_sub text := current_setting('request.jwt.claim.sub', true);
  v_original_claims text := current_setting('request.jwt.claims', true);
  v_original_role text := current_setting('request.jwt.claim.role', true);
  v_original_reconciling text := current_setting('atlas.reconciling_product_commission', true);
BEGIN
  SELECT count(*), (array_agg(id))[1]
  INTO v_count, v_workspace_id
  FROM public.workspaces
  WHERE name = 'کۆگای حەسەن مامەد' AND deleted_at IS NULL;
  IF v_count = 0 THEN
    RAISE NOTICE 'Target workspace is absent; Ibrahim commission backfill skipped';
    RETURN;
  END IF;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Ibrahim commission backfill requires one target workspace';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ibrahim-product-commission-backfill:' || v_workspace_id::text, 0));
  -- Short maintenance locks keep the audited input and protected records
  -- stable throughout reconciliation and verification. Reads remain allowed.
  LOCK TABLE public.workspaces, public.profiles,
    crm.agents, crm.business_partners, crm.sales_orders, crm.purchase_orders,
    crm.sales_order_agent_assignments, crm.product_commission_rules,
    crm.product_commission_rule_agents, crm.agent_commission_memberships,
    crm.agent_commission_entries, crm.agent_product_commission_entries,
    public.products, public.inventory_transactions, public.payment_transactions,
    public.loans, public.loan_payments, public.loan_installments,
    public.order_returns, public.order_return_items
  IN SHARE ROW EXCLUSIVE MODE;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE id = v_workspace_id AND data_mode IN ('cloud', 'hybrid')
      AND sales_agent_commission_mode = 'tracked'
      AND public.workspace_module_allowed(id, plan::text, 'sales_agent_commissions')
  ) THEN
    RAISE EXCEPTION 'Ibrahim commission backfill requires enabled tracked commissions in Cloud or Hybrid mode';
  END IF;

  SELECT count(*), (array_agg(agent.id))[1]
  INTO v_count, v_agent_id
  FROM crm.agents agent
  JOIN crm.business_partners partner ON partner.id = agent.business_partner_id
    AND partner.workspace_id = agent.workspace_id AND NOT partner.is_deleted
  WHERE agent.workspace_id = v_workspace_id AND NOT agent.is_deleted
    AND agent.agent_type = 'field_agent' AND agent.status = 'active'
    AND partner.partner_name = 'مندوب ابراهيم';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Ibrahim commission backfill requires one active linked field agent';
  END IF;

  SELECT array_agg(id) INTO v_order_ids FROM crm.sales_orders
  WHERE workspace_id = v_workspace_id AND NOT is_deleted AND order_number IN (
    'SO-2026-00010', 'SO-2026-00013', 'SO-2026-00029',
    'SO-2026-00033', 'SO-2026-00039', 'SO-2026-00041'
  );
  -- Fingerprint before any write, including the line-ID repair. Only that
  -- order's technical item IDs and sync metadata are excluded; every item's
  -- business fields and every other order remain protected.
  FOREACH v_relation IN ARRAY ARRAY[
    'crm.sales_orders', 'crm.purchase_orders', 'crm.sales_order_agent_assignments',
    'crm.business_partners', 'crm.agents', 'crm.product_commission_rules',
    'crm.product_commission_rule_agents', 'crm.agent_commission_memberships',
    'public.products', 'public.inventory_transactions', 'public.payment_transactions',
    'public.loans', 'public.loan_payments', 'public.loan_installments',
    'public.order_returns', 'public.order_return_items',
    'crm.agent_commission_entries', 'crm.agent_product_commission_entries'
  ] LOOP
    v_projection := CASE WHEN v_relation = 'crm.sales_orders' THEN $projection$
      CASE WHEN order_number = 'SO-2026-00033' THEN
        jsonb_set(to_jsonb(r) - ARRAY['updated_at', 'version', 'sync_status'], '{items}',
          (SELECT jsonb_agg(value - 'id' ORDER BY ordinality)
           FROM jsonb_array_elements(r.items) WITH ORDINALITY item(value, ordinality)))
      ELSE to_jsonb(r) END
    $projection$ ELSE 'to_jsonb(r)' END;
    EXECUTE format(
      'SELECT md5(COALESCE(string_agg((%s)::text, '''' ORDER BY id), '''')) FROM %s r WHERE workspace_id = $1 %s',
      v_projection, v_relation, CASE WHEN v_relation IN ('crm.agent_commission_entries', 'crm.agent_product_commission_entries')
        THEN 'AND (order_id IS NULL OR NOT (order_id = ANY($2)))' ELSE '' END
    ) INTO v_digest USING v_workspace_id, v_order_ids;
    v_protected := v_protected || jsonb_build_object(v_relation, v_digest);
  END LOOP;

  -- Validate every order before recording anything. Initial rates come from
  -- the same fulfillment event and rule lookup used by the server reconciler.
  FOR v_expected IN SELECT * FROM (VALUES
    ('SO-2026-00010', 20, 40, 12700, timestamptz '2026-09-03 05:40:30.51+00'),
    ('SO-2026-00013', 20, 37, 12300, timestamptz '2026-09-03 13:14:07.47+00'),
    ('SO-2026-00029', 24, 40, 11700, timestamptz '2026-09-06 12:24:41.092+00'),
    ('SO-2026-00033', 11, 17, 4600, timestamptz '2026-09-07 05:18:56.954+00'),
    ('SO-2026-00039', 19, 30, 10350, timestamptz '2026-09-08 09:10:32.356+00'),
    ('SO-2026-00041', 28, 60, 18750, timestamptz '2026-09-09 05:15:32.62+00')
  ) AS expected(order_number, line_count, quantity, amount, fulfilled_at)
  LOOP
    SELECT count(*) INTO v_count FROM crm.sales_orders
    WHERE workspace_id = v_workspace_id AND order_number = v_expected.order_number AND NOT is_deleted;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Expected one audited order %', v_expected.order_number;
    END IF;
    SELECT * INTO STRICT v_order FROM crm.sales_orders
    WHERE workspace_id = v_workspace_id AND order_number = v_expected.order_number AND NOT is_deleted;
    IF v_order.status <> 'completed' OR v_order.commission_enabled IS DISTINCT FROM true
      OR v_order.commission_mode IS DISTINCT FROM 'tracked' OR lower(v_order.currency::text) <> 'iqd'
      OR COALESCE(v_order.return_status, 'none') <> 'none'
      OR v_order.sales_account_agent_id IS DISTINCT FROM v_agent_id
      OR v_order.actual_delivery_date IS DISTINCT FROM v_expected.fulfilled_at
      OR jsonb_typeof(v_order.items) IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_order.items) <> v_expected.line_count
    THEN
      RAISE EXCEPTION 'Audited order state changed for %', v_expected.order_number;
    END IF;

    SELECT count(*) INTO v_count FROM crm.sales_order_agent_assignments
    WHERE workspace_id = v_workspace_id AND order_id = v_order.id AND NOT is_deleted;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Audited assignment count changed for %', v_expected.order_number;
    END IF;
    SELECT * INTO STRICT v_assignment FROM crm.sales_order_agent_assignments
    WHERE workspace_id = v_workspace_id AND order_id = v_order.id AND NOT is_deleted;
    IF v_assignment.agent_id IS DISTINCT FROM v_agent_id OR v_assignment.unassigned_at IS NOT NULL
      OR v_assignment.assignment_source IS DISTINCT FROM 'sales_account'
      OR v_assignment.manual_commission_type IS NOT NULL
    THEN
      RAISE EXCEPTION 'Audited assignment changed for %', v_expected.order_number;
    END IF;
    v_event_at := GREATEST(v_assignment.assigned_at, COALESCE(v_order.actual_delivery_date, v_order.paid_at, v_order.updated_at));
    IF EXISTS (
      SELECT 1 FROM crm.agent_commission_memberships
      WHERE workspace_id = v_workspace_id AND agent_id = v_agent_id AND NOT is_deleted
        AND effective_from <= v_event_at AND (effective_to IS NULL OR v_event_at < effective_to)
    ) THEN
      RAISE EXCEPTION 'Unexpected plan commission terms for %', v_expected.order_number;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE id = v_order.created_by
        AND current_workspace = v_workspace_id AND role = 'admin'
    ) OR (v_actor IS NOT NULL AND v_actor IS DISTINCT FROM v_order.created_by) THEN
      RAISE EXCEPTION 'Original administrator context is unavailable for %', v_expected.order_number;
    END IF;
    v_actor := v_order.created_by;

    -- This historical order contains two identical one-carton lines with the
    -- same composite ID. The normal reconciler keys snapshots by line ID.
    -- Preserve both physical lines and change only the second technical ID.
    SELECT count(DISTINCT value->>'id') INTO v_count FROM jsonb_array_elements(v_order.items);
    IF v_count <> v_expected.line_count THEN
      IF v_expected.order_number <> 'SO-2026-00033' OR v_count <> 10
        OR (SELECT count(*) FROM (
          SELECT value->>'id' FROM jsonb_array_elements(v_order.items)
          GROUP BY value->>'id' HAVING count(*) > 1
        ) duplicates) <> 1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_order.items)
          GROUP BY value->>'id' HAVING count(*) > 1
            AND (count(*) <> 2 OR count(DISTINCT value) <> 1
              OR min((value->>'quantity')::numeric) <> 1 OR min(value->>'unit') <> 'carton')
        )
        OR EXISTS (SELECT 1 FROM crm.agent_commission_entries WHERE order_id = v_order.id)
        OR EXISTS (SELECT 1 FROM crm.agent_product_commission_entries WHERE order_id = v_order.id)
      THEN
        RAISE EXCEPTION 'Unexpected duplicate product line IDs for %', v_expected.order_number;
      END IF;
      v_original_order := to_jsonb(v_order);
      SELECT jsonb_agg(CASE WHEN occurrence > 1 THEN
        jsonb_set(value, '{id}', to_jsonb((value->>'id') || ':ibrahim-backfill-' || ordinality::text))
        ELSE value END ORDER BY ordinality) INTO v_items
      FROM (
        SELECT value, ordinality, row_number() OVER (PARTITION BY value->>'id' ORDER BY ordinality) occurrence
        FROM jsonb_array_elements(v_order.items) WITH ORDINALITY item(value, ordinality)
      ) numbered;
      IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(v_items)) <> 11 THEN
        RAISE EXCEPTION 'Repaired product line ID collides with an existing line';
      END IF;
      PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
      PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      UPDATE crm.sales_orders SET items = v_items, updated_at = clock_timestamp(),
        version = COALESCE(version, 0) + 1, sync_status = 'synced'
      WHERE id = v_order.id RETURNING * INTO v_order;
      IF (to_jsonb(v_order) - ARRAY['items', 'updated_at', 'version', 'sync_status'])
          IS DISTINCT FROM (v_original_order - ARRAY['items', 'updated_at', 'version', 'sync_status'])
        OR (SELECT jsonb_agg(value - 'id' ORDER BY ordinality)
          FROM jsonb_array_elements(v_order.items) WITH ORDINALITY item(value, ordinality))
          IS DISTINCT FROM (SELECT jsonb_agg(value - 'id' ORDER BY ordinality)
          FROM jsonb_array_elements(v_original_order->'items') WITH ORDINALITY item(value, ordinality))
      THEN
        RAISE EXCEPTION 'Product line ID repair changed order business data';
      END IF;
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
      'item_id', item.value->>'id', 'product_id', rule.product_id, 'rule_id', rule.id,
      'unit', item.value->>'unit', 'quantity', (item.value->>'quantity')::numeric,
      'rate', round(rule.fixed_amount, 6),
      'amount', round((item.value->>'quantity')::numeric * round(rule.fixed_amount, 6), 6)
    ) ORDER BY item.value->>'id') INTO v_lines
    FROM jsonb_array_elements(v_order.items) item(value)
    JOIN LATERAL (
      SELECT * FROM crm.product_commission_rules
      WHERE workspace_id = v_workspace_id
        AND product_id::text = COALESCE(item.value->>'product_id', item.value->>'productId')
        AND NOT is_deleted AND is_active
        AND effective_from <= v_event_at AND (effective_to IS NULL OR v_event_at < effective_to)
      ORDER BY effective_from DESC LIMIT 1
    ) rule ON true
    WHERE rule.commission_type = 'fixed_amount' AND lower(rule.fixed_currency::text) = 'iqd'
      AND rule.recipient_scope = 'all_assigned' AND rule.fixed_amount > 0
      AND NULLIF(item.value->>'id', '') IS NOT NULL AND (item.value->>'quantity')::numeric > 0
      AND (item.value->>'quantity')::numeric <= COALESCE((item.value->>'fulfilledQuantity')::numeric, (item.value->>'fulfilled_quantity')::numeric, 0)
      AND COALESCE((item.value->>'freeBonusQuantity')::numeric, (item.value->>'free_bonus_quantity')::numeric, 0) = 0
      AND COALESCE((item.value->>'returnedQuantity')::numeric, (item.value->>'returned_quantity')::numeric, 0) = 0;
    SELECT count(*), sum((value->>'quantity')::numeric), sum((value->>'amount')::numeric)
    INTO v_line_count, v_quantity, v_amount FROM jsonb_array_elements(v_lines);
    IF v_line_count <> v_expected.line_count OR v_quantity IS DISTINCT FROM v_expected.quantity::numeric
      OR v_amount IS DISTINCT FROM v_expected.amount::numeric
      OR (SELECT count(DISTINCT value->>'item_id') FROM jsonb_array_elements(v_lines)) <> v_expected.line_count
    THEN
      RAISE EXCEPTION 'Historical product commission terms changed for %', v_expected.order_number;
    END IF;
    v_targets := v_targets || jsonb_build_array(jsonb_build_object(
      'order_id', v_order.id, 'assignment_id', v_assignment.id, 'event_at', v_event_at,
      'order_number', v_expected.order_number, 'amount', v_expected.amount, 'lines', v_lines
    ));
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  FOR v_target IN SELECT value FROM jsonb_array_elements(v_targets) LOOP
    SELECT count(*) INTO v_line_count FROM crm.agent_product_commission_entries
    WHERE workspace_id = v_workspace_id AND order_id = (v_target->>'order_id')::uuid;
    SELECT count(*) INTO v_aggregate_count FROM crm.agent_commission_entries
    WHERE workspace_id = v_workspace_id AND order_id = (v_target->>'order_id')::uuid;
    IF v_line_count = 0 AND v_aggregate_count = 0 THEN
      PERFORM public.reconcile_sales_agent_commission((v_target->>'order_id')::uuid, NULL);
    END IF;
    -- A fully verified replay is a no-op. Partial, unrelated, reversed, deleted
    -- or differently rated entries fail rather than being overwritten.
    SELECT count(*) INTO v_line_count FROM crm.agent_product_commission_entries
    WHERE workspace_id = v_workspace_id AND order_id = (v_target->>'order_id')::uuid;
    IF v_line_count <> jsonb_array_length(v_target->'lines') OR EXISTS (
      SELECT 1 FROM crm.agent_product_commission_entries entry
      LEFT JOIN jsonb_array_elements(v_target->'lines') expected(value)
        ON expected.value->>'item_id' = entry.order_item_id
      WHERE entry.workspace_id = v_workspace_id AND entry.order_id = (v_target->>'order_id')::uuid
        AND (expected.value IS NULL OR entry.assignment_id IS DISTINCT FROM (v_target->>'assignment_id')::uuid
          OR entry.agent_id IS DISTINCT FROM v_agent_id OR entry.is_deleted
          OR entry.kind <> 'accrual' OR entry.status <> 'earned' OR entry.commission_mode <> 'tracked'
          OR lower(entry.currency::text) <> 'iqd' OR entry.order_return_id IS NOT NULL
          OR entry.product_id::text IS DISTINCT FROM expected.value->>'product_id'
          OR entry.rule_id::text IS DISTINCT FROM expected.value->>'rule_id'
          OR entry.unit_snapshot IS DISTINCT FROM expected.value->>'unit'
          OR entry.quantity IS DISTINCT FROM (expected.value->>'quantity')::numeric
          OR entry.commission_per_unit IS DISTINCT FROM (expected.value->>'rate')::numeric
          OR entry.amount IS DISTINCT FROM (expected.value->>'amount')::numeric
          OR entry.occurred_at IS DISTINCT FROM (v_target->>'event_at')::timestamptz)
    ) OR (SELECT count(DISTINCT order_item_id) FROM crm.agent_product_commission_entries
      WHERE workspace_id = v_workspace_id AND order_id = (v_target->>'order_id')::uuid) <> v_line_count THEN
      RAISE EXCEPTION 'Recovered product entries do not match the audit for %', v_target->>'order_number';
    END IF;
    SELECT count(*) INTO v_aggregate_count FROM crm.agent_commission_entries
    WHERE workspace_id = v_workspace_id AND order_id = (v_target->>'order_id')::uuid;
    IF v_aggregate_count <> 1 OR NOT EXISTS (
      SELECT 1 FROM crm.agent_commission_entries entry
      WHERE entry.workspace_id = v_workspace_id AND entry.order_id = (v_target->>'order_id')::uuid
        AND entry.assignment_id = (v_target->>'assignment_id')::uuid AND entry.agent_id = v_agent_id
        AND NOT entry.is_deleted AND entry.kind = 'accrual' AND entry.status = 'earned'
        AND entry.commission_mode = 'tracked' AND lower(entry.currency::text) = 'iqd'
        AND entry.amount = (v_target->>'amount')::numeric
        AND entry.product_commission_amount = entry.amount AND entry.plan_commission_amount = 0
        AND entry.occurred_at = (v_target->>'event_at')::timestamptz
    ) THEN
      RAISE EXCEPTION 'Recovered aggregate commission does not match the audit for %', v_target->>'order_number';
    END IF;
  END LOOP;

  FOR v_relation IN SELECT jsonb_object_keys(v_protected) LOOP
    v_projection := CASE WHEN v_relation = 'crm.sales_orders' THEN $projection$
      CASE WHEN order_number = 'SO-2026-00033' THEN
        jsonb_set(to_jsonb(r) - ARRAY['updated_at', 'version', 'sync_status'], '{items}',
          (SELECT jsonb_agg(value - 'id' ORDER BY ordinality)
           FROM jsonb_array_elements(r.items) WITH ORDINALITY item(value, ordinality)))
      ELSE to_jsonb(r) END
    $projection$ ELSE 'to_jsonb(r)' END;
    EXECUTE format(
      'SELECT md5(COALESCE(string_agg((%s)::text, '''' ORDER BY id), '''')) FROM %s r WHERE workspace_id = $1 %s',
      v_projection, v_relation, CASE WHEN v_relation IN ('crm.agent_commission_entries', 'crm.agent_product_commission_entries')
        THEN 'AND (order_id IS NULL OR NOT (order_id = ANY($2)))' ELSE '' END
    ) INTO v_digest USING v_workspace_id, v_order_ids;
    IF v_digest IS DISTINCT FROM v_protected->>v_relation THEN
      RAISE EXCEPTION 'Commission backfill changed protected records in %', v_relation;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_original_sub, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_original_claims, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_original_role, ''), true);
  PERFORM set_config('atlas.reconciling_product_commission', COALESCE(v_original_reconciling, ''), true);
  RAISE NOTICE 'Verified Ibrahim product commissions: 122 lines, 6 accruals, 70400 IQD';
END;
$backfill_ibrahim_product_commissions$;
