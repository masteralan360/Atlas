-- Fulfilled creator-attributed product commissions are independent of customer payment.
-- Replace the existing private function in place, preserving its owner and privileges.
CREATE OR REPLACE FUNCTION private.ensure_order_creator_product_commission_assignment(p_order_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_order crm.sales_orders%ROWTYPE;
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
    OR v_order.created_by IS NULL
    OR v_order.status <> 'completed'
    OR COALESCE(v_order.return_status, 'none') = 'full'
    OR COALESCE(v_order.is_deleted, false)
    OR COALESCE(v_order.commission_enabled, true) = false
  THEN
    RETURN 0;
  END IF;

  SELECT agent.*
  INTO v_agent
  FROM crm.agents AS agent
  WHERE agent.workspace_id = v_order.workspace_id
    AND agent.linked_user_id = v_order.created_by
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
    COALESCE(v_order.paid_at, '-infinity'::timestamptz),
    COALESCE(v_order.updated_at, v_order.created_at, now())
  );

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
    'order_creator_product',
    v_event_at,
    v_order.created_by,
    'Automatically attributed from the staff user who created the sale',
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


-- Creator/delivery assignments are excluded from the normal-plan core. Their
-- existing aggregate is already product commission, so reconcile only the
-- difference from that aggregate, with no artificial normal-plan component.
DO $fix_product_only_deltas$
DECLARE
  v_definition text;
  v_old text := E'    v_product_delta := round(v_product_total, 6);\n    v_plan_delta := round(-v_product_plan_share, 6);';
  v_new text := E'    IF v_assignment.assignment_source IN (''order_creator_product'', ''marketplace_delivery_product'') THEN\n      v_product_delta := round(v_product_total - v_normal_recognized, 6);\n      v_plan_delta := 0;\n    ELSE\n      v_product_delta := round(v_product_total, 6);\n      v_plan_delta := round(-v_product_plan_share, 6);\n    END IF;';
  v_old_return text := E'    IF COALESCE(v_order.return_status, ''none'') = ''full'' THEN\n      CONTINUE;\n    END IF;';
  v_new_return text := E'    IF COALESCE(v_order.return_status, ''none'') = ''full''\n      AND COALESCE(v_assignment.assignment_source, ''manual'') NOT IN (''order_creator_product'', ''marketplace_delivery_product'') THEN\n      CONTINUE;\n    END IF;';
BEGIN
  SELECT pg_get_functiondef('private.reconcile_product_sales_agent_commission(uuid,uuid)'::regprocedure) INTO v_definition;
  IF strpos(v_definition, v_new) > 0 AND strpos(v_definition, v_new_return) > 0 THEN RETURN; END IF;
  IF strpos(v_definition, v_old) = 0 OR strpos(v_definition, v_old_return) = 0 THEN
    RAISE EXCEPTION 'Product reconciler changed; review the product-only delta fix';
  END IF;
  -- The core skips these derived assignments even on a full return, so their
  -- product reconciler must append the aggregate reversal as well as its lines.
  EXECUTE replace(replace(v_definition, v_old, v_new), v_old_return, v_new_return);
END;
$fix_product_only_deltas$;

-- Targeted, append-only recovery of the 18 audited orders. Business identities
-- are resolved by workspace/partner/order names, never generated IDs. Locks and
-- fingerprints protect business fields, prior history, stock and financial data.
DO $recover_other_agents$
DECLARE
  v_workspace uuid;
  v_agent uuid;
  v_count bigint;
  v_expected record;
  v_order crm.sales_orders%ROWTYPE;
  v_assignment crm.sales_order_agent_assignments%ROWTYPE;
  v_targets jsonb := '[]'::jsonb;
  v_target jsonb;
  v_lines jsonb;
  v_items jsonb;
  v_ids uuid[];
  v_duplicates bigint;
  v_before numeric;
  v_aggregate numeric;
  v_relation text;
  v_projection text;
  v_filter text;
  v_digest text;
  v_protected jsonb := '{}'::jsonb;
  v_original_ids jsonb := '{}'::jsonb;
  v_original_sub text := current_setting('request.jwt.claim.sub', true);
  v_original_claims text := current_setting('request.jwt.claims', true);
  v_original_role text := current_setting('request.jwt.claim.role', true);
  v_original_reconciling text := current_setting('atlas.reconciling_product_commission', true);
BEGIN
  SELECT count(*), (array_agg(id))[1] INTO v_count, v_workspace
  FROM public.workspaces WHERE name = 'کۆگای حەسەن مامەد' AND deleted_at IS NULL;
  IF v_count = 0 THEN
    RAISE NOTICE 'Target workspace absent; other-agent data recovery skipped';
    RETURN;
  END IF;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Recovery requires one target workspace'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('other-agent-product-commission-recovery:' || v_workspace::text, 0));
  LOCK TABLE public.workspaces, public.profiles,
    crm.sales_orders,
    crm.purchase_orders,
    crm.business_partners,
    crm.agents,
    crm.product_commission_rules,
    crm.product_commission_rule_agents,
    crm.agent_commission_memberships,
    crm.sales_order_agent_assignments,
    crm.agent_commission_entries,
    crm.agent_product_commission_entries,
    public.products,
    public.installment_sale_payments,
    public.inventory,
    public.inventory_transactions,
    public.inventory_transfer_transactions,
    public.loan_installments,
    public.loan_payments,
    public.loans,
    public.order_return_items,
    public.order_returns,
    public.payment_transactions,
    public.sale_return_items,
    public.sale_returns
  IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces
    WHERE id = v_workspace AND data_mode IN ('cloud', 'hybrid')
      AND sales_agent_commission_mode = 'tracked'
      AND public.workspace_module_allowed(id, plan::text, 'sales_agent_commissions'))
  THEN RAISE EXCEPTION 'Recovery requires enabled tracked commissions in Cloud or Hybrid mode'; END IF;

  SELECT array_agg(id) INTO v_ids FROM crm.sales_orders
  WHERE workspace_id = v_workspace AND order_number IN ('SO-2026-00014', 'SO-2026-00015', 'SO-2026-00016', 'SO-2026-00021', 'SO-2026-00025', 'SO-2026-00028', 'SO-2026-00032', 'SO-2026-00038', 'SO-2026-00040', 'SO-2026-00045', 'SO-2026-00048', 'SO-2026-00051', 'SO-2026-00062', 'SO-2026-00063', 'SO-2026-00068', 'SO-2026-00071', 'SO-2026-00073', 'SO-2026-00076');
  -- Capture IDs so every original record remains protected even inside the
  -- recovery scope. New commission/creator-assignment rows alone are allowed.
  FOREACH v_relation IN ARRAY ARRAY[
    'crm.sales_orders',
    'crm.purchase_orders',
    'crm.business_partners',
    'crm.agents',
    'crm.product_commission_rules',
    'crm.product_commission_rule_agents',
    'crm.agent_commission_memberships',
    'crm.sales_order_agent_assignments',
    'crm.agent_commission_entries',
    'crm.agent_product_commission_entries',
    'public.products',
    'public.installment_sale_payments',
    'public.inventory',
    'public.inventory_transactions',
    'public.inventory_transfer_transactions',
    'public.loan_installments',
    'public.loan_payments',
    'public.loans',
    'public.order_return_items',
    'public.order_returns',
    'public.payment_transactions',
    'public.sale_return_items',
    'public.sale_returns'
  ] LOOP
    IF v_relation IN ('crm.agent_commission_entries', 'crm.agent_product_commission_entries', 'crm.sales_order_agent_assignments') THEN
      EXECUTE format('SELECT COALESCE(jsonb_agg(id::text), ''[]''::jsonb) FROM %s WHERE workspace_id = $1', v_relation)
        INTO v_lines USING v_workspace;
      v_original_ids := v_original_ids || jsonb_build_object(v_relation, v_lines);
      v_filter := 'AND (id::text IN (SELECT jsonb_array_elements_text($3)) OR order_id IS NULL OR NOT (order_id = ANY($2)))';
    ELSE v_filter := ''; END IF;
    v_projection := CASE WHEN v_relation = 'crm.sales_orders' THEN $projection$
      CASE WHEN order_number IN ('SO-2026-00021','SO-2026-00032','SO-2026-00045','SO-2026-00063','SO-2026-00068','SO-2026-00071','SO-2026-00073') THEN
        jsonb_set(to_jsonb(r) - ARRAY['updated_at','version','sync_status'], '{items}',
          (SELECT jsonb_agg(value - 'id' ORDER BY ordinality)
           FROM jsonb_array_elements(r.items) WITH ORDINALITY i(value,ordinality)))
      ELSE to_jsonb(r) END
    $projection$ ELSE 'to_jsonb(r)' END;
    EXECUTE format('SELECT md5(COALESCE(string_agg((%s)::text, '''' ORDER BY id), '''')) FROM %s r WHERE workspace_id = $1 %s',
      v_projection, v_relation, v_filter) INTO v_digest
      USING v_workspace, v_ids, v_original_ids->v_relation;
    v_protected := v_protected || jsonb_build_object(v_relation, v_digest);
  END LOOP;
  SELECT md5(COALESCE(string_agg(to_jsonb(p)::text, '' ORDER BY id), '')) INTO v_digest FROM public.profiles p;
  v_protected := v_protected || jsonb_build_object('public.profiles', v_digest);
  SELECT md5(to_jsonb(w)::text) INTO v_digest FROM public.workspaces w WHERE id = v_workspace;
  v_protected := v_protected || jsonb_build_object('public.workspaces', v_digest);

  -- Validate and prepare all orders before any data write. Recorded line rates
  -- stay locked; missing initials use the same historical lookup as the engine.
  FOR v_expected IN SELECT * FROM (VALUES
    ('SO-2026-00014', 'مندوب خالد', 6, 7, 0, 0, 0, 1900, 'sales_account', false, timestamptz '2026-09-03T13:33:08.771+00:00', timestamptz '2026-09-03T13:33:08.771+00:00'),
    ('SO-2026-00015', 'مندوب خالد', 18, 34, 0, 0, 0, 9300, 'sales_account', false, timestamptz '2026-09-05T06:17:09.75+00:00', timestamptz '2026-09-05T06:17:09.75+00:00'),
    ('SO-2026-00016', 'فراس مزيد', 7, 7, 0, 0, 0, 2400, 'order_creator_product', false, timestamptz '2026-09-05T15:09:27.26+00:00', timestamptz '2026-09-06T09:57:20.181+00:00'),
    ('SO-2026-00021', 'فراس مزيد', 56, 56, 0, 2, 17900, 18450, 'order_creator_product', false, timestamptz '2026-09-05T15:48:36.572+00:00', timestamptz '2026-09-06T09:59:35.089+00:00'),
    ('SO-2026-00025', 'مندوب حسن', 6, 60, 1, 0, 0, 18000, 'order_creator_product', true, timestamptz '2026-09-06T06:07:25.229+00:00', timestamptz '2026-09-12T11:07:33.505756+00:00'),
    ('SO-2026-00028', 'مندوب خالد', 4, 5, 0, 0, 0, 1600, 'sales_account', false, timestamptz '2026-09-06T12:12:01.814+00:00', timestamptz '2026-09-06T12:12:01.814+00:00'),
    ('SO-2026-00032', 'فراس مزيد', 6, 6, 0, 1, 1750, 2100, 'order_creator_product', false, timestamptz '2026-09-06T15:18:27.281+00:00', timestamptz '2026-09-07T12:28:39.935+00:00'),
    ('SO-2026-00038', 'مندوب خالد', 25, 34, 0, 0, 0, 10000, 'sales_account', false, timestamptz '2026-09-08T08:45:09.845+00:00', timestamptz '2026-09-08T08:45:09.845+00:00'),
    ('SO-2026-00040', 'مندوب حسن', 8, 140, 3, 0, 0, 42500, 'order_creator_product', true, timestamptz '2026-09-08T10:10:50.989+00:00', timestamptz '2026-09-12T11:07:33.505756+00:00'),
    ('SO-2026-00045', 'فراس مزيد', 4, 4, 0, 1, 800, 1050, 'order_creator_product', false, timestamptz '2026-09-15T16:16:33.826+00:00', timestamptz '2026-09-15T16:16:33.826+00:00'),
    ('SO-2026-00048', 'مندوب خالد', 13, 70, 0, 0, 0, 22300, 'sales_account', false, timestamptz '2026-09-09T17:06:29.851+00:00', timestamptz '2026-09-09T17:06:29.851+00:00'),
    ('SO-2026-00051', 'مندوب حسن', 6, 190, 2, 0, 0, 61500, 'order_creator_product', true, timestamptz '2026-09-10T07:15:23.076+00:00', timestamptz '2026-09-13T17:13:01.305+00:00'),
    ('SO-2026-00062', 'مندوب حسن', 4, 125, 0, 0, 0, 62500, 'order_creator_product', true, timestamptz '2026-09-13T17:00:59.625+00:00', timestamptz '2026-09-13T17:00:59.625+00:00'),
    ('SO-2026-00063', 'فراس مزيد', 33, 34, 0, 1, 10800, 11100, 'order_creator_product', false, timestamptz '2026-09-13T18:02:53.485+00:00', timestamptz '2026-09-13T18:02:53.485+00:00'),
    ('SO-2026-00068', 'مندوب حسن', 7, 55, 0, 1, 19000, 21500, 'order_creator_product', false, timestamptz '2026-09-15T15:34:44.698+00:00', timestamptz '2026-09-15T15:34:44.698+00:00'),
    ('SO-2026-00071', 'مندوب حسن', 4, 15, 0, 1, 0, 7500, 'order_creator_product', true, timestamptz '2026-09-15T16:12:35.663+00:00', timestamptz '2026-09-15T16:12:35.663+00:00'),
    ('SO-2026-00073', 'مندوب حسن', 9, 42, 0, 1, 14000, 15000, 'order_creator_product', false, timestamptz '2026-09-15T15:29:03.262+00:00', timestamptz '2026-09-15T15:29:03.262+00:00'),
    ('SO-2026-00076', 'فراس مزيد', 9, 9, 0, 0, 0, 2700, 'order_creator_product', true, timestamptz '2026-09-15T15:15:12.497+00:00', timestamptz '2026-09-15T15:15:12.497+00:00')
  ) expected(order_number, partner_name, line_count, quantity, bonus, duplicates,
    before_amount, amount, assignment_source, needs_creator, fulfilled_at, event_at)
  LOOP
    SELECT count(*), (array_agg(a.id))[1] INTO v_count, v_agent
    FROM crm.agents a JOIN crm.business_partners p
      ON p.id = a.business_partner_id AND p.workspace_id = a.workspace_id AND NOT p.is_deleted
    WHERE a.workspace_id = v_workspace AND NOT a.is_deleted
      AND a.agent_type = 'field_agent' AND a.status = 'active' AND p.partner_name = v_expected.partner_name;
    IF v_count <> 1 THEN RAISE EXCEPTION 'Expected one active linked field agent: %', v_expected.partner_name; END IF;
    SELECT count(*) INTO v_count FROM crm.sales_orders
    WHERE workspace_id = v_workspace AND order_number = v_expected.order_number AND NOT is_deleted;
    IF v_count <> 1 THEN RAISE EXCEPTION 'Expected one audited order: %', v_expected.order_number; END IF;
    SELECT * INTO STRICT v_order FROM crm.sales_orders
    WHERE workspace_id = v_workspace AND order_number = v_expected.order_number AND NOT is_deleted;
    IF v_order.status <> 'completed' OR v_order.commission_enabled IS DISTINCT FROM true
      OR v_order.commission_mode IS DISTINCT FROM 'tracked' OR lower(v_order.currency::text) <> 'iqd'
      OR COALESCE(v_order.return_status, 'none') <> 'none'
      OR v_order.actual_delivery_date IS DISTINCT FROM v_expected.fulfilled_at
      OR jsonb_typeof(v_order.items) IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_order.items) <> v_expected.line_count
      OR (v_expected.assignment_source = 'sales_account' AND v_order.sales_account_agent_id IS DISTINCT FROM v_agent)
    THEN RAISE EXCEPTION 'Audited order state changed: %', v_expected.order_number; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_order.created_by
      AND current_workspace = v_workspace AND role IN ('admin','staff'))
      OR (v_expected.assignment_source = 'order_creator_product' AND NOT EXISTS (
        SELECT 1 FROM crm.agents WHERE id = v_agent AND linked_user_id = v_order.created_by))
    THEN RAISE EXCEPTION 'Verified original creator context unavailable: %', v_expected.order_number; END IF;

    SELECT count(*) INTO v_count FROM crm.sales_order_agent_assignments WHERE workspace_id = v_workspace
      AND order_id = v_order.id;
    IF v_count <> (CASE WHEN v_expected.needs_creator THEN 0 ELSE 1 END) AND NOT (v_expected.needs_creator AND v_count = 1)
    THEN RAISE EXCEPTION 'Audited assignment count changed: %', v_expected.order_number; END IF;
    v_assignment := NULL;
    IF v_count = 1 THEN
      SELECT * INTO STRICT v_assignment FROM crm.sales_order_agent_assignments WHERE workspace_id = v_workspace AND order_id = v_order.id;
      IF v_assignment.agent_id IS DISTINCT FROM v_agent OR v_assignment.is_deleted OR v_assignment.unassigned_at IS NOT NULL
        OR v_assignment.assignment_source IS DISTINCT FROM v_expected.assignment_source
        OR v_assignment.manual_commission_type IS NOT NULL
        OR GREATEST(v_assignment.assigned_at, COALESCE(v_order.actual_delivery_date,v_order.paid_at,v_order.updated_at))
          IS DISTINCT FROM v_expected.event_at
      THEN RAISE EXCEPTION 'Audited assignment changed: %', v_expected.order_number; END IF;
    ELSIF GREATEST(v_order.actual_delivery_date, COALESCE(v_order.paid_at,'-infinity'::timestamptz),
      COALESCE(v_order.updated_at,v_order.created_at,now())) IS DISTINCT FROM v_expected.event_at
    THEN RAISE EXCEPTION 'Creator assignment historical event changed: %', v_expected.order_number; END IF;
    IF EXISTS (SELECT 1 FROM crm.agent_commission_memberships WHERE workspace_id = v_workspace AND agent_id = v_agent
      AND NOT is_deleted AND effective_from <= v_expected.event_at AND (effective_to IS NULL OR v_expected.event_at < effective_to))
    THEN RAISE EXCEPTION 'Unexpected plan commission terms: %', v_expected.order_number; END IF;

    SELECT jsonb_array_length(v_order.items) - count(DISTINCT value->>'id') INTO v_duplicates
    FROM jsonb_array_elements(v_order.items);
    IF v_duplicates NOT IN (0, v_expected.duplicates) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_order.items) GROUP BY value->>'id'
      HAVING count(*) > 1 AND (count(*) <> 2 OR count(DISTINCT value) <> 1))
    THEN RAISE EXCEPTION 'Unexpected duplicate line IDs: %', v_expected.order_number; END IF;
    SELECT jsonb_agg(CASE WHEN occurrence > 1 THEN
      jsonb_set(value, '{id}', to_jsonb((value->>'id') || ':other-agents-backfill-' || ordinality::text))
      ELSE value END ORDER BY ordinality) INTO v_items FROM (
      SELECT value, ordinality, row_number() OVER (PARTITION BY value->>'id' ORDER BY ordinality) occurrence
      FROM jsonb_array_elements(v_order.items) WITH ORDINALITY i(value,ordinality)) numbered;
    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(v_items)) <> v_expected.line_count
    THEN RAISE EXCEPTION 'Repaired line ID collision: %', v_expected.order_number; END IF;

    SELECT jsonb_agg(jsonb_build_object('item_id',i.value->>'id','product_id',r.product_id,'rule_id',r.id,
      'unit',i.value->>'unit','quantity',(i.value->>'quantity')::numeric,'rate',round(r.fixed_amount,6),
      'amount',round((i.value->>'quantity')::numeric * round(r.fixed_amount,6),6)) ORDER BY i.ordinality)
    INTO v_lines FROM jsonb_array_elements(v_items) WITH ORDINALITY i(value,ordinality)
    JOIN LATERAL (SELECT * FROM crm.product_commission_rules
      WHERE workspace_id = v_workspace AND product_id::text = COALESCE(i.value->>'product_id',i.value->>'productId')
        AND NOT is_deleted AND is_active AND effective_from <= v_expected.event_at
        AND (effective_to IS NULL OR v_expected.event_at < effective_to)
      ORDER BY effective_from DESC, id LIMIT 1) r ON true
    WHERE r.commission_type = 'fixed_amount' AND lower(r.fixed_currency::text) = 'iqd'
      AND r.recipient_scope = 'all_assigned' AND r.fixed_amount > 0
      AND NULLIF(i.value->>'id','') IS NOT NULL AND (i.value->>'quantity')::numeric > 0
      AND COALESCE((i.value->>'returnedQuantity')::numeric,(i.value->>'returned_quantity')::numeric,0) = 0
      AND COALESCE((i.value->>'fulfilledQuantity')::numeric,(i.value->>'fulfilled_quantity')::numeric,0)
        >= (i.value->>'quantity')::numeric + COALESCE((i.value->>'freeBonusQuantity')::numeric,(i.value->>'free_bonus_quantity')::numeric,0);
    IF COALESCE(jsonb_array_length(v_lines),0) <> v_expected.line_count
      OR (SELECT sum((value->>'quantity')::numeric) FROM jsonb_array_elements(v_lines)) IS DISTINCT FROM v_expected.quantity::numeric
      OR (SELECT sum((value->>'amount')::numeric) FROM jsonb_array_elements(v_lines)) IS DISTINCT FROM v_expected.amount::numeric
      OR (SELECT sum(COALESCE((value->>'freeBonusQuantity')::numeric,(value->>'free_bonus_quantity')::numeric,0))
        FROM jsonb_array_elements(v_items)) IS DISTINCT FROM v_expected.bonus::numeric
    THEN RAISE EXCEPTION 'Historical product commission terms changed: %', v_expected.order_number; END IF;

    -- Existing product snapshots must agree with the historical rules and
    -- signed amounts. Any orphan, payment, manual, or foreign-agent history fails.
    IF EXISTS (SELECT 1 FROM crm.agent_product_commission_entries e
      LEFT JOIN jsonb_array_elements(v_lines) l(value) ON l.value->>'item_id' = e.order_item_id
      WHERE e.workspace_id = v_workspace AND e.order_id = v_order.id AND (
        l.value IS NULL OR e.is_deleted OR e.assignment_id IS DISTINCT FROM v_assignment.id OR e.agent_id IS DISTINCT FROM v_agent
        OR e.kind NOT IN ('accrual','adjustment','reversal') OR e.status NOT IN ('earned','reversed')
        OR e.commission_mode <> 'tracked' OR lower(e.currency::text) <> 'iqd' OR e.order_return_id IS NOT NULL
        OR e.product_id::text IS DISTINCT FROM l.value->>'product_id' OR e.rule_id::text IS DISTINCT FROM l.value->>'rule_id'
        OR e.unit_snapshot IS DISTINCT FROM l.value->>'unit' OR e.commission_per_unit IS DISTINCT FROM (l.value->>'rate')::numeric
        OR e.amount IS DISTINCT FROM round(e.quantity * e.commission_per_unit,6)
        OR (e.kind = 'accrual' AND e.occurred_at IS DISTINCT FROM v_expected.event_at)))
      OR EXISTS (SELECT 1 FROM crm.agent_commission_entries e WHERE e.workspace_id = v_workspace AND e.order_id = v_order.id AND (
        e.is_deleted OR e.assignment_id IS DISTINCT FROM v_assignment.id OR e.agent_id IS DISTINCT FROM v_agent
        OR e.kind NOT IN ('accrual','adjustment','reversal') OR e.status NOT IN ('earned','reversed')
        OR e.commission_mode <> 'tracked' OR lower(e.currency::text) <> 'iqd'
        OR e.plan_commission_amount IS DISTINCT FROM 0::numeric OR e.product_commission_amount IS DISTINCT FROM e.amount))
    THEN RAISE EXCEPTION 'Unexpected existing commission history: %', v_expected.order_number; END IF;
    SELECT COALESCE(sum(amount),0) INTO v_before FROM crm.agent_product_commission_entries
      WHERE workspace_id = v_workspace AND order_id = v_order.id;
    SELECT COALESCE(sum(amount),0) INTO v_aggregate FROM crm.agent_commission_entries
      WHERE workspace_id = v_workspace AND order_id = v_order.id;
    IF v_before NOT IN (v_expected.before_amount, v_expected.amount) OR v_aggregate IS DISTINCT FROM v_before
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l(value)
        LEFT JOIN LATERAL (SELECT COALESCE(sum(quantity),0) q FROM crm.agent_product_commission_entries
          WHERE workspace_id = v_workspace AND order_id = v_order.id AND order_item_id = l.value->>'item_id') c ON true
        WHERE c.q < 0 OR c.q > (l.value->>'quantity')::numeric
          OR (v_before = v_expected.amount AND c.q IS DISTINCT FROM (l.value->>'quantity')::numeric))
      OR (v_expected.needs_creator AND v_count = 1 AND v_before <> v_expected.amount)
      OR (v_duplicates = 0 AND v_expected.duplicates > 0 AND v_before <> v_expected.amount)
      OR (v_before = v_expected.amount AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_lines) l(value)
        WHERE (SELECT count(*) FROM crm.agent_product_commission_entries
          WHERE workspace_id = v_workspace AND order_id = v_order.id
            AND order_item_id = l.value->>'item_id' AND kind = 'accrual') <> 1))
    THEN RAISE EXCEPTION 'Audited commission state changed or partial recovery: %', v_expected.order_number; END IF;
    v_targets := v_targets || jsonb_build_array(jsonb_build_object(
      'order_id',v_order.id,'order_number',v_order.order_number,'agent_id',v_agent,'actor',v_order.created_by,
      'assignment_id',v_assignment.id,'needs_creator',v_expected.needs_creator,'event_at',v_expected.event_at,
      'items',v_items,'repair_ids',v_duplicates > 0,'lines',v_lines,'amount',v_expected.amount,'before',v_before));
  END LOOP;

  FOR v_target IN SELECT value FROM jsonb_array_elements(v_targets) LOOP
    -- A fully verified replay never calls the reconciler or rewrites IDs.
    CONTINUE WHEN (v_target->>'before')::numeric = (v_target->>'amount')::numeric;
    PERFORM set_config('request.jwt.claim.sub',v_target->>'actor',true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_target->>'actor','role','authenticated')::text,true);
    PERFORM set_config('request.jwt.claim.role','authenticated',true);
    IF (v_target->>'assignment_id') IS NULL THEN
      -- Create before changing sync timestamps, retaining the historical event
      -- for SO-2026-00071 and all other newly attributed creator commissions.
      PERFORM private.ensure_order_creator_product_commission_assignment((v_target->>'order_id')::uuid);
    END IF;
    IF (v_target->>'repair_ids')::boolean THEN
      UPDATE crm.sales_orders SET items = v_target->'items', updated_at = clock_timestamp(),
        version = COALESCE(version,0) + 1, sync_status = 'synced'
      WHERE id = (v_target->>'order_id')::uuid;
    END IF;
    PERFORM public.reconcile_sales_agent_commission((v_target->>'order_id')::uuid,NULL);

    SELECT count(*) INTO v_count FROM crm.sales_order_agent_assignments
      WHERE workspace_id = v_workspace AND order_id = (v_target->>'order_id')::uuid;
    IF v_count <> 1 THEN RAISE EXCEPTION 'Recovered assignment count mismatch'; END IF;
    SELECT * INTO STRICT v_assignment FROM crm.sales_order_agent_assignments
      WHERE workspace_id = v_workspace AND order_id = (v_target->>'order_id')::uuid;
    IF v_assignment.agent_id::text IS DISTINCT FROM v_target->>'agent_id'
      OR v_assignment.is_deleted OR v_assignment.unassigned_at IS NOT NULL
      OR (v_target->>'needs_creator')::boolean AND (v_assignment.assignment_source <> 'order_creator_product'
        OR v_assignment.assigned_at IS DISTINCT FROM (v_target->>'event_at')::timestamptz)
    THEN RAISE EXCEPTION 'Recovered assignment does not match audit'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_target->'lines') l(value)
      LEFT JOIN LATERAL (SELECT COALESCE(sum(quantity),0) q, COALESCE(sum(amount),0) a,
        count(*) FILTER (WHERE kind = 'accrual') initials FROM crm.agent_product_commission_entries
        WHERE workspace_id = v_workspace AND order_id = (v_target->>'order_id')::uuid
          AND assignment_id = v_assignment.id AND order_item_id = l.value->>'item_id') c ON true
      WHERE c.q IS DISTINCT FROM (l.value->>'quantity')::numeric
        OR c.a IS DISTINCT FROM (l.value->>'amount')::numeric OR c.initials <> 1)
      OR EXISTS (SELECT 1 FROM crm.agent_product_commission_entries e
        LEFT JOIN jsonb_array_elements(v_target->'lines') l(value) ON l.value->>'item_id' = e.order_item_id
        WHERE e.workspace_id = v_workspace AND e.order_id = (v_target->>'order_id')::uuid AND (
          l.value IS NULL OR e.is_deleted OR e.agent_id::text IS DISTINCT FROM v_target->>'agent_id' OR e.assignment_id <> v_assignment.id
          OR e.commission_mode <> 'tracked' OR lower(e.currency::text) <> 'iqd'
          OR e.kind NOT IN ('accrual','adjustment','reversal') OR e.status NOT IN ('earned','reversed')
          OR e.product_id::text IS DISTINCT FROM l.value->>'product_id' OR e.rule_id::text IS DISTINCT FROM l.value->>'rule_id'
          OR e.unit_snapshot IS DISTINCT FROM l.value->>'unit' OR e.commission_per_unit IS DISTINCT FROM (l.value->>'rate')::numeric
          OR e.amount IS DISTINCT FROM round(e.quantity * e.commission_per_unit,6) OR e.order_return_id IS NOT NULL
          OR (e.kind = 'accrual' AND e.occurred_at IS DISTINCT FROM (v_target->>'event_at')::timestamptz)))
    THEN RAISE EXCEPTION 'Recovered product entries do not match audit: %', v_target->>'order_number'; END IF;
    SELECT COALESCE(sum(amount),0) INTO v_aggregate FROM crm.agent_commission_entries
      WHERE workspace_id = v_workspace AND order_id = (v_target->>'order_id')::uuid;
    IF v_aggregate IS DISTINCT FROM (v_target->>'amount')::numeric OR EXISTS (
      SELECT 1 FROM crm.agent_commission_entries WHERE workspace_id = v_workspace AND order_id = (v_target->>'order_id')::uuid
        AND (is_deleted OR agent_id::text IS DISTINCT FROM v_target->>'agent_id' OR assignment_id <> v_assignment.id
          OR commission_mode <> 'tracked' OR lower(currency::text) <> 'iqd'
          OR kind NOT IN ('accrual','adjustment','reversal') OR status NOT IN ('earned','reversed')
          OR plan_commission_amount IS DISTINCT FROM 0::numeric OR product_commission_amount IS DISTINCT FROM amount))
    THEN RAISE EXCEPTION 'Recovered aggregate commission does not match audit: %', v_target->>'order_number'; END IF;
  END LOOP;

  FOR v_relation IN SELECT jsonb_object_keys(v_protected) LOOP
    IF v_relation = 'public.profiles' THEN
      SELECT md5(COALESCE(string_agg(to_jsonb(p)::text,'' ORDER BY id),'')) INTO v_digest FROM public.profiles p;
    ELSIF v_relation = 'public.workspaces' THEN
      SELECT md5(to_jsonb(w)::text) INTO v_digest FROM public.workspaces w WHERE id = v_workspace;
    ELSE
      v_filter := CASE WHEN v_original_ids ? v_relation THEN
        'AND (id::text IN (SELECT jsonb_array_elements_text($3)) OR order_id IS NULL OR NOT (order_id = ANY($2)))' ELSE '' END;
      v_projection := CASE WHEN v_relation = 'crm.sales_orders' THEN $projection$
        CASE WHEN order_number IN ('SO-2026-00021','SO-2026-00032','SO-2026-00045','SO-2026-00063','SO-2026-00068','SO-2026-00071','SO-2026-00073') THEN
          jsonb_set(to_jsonb(r) - ARRAY['updated_at','version','sync_status'], '{items}',
            (SELECT jsonb_agg(value - 'id' ORDER BY ordinality) FROM jsonb_array_elements(r.items) WITH ORDINALITY i(value,ordinality)))
        ELSE to_jsonb(r) END
      $projection$ ELSE 'to_jsonb(r)' END;
      EXECUTE format('SELECT md5(COALESCE(string_agg((%s)::text, '''' ORDER BY id), '''')) FROM %s r WHERE workspace_id = $1 %s',
        v_projection,v_relation,v_filter) INTO v_digest USING v_workspace,v_ids,v_original_ids->v_relation;
    END IF;
    IF v_digest IS DISTINCT FROM v_protected->>v_relation
    THEN RAISE EXCEPTION 'Recovery changed protected records: %', v_relation; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',COALESCE(v_original_sub,''),true);
  PERFORM set_config('request.jwt.claims',COALESCE(v_original_claims,''),true);
  PERFORM set_config('request.jwt.claim.role',COALESCE(v_original_role,''),true);
  PERFORM set_config('atlas.reconciling_product_commission',COALESCE(v_original_reconciling,''),true);
END;
$recover_other_agents$;
