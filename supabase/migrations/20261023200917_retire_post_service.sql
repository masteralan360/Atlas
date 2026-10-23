-- Retire Post Service. Prepared for MANUAL application only.
-- Deletes all data and objects inside delivery. Preserves public.payment_transactions,
-- payment account movements/balances, CRM partners/agents, marketplace delivery and voice objects.
-- Deploy the updated partner-account-statement-period Edge Function with this change.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS enforce_post_service_override_admin_console ON public.workspace_access_overrides;
DROP FUNCTION IF EXISTS public.enforce_post_service_override_admin_console();
DELETE FROM public.workspace_access_overrides WHERE type = 'module' AND lower(btrim(key)) = 'post_service';
ALTER TABLE public.workspace_access_overrides DROP CONSTRAINT IF EXISTS workspace_access_overrides_no_retired_modules;
ALTER TABLE public.workspace_access_overrides ADD CONSTRAINT workspace_access_overrides_no_retired_modules
  CHECK (type <> 'module' OR lower(btrim(key)) <> 'post_service');
DELETE FROM public.workspace_permissions WHERE key LIKE 'postService.%' OR module = 'postService';
ALTER TABLE public.workspace_permissions DROP CONSTRAINT IF EXISTS workspace_permissions_no_retired_modules;
ALTER TABLE public.workspace_permissions ADD CONSTRAINT workspace_permissions_no_retired_modules
  CHECK (COALESCE(key, '') NOT LIKE 'postService.%' AND COALESCE(module, '') <> 'postService');

CREATE OR REPLACE FUNCTION public.workspace_module_allowed(p_workspace_id uuid, p_plan text, p_module text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  WITH requested AS (
    SELECT CASE
      WHEN public.workspace_has_override(p_workspace_id, 'module', p_module) THEN
        COALESCE(public.workspace_get_override_value(p_workspace_id, 'module', p_module), 'grant') = 'grant'
      ELSE public.workspace_plan_has_module(p_plan, p_module)
    END AS allowed
  ), prerequisites AS (
    SELECT
      CASE
        WHEN public.workspace_has_override(p_workspace_id, 'module', 'agents') THEN
          COALESCE(public.workspace_get_override_value(p_workspace_id, 'module', 'agents'), 'grant') = 'grant'
        ELSE public.workspace_plan_has_module(p_plan, 'agents')
      END AS agents_allowed,
      CASE
        WHEN public.workspace_has_override(p_workspace_id, 'module', 'orders') THEN
          COALESCE(public.workspace_get_override_value(p_workspace_id, 'module', 'orders'), 'grant') = 'grant'
        ELSE public.workspace_plan_has_module(p_plan, 'orders')
      END AS orders_allowed
  )
  SELECT lower(btrim(COALESCE(p_module, ''))) <> 'post_service' AND requested.allowed
    AND (
      lower(COALESCE(p_module, '')) NOT IN ('sales_agent_commissions', 'agent_sales_accounts')
      OR (prerequisites.agents_allowed AND prerequisites.orders_allowed)
    )
  FROM requested, prerequisites;
$function$;

CREATE OR REPLACE FUNCTION crm.check_business_partner_duplicates(p_workspace_id uuid, p_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_exclude_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_name text := NULLIF(LOWER(BTRIM(p_name)), '');
  v_phone text := NULLIF(REGEXP_REPLACE(
    TRANSLATE(COALESCE(p_phone, ''), 'Ù Ù¡Ù¢Ù£Ù¤Ù¥Ù¦Ù§Ù¨Ù©Û°Û±Û²Û³Û´ÛµÛ¶Û·Û¸Û¹', '01234567890123456789'), '[^0-9]', '', 'g'
  ), '');
  v_restricted boolean;
  v_group_ids uuid[];
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;
  IF v_name IS NULL AND v_phone IS NULL THEN
    RETURN jsonb_build_object('name', false, 'phone', false);
  END IF;

  v_restricted := public.current_user_role() IS DISTINCT FROM 'admin'
    AND COALESCE(public.workspace_get_override_value(p_workspace_id, 'capability', 'businessPartnerGroupPrivacy'), 'revoke') = 'grant';
  IF v_restricted THEN
    SELECT ARRAY_AGG(g.id) INTO v_group_ids
    FROM crm.business_partner_groups g
    JOIN crm.business_partner_group_users u ON u.group_id = g.id AND u.workspace_id = g.workspace_id
    WHERE g.workspace_id = p_workspace_id AND NOT g.is_deleted
      AND NOT u.is_deleted AND u.user_id = auth.uid();
    IF v_group_ids IS NULL THEN
      SELECT ARRAY_AGG(g.id) INTO v_group_ids
      FROM crm.business_partner_groups g
      WHERE g.workspace_id = p_workspace_id AND NOT g.is_deleted AND g.access_type = 'non_grouped';
    END IF;
  END IF;

  WITH matches AS (
    SELECT LOWER(BTRIM(p.partner_name)) = v_name AS name,
      REGEXP_REPLACE(TRANSLATE(COALESCE(p.phone, ''), 'Ù Ù¡Ù¢Ù£Ù¤Ù¥Ù¦Ù§Ù¨Ù©Û°Û±Û²Û³Û´ÛµÛ¶Û·Û¸Û¹', '01234567890123456789'), '[^0-9]', '', 'g') = v_phone AS phone
    FROM crm.business_partners p
    WHERE p.workspace_id = p_workspace_id
      AND COALESCE(p.is_deleted, false) = false
      AND p.merged_into_business_partner_id IS NULL
      AND p.role <> 'witness'
      AND p.id IS DISTINCT FROM p_exclude_id
      AND (
        p.role <> 'agent'
        OR public.workspace_module_allowed(p_workspace_id,
          (SELECT w.plan::text FROM public.workspaces w WHERE w.id = p_workspace_id), 'agents')

      )
      AND (
        LOWER(BTRIM(p.partner_name)) = v_name
        OR REGEXP_REPLACE(TRANSLATE(COALESCE(p.phone, ''), 'Ù Ù¡Ù¢Ù£Ù¤Ù¥Ù¦Ù§Ù¨Ù©Û°Û±Û²Û³Û´ÛµÛ¶Û·Û¸Û¹', '01234567890123456789'), '[^0-9]', '', 'g') = v_phone
      )
      AND (NOT v_restricted OR EXISTS (
        SELECT 1 FROM crm.business_partner_group_partners gp
        WHERE gp.workspace_id = p_workspace_id AND gp.business_partner_id = p.id
          AND NOT gp.is_deleted AND gp.group_id = ANY(v_group_ids)
      ))
  )
  SELECT jsonb_build_object('name', COALESCE(BOOL_OR(name), false), 'phone', COALESCE(BOOL_OR(phone), false))
  INTO v_result FROM matches;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION crm.read_business_partner_summaries(p_workspace_id uuid, p_partner_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_unrestricted boolean;
BEGIN
  IF auth.uid() IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;
  v_unrestricted := public.current_user_role()='admin'
    OR COALESCE(public.workspace_get_override_value(p_workspace_id,'capability','businessPartnerGroupPrivacy'),'revoke')<>'grant';
  RETURN QUERY
  WITH partners AS MATERIALIZED (
    SELECT p.* FROM crm.business_partners p
    WHERE p.workspace_id = p_workspace_id AND NOT COALESCE(p.is_deleted,false)
      AND (p_partner_ids IS NULL OR p.id = ANY(p_partner_ids))
      AND (v_unrestricted OR crm.can_access_business_partner(p.workspace_id,p.id,
        CASE WHEN p.role = 'supplier' THEN 'supplier' ELSE 'customer' END))
  ), orders AS MATERIALIZED (
    SELECT p.id AS partner_id, 'sales' AS kind, o.status, o.total, o.currency, o.exchange_rates,
      o.linked_loan_id, crm.partner_summary_order_balance(o.total,o.paid_amount,o.balance_amount,o.is_paid) AS balance,
      p.default_currency
    FROM partners p JOIN crm.sales_orders o ON o.workspace_id = p_workspace_id
      AND (o.business_partner_id=p.id OR o.customer_id=p.customer_facet_id)
    WHERE NOT o.is_deleted AND o.status <> 'cancelled'
    UNION ALL
    SELECT p.id,'purchase',o.status,o.total,o.currency,o.exchange_rates,o.linked_loan_id,
      crm.partner_summary_order_balance(o.total,o.paid_amount,o.balance_amount,o.is_paid),p.default_currency
    FROM partners p JOIN crm.purchase_orders o ON o.workspace_id = p_workspace_id
      AND (o.business_partner_id=p.id OR o.supplier_id=p.supplier_facet_id)
    WHERE NOT o.is_deleted AND o.status <> 'cancelled'
  ), order_totals AS (
    SELECT partner_id,
      count(*) FILTER (WHERE kind='sales') AS sales_count,
      count(*) FILTER (WHERE kind='purchase') AS purchase_count,
      COALESCE(sum(crm.partner_summary_amount(total,currency,default_currency,exchange_rates))
        FILTER (WHERE kind='sales' AND status='completed'),0) AS sales_value,
      COALESCE(sum(crm.partner_summary_amount(total,currency,default_currency,exchange_rates))
        FILTER (WHERE kind='purchase' AND status IN ('received','completed')),0) AS purchase_value
    FROM orders GROUP BY partner_id
  ), loans AS MATERIALIZED (
    SELECT p.id AS partner_id,p.default_currency,l.* FROM partners p JOIN public.loans l
      ON l.workspace_id=p_workspace_id AND l.linked_party_type='business_partner' AND l.linked_party_id=p.id
    WHERE NOT l.is_deleted
  ), loan_totals AS (
    SELECT partner_id,count(*) AS loan_count,
      COALESCE(sum(crm.partner_summary_amount(balance_amount,settlement_currency,default_currency,exchange_rate_snapshot,true))
        FILTER (WHERE balance_amount>0 AND status NOT IN ('completed','cancelled') AND COALESCE(direction,'lent')<>'borrowed'),0) AS outstanding
    FROM loans GROUP BY partner_id
  ), balances AS MATERIALIZED (
    SELECT partner_id,currency,default_currency,
      CASE WHEN kind='sales' THEN balance ELSE 0 END AS receivable,
      CASE WHEN kind='purchase' THEN balance ELSE 0 END AS payable, exchange_rates AS snapshot,false AS requires_snapshot
    FROM orders WHERE linked_loan_id IS NULL AND balance>0
      AND ((kind='sales' AND status IN ('pending','completed')) OR (kind='purchase' AND status IN ('ordered','received','completed')))
    UNION ALL
    SELECT partner_id,settlement_currency,default_currency,
      CASE WHEN COALESCE(direction,'lent')<>'borrowed' THEN balance_amount ELSE 0 END,
      CASE WHEN direction='borrowed' THEN balance_amount ELSE 0 END,exchange_rate_snapshot,true
    FROM loans WHERE balance_amount>0 AND status NOT IN ('completed','cancelled')
    UNION ALL
    SELECT p.id,s.currency,p.default_currency,s.customer_balance_amount,0,NULL::jsonb,false
    FROM partners p JOIN public.installment_sales s ON s.workspace_id=p_workspace_id AND s.customer_business_partner_id=p.id
    WHERE NOT s.is_deleted AND s.status<>'cancelled' AND s.customer_balance_amount>0
    UNION ALL
    SELECT p.id,t.currency,p.default_currency,
      CASE t.metadata->>'partnerAccountEffect' WHEN 'increase_receivable' THEN t.amount WHEN 'decrease_receivable' THEN -t.amount ELSE 0 END,
      CASE t.metadata->>'partnerAccountEffect' WHEN 'increase_payable' THEN t.amount WHEN 'decrease_payable' THEN -t.amount ELSE 0 END,NULL::jsonb,false
    FROM partners p JOIN public.payment_transactions t ON t.workspace_id=p_workspace_id
      AND t.metadata->>'businessPartnerId'=p.id::text
    WHERE NOT t.is_deleted AND t.source_type='direct_transaction'
      AND t.metadata->>'partnerAccountEffect' IN ('increase_receivable','decrease_receivable','increase_payable','decrease_payable')
  ), balance_totals AS (
    SELECT partner_id,
      round(GREATEST(0,sum(crm.partner_summary_amount(receivable,currency,default_currency,snapshot,requires_snapshot))),3) AS receivable,
      round(GREATEST(0,sum(crm.partner_summary_amount(payable,currency,default_currency,snapshot,requires_snapshot))),3) AS payable
    FROM balances GROUP BY partner_id
  ), native_balances AS (
    SELECT partner_id,currency,round(GREATEST(0,sum(receivable)),3) AS receivable,
      round(GREATEST(0,sum(payable)),3) AS payable FROM balances GROUP BY partner_id,currency
  ), native_totals AS (
    SELECT partner_id,
      COALESCE(jsonb_agg(jsonb_build_object('currency',upper(currency),'amount',receivable) ORDER BY currency)
        FILTER (WHERE receivable>0),'[]'::jsonb) AS receivable,
      COALESCE(jsonb_agg(jsonb_build_object('currency',upper(currency),'amount',payable) ORDER BY currency)
        FILTER (WHERE payable>0),'[]'::jsonb) AS payable
    FROM native_balances GROUP BY partner_id
  )
  SELECT to_jsonb(p) || jsonb_build_object(
    'total_sales_orders',COALESCE(o.sales_count,0),'total_sales_value',COALESCE(o.sales_value,0),
    'total_purchase_orders',COALESCE(o.purchase_count,0),'total_purchase_value',COALESCE(o.purchase_value,0),
    'receivable_balance',COALESCE(b.receivable,0),'payable_balance',COALESCE(b.payable,0),
    'net_exposure',COALESCE(b.receivable,0)-COALESCE(b.payable,0),
    'total_loan_count',COALESCE(l.loan_count,0),'loan_outstanding_balance',COALESCE(l.outstanding,0),
    'receivable_currency_totals',COALESCE(n.receivable,'[]'::jsonb),'payable_currency_totals',COALESCE(n.payable,'[]'::jsonb),
    'summary_source','server')
  FROM partners p LEFT JOIN order_totals o ON o.partner_id=p.id LEFT JOIN loan_totals l ON l.partner_id=p.id
    LEFT JOIN balance_totals b ON b.partner_id=p.id LEFT JOIN native_totals n ON n.partner_id=p.id;
END;
$function$;

CREATE OR REPLACE FUNCTION crm.sync_business_partner(p_operation text, p_entity_id uuid, p_workspace_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'crm', 'pg_temp'
AS $function$
DECLARE
  v_existing crm.business_partners%ROWTYPE;
  v_next crm.business_partners%ROWTYPE;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb)
    - 'staff_visibility'
    - 'owner_user_id'
    - 'staffVisibility'
    - 'ownerUserId';
  v_is_service boolean := auth.role() = 'service_role';
  v_scope text;
BEGIN
  IF p_entity_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Business partner sync requires an entity and workspace id' USING ERRCODE = '22023';
  END IF;
  IF p_operation NOT IN ('upsert', 'soft_delete') THEN
    RAISE EXCEPTION 'Unsupported business partner sync operation: %', p_operation USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_service AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to sync business partners' USING ERRCODE = '42501';
  END IF;
  IF NOT v_is_service AND p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
  FROM crm.business_partners
  WHERE id = p_entity_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.workspace_id IS DISTINCT FROM p_workspace_id THEN
      RAISE EXCEPTION 'Business partner belongs to a different workspace' USING ERRCODE = '42501';
    END IF;

    v_scope := CASE WHEN v_existing.role = 'supplier' THEN 'supplier' ELSE 'customer' END;
    IF NOT v_is_service
      AND NOT crm.can_manage_business_partner(v_existing.workspace_id, v_existing.id, v_scope) THEN
      RAISE EXCEPTION 'Business partner access denied' USING ERRCODE = '42501';
    END IF;

    IF p_operation = 'soft_delete' THEN
      UPDATE crm.business_partners
      SET is_deleted = true,
          updated_at = now()
      WHERE id = p_entity_id;
      RETURN;
    END IF;

    PERFORM crm.assert_partner_sync_payload_columns('crm.business_partners'::regclass, v_payload);
    v_next := jsonb_populate_record(v_existing, v_payload);

    IF v_next.id IS DISTINCT FROM p_entity_id OR v_next.workspace_id IS DISTINCT FROM v_existing.workspace_id THEN
      RAISE EXCEPTION 'Business partner identity and workspace cannot change during sync' USING ERRCODE = '42501';
    END IF;
    IF v_next.role = 'agent'
      AND NOT (
        public.workspace_module_allowed(
          p_workspace_id,
          (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = p_workspace_id),
          'agents'
        )

      ) THEN
      RAISE EXCEPTION 'Agents module is not available in this workspace' USING ERRCODE = '42501';
    END IF;

    UPDATE crm.business_partners
    SET partner_name = v_next.partner_name,
        name = v_next.name,
        contact_name = v_next.contact_name,
        phone = v_next.phone,
        address = v_next.address,
        city = v_next.city,
        notes = v_next.notes,
        default_currency = v_next.default_currency,
        role = v_next.role,
        credit_limit = v_next.credit_limit,
        receivable_credit_limit = v_next.receivable_credit_limit,
        payable_credit_limit = v_next.payable_credit_limit,
        customer_facet_id = v_next.customer_facet_id,
        supplier_facet_id = v_next.supplier_facet_id,
        agent_facet_id = v_next.agent_facet_id,
        price_book_id = v_next.price_book_id,
        total_sales_orders = v_next.total_sales_orders,
        total_sales_value = v_next.total_sales_value,
        receivable_balance = v_next.receivable_balance,
        total_purchase_orders = v_next.total_purchase_orders,
        total_purchase_value = v_next.total_purchase_value,
        payable_balance = v_next.payable_balance,
        total_loan_count = v_next.total_loan_count,
        loan_outstanding_balance = v_next.loan_outstanding_balance,
        net_exposure = v_next.net_exposure,
        merged_into_business_partner_id = v_next.merged_into_business_partner_id,
        is_ecommerce = v_next.is_ecommerce,
        updated_at = COALESCE(v_next.updated_at, now()),
        version = v_next.version,
        is_deleted = v_next.is_deleted,
        latitude = v_next.latitude,
        longitude = v_next.longitude
    WHERE id = p_entity_id;
    RETURN;
  END IF;

  IF p_operation = 'soft_delete' THEN
    -- A retry after a successful delete is idempotent.
    RETURN;
  END IF;

  PERFORM crm.assert_partner_sync_payload_columns('crm.business_partners'::regclass, v_payload);
  v_next := jsonb_populate_record(NULL::crm.business_partners, v_payload);

  IF v_next.id IS DISTINCT FROM p_entity_id OR v_next.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'Business partner identity and workspace must match the sync request' USING ERRCODE = '42501';
  END IF;
  IF v_next.role = 'agent'
    AND NOT (
      public.workspace_module_allowed(
        p_workspace_id,
        (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = p_workspace_id),
        'agents'
      )

    ) THEN
    RAISE EXCEPTION 'Agents module is not available in this workspace' USING ERRCODE = '42501';
  END IF;

  v_next.sync_status := COALESCE(v_next.sync_status, 'synced');
  v_next.created_at := COALESCE(v_next.created_at, now());
  v_next.updated_at := COALESCE(v_next.updated_at, now());
  v_next.default_currency := COALESCE(v_next.default_currency, 'usd');
  v_next.role := COALESCE(v_next.role, 'customer');
  v_next.is_deleted := COALESCE(v_next.is_deleted, false);
  v_next.is_ecommerce := COALESCE(v_next.is_ecommerce, false);
  v_next.version := COALESCE(v_next.version, 1);

  INSERT INTO crm.business_partners (
    id, workspace_id, partner_name, name, contact_name, phone, address, city, notes,
    default_currency, role, credit_limit, receivable_credit_limit, payable_credit_limit,
    customer_facet_id, supplier_facet_id, agent_facet_id, price_book_id,
    total_sales_orders, total_sales_value, receivable_balance,
    total_purchase_orders, total_purchase_value, payable_balance,
    total_loan_count, loan_outstanding_balance, net_exposure,
    merged_into_business_partner_id, is_ecommerce, created_at, updated_at, sync_status,
    version, is_deleted, latitude, longitude
  ) VALUES (
    v_next.id, v_next.workspace_id, v_next.partner_name, v_next.name, v_next.contact_name,
    v_next.phone, v_next.address, v_next.city, v_next.notes, v_next.default_currency,
    v_next.role, v_next.credit_limit, v_next.receivable_credit_limit,
    v_next.payable_credit_limit, v_next.customer_facet_id, v_next.supplier_facet_id,
    v_next.agent_facet_id, v_next.price_book_id, v_next.total_sales_orders,
    v_next.total_sales_value, v_next.receivable_balance, v_next.total_purchase_orders,
    v_next.total_purchase_value, v_next.payable_balance, v_next.total_loan_count,
    v_next.loan_outstanding_balance, v_next.net_exposure, v_next.merged_into_business_partner_id,
    v_next.is_ecommerce, v_next.created_at, v_next.updated_at, v_next.sync_status,
    v_next.version, v_next.is_deleted, v_next.latitude, v_next.longitude
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_crm_business_partner_agent_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'crm'
AS $function$
DECLARE v_plan text;
BEGIN
  IF NEW.role <> 'agent' THEN RETURN NEW; END IF;
  SELECT plan::text INTO v_plan FROM public.workspaces WHERE id = NEW.workspace_id AND deleted_at IS NULL;
  IF v_plan IS NULL OR NOT (
    public.workspace_module_allowed(NEW.workspace_id, v_plan, 'agents')

  ) THEN
    RAISE EXCEPTION 'Agent roles require Agents access' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.workspace_plan_has_module(p_plan text, p_module text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE lower(coalesce(p_module, ''))
    WHEN 'pos' THEN true
    WHEN 'instant_pos' THEN false
    WHEN 'kds' THEN false
    WHEN 'sales_history' THEN true
    WHEN 'products' THEN true
    WHEN 'services' THEN false
    WHEN 'storages' THEN true
    WHEN 'inventory_transfer' THEN true
    WHEN 'inventory_transactions' THEN true
    WHEN 'stock_adjustments' THEN true
    WHEN 'ledger' THEN true
    WHEN 'payments' THEN true
    WHEN 'payment_accounts' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'cashier_shift_control' THEN false
    WHEN 'direct_transactions' THEN true
    WHEN 'members' THEN true
    WHEN 'business_partners' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'agents' THEN false
    WHEN 'sales_agent_commissions' THEN false
    WHEN 'agent_sales_accounts' THEN false

    WHEN 'car_rental' THEN false
    WHEN 'customers' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'suppliers' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'orders' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'ecommerce' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'real_estate' THEN false
    WHEN 'activities' THEN false
    WHEN 'currency_exchange' THEN false
    WHEN 'clinical_appointments' THEN false
    WHEN 'loans' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'installments' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'discounts' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'revenue_analytics' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'customer_profitability' THEN false
    WHEN 'team_performance' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'invoice_history' THEN public.normalize_workspace_plan(p_plan) IN ('business', 'enterprise')
    WHEN 'accounting' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'hr' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'expenses' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'payroll' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'whatsapp' THEN public.normalize_workspace_plan(p_plan) = 'enterprise'
    WHEN 'manual_entry' THEN false
    ELSE false
  END;
$function$;

ALTER POLICY "crm_agents_select" ON "crm"."agents"
  USING (((workspace_id = current_workspace_id()) AND (workspace_module_allowed(workspace_id, ( SELECT (w.plan)::text AS plan
   FROM workspaces w
  WHERE (w.id = agents.workspace_id)), 'agents'::text))));

ALTER POLICY "crm_agents_insert" ON "crm"."agents"
  WITH CHECK (((workspace_id = current_workspace_id()) AND (workspace_module_allowed(workspace_id, ( SELECT (w.plan)::text AS plan
   FROM workspaces w
  WHERE (w.id = agents.workspace_id)), 'agents'::text))));

ALTER POLICY "crm_agents_update" ON "crm"."agents"
  USING (((workspace_id = current_workspace_id()) AND (workspace_module_allowed(workspace_id, ( SELECT (w.plan)::text AS plan
   FROM workspaces w
  WHERE (w.id = agents.workspace_id)), 'agents'::text))))
  WITH CHECK ((workspace_id = current_workspace_id()));

ALTER POLICY "crm_business_partners_insert" ON "crm"."business_partners"
  WITH CHECK (((workspace_id = current_workspace_id()) AND ((role <> 'agent'::text) OR workspace_module_allowed(workspace_id, ( SELECT (workspace.plan)::text AS plan
   FROM workspaces workspace
  WHERE (workspace.id = business_partners.workspace_id)), 'agents'::text))));

ALTER POLICY "crm_business_partners_update" ON "crm"."business_partners"
  USING ((crm.can_manage_business_partner(workspace_id, id,
CASE
    WHEN (role = 'supplier'::text) THEN 'supplier'::text
    ELSE 'customer'::text
END) AND ((role <> 'agent'::text) OR workspace_module_allowed(workspace_id, ( SELECT (workspace.plan)::text AS plan
   FROM workspaces workspace
  WHERE (workspace.id = business_partners.workspace_id)), 'agents'::text))))
  WITH CHECK ((workspace_id = current_workspace_id()));

ALTER POLICY "crm_business_partners_delete" ON "crm"."business_partners"
  USING ((crm.can_manage_business_partner(workspace_id, id,
CASE
    WHEN (role = 'supplier'::text) THEN 'supplier'::text
    ELSE 'customer'::text
END) AND ((role <> 'agent'::text) OR workspace_module_allowed(workspace_id, ( SELECT (workspace.plan)::text AS plan
   FROM workspaces workspace
  WHERE (workspace.id = business_partners.workspace_id)), 'agents'::text))));

ALTER POLICY "crm_business_partners_select" ON "crm"."business_partners"
  USING ((crm.can_access_business_partner(workspace_id, id,
CASE
    WHEN (role = 'supplier'::text) THEN 'supplier'::text
    ELSE 'customer'::text
END) AND ((role <> 'agent'::text) OR workspace_module_allowed(workspace_id, ( SELECT (workspace.plan)::text AS plan
   FROM workspaces workspace
  WHERE (workspace.id = business_partners.workspace_id)), 'agents'::text))));

-- The private bucket is shared; retire only this workflow's access policies/helper.
DROP POLICY IF EXISTS delivery_voice_reason_read ON storage.objects;
DROP POLICY IF EXISTS delivery_voice_reason_upload ON storage.objects;
DROP POLICY IF EXISTS delivery_voice_reason_delete ON storage.objects;
DROP FUNCTION IF EXISTS app_private.can_access_delivery_voice_reason_object(text);

-- Refuse unexpected cross-schema dependencies instead of cascading through unrelated modules.
DO $retirement_preflight$
DECLARE dependency text;
BEGIN
  SELECT format('%I.%I (%I)', n.nspname, c.relname, co.conname) INTO dependency
  FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_class target ON target.oid=co.confrelid JOIN pg_namespace tn ON tn.oid=target.relnamespace
  WHERE co.contype='f' AND tn.nspname='delivery' AND n.nspname<>'delivery' LIMIT 1;
  IF dependency IS NOT NULL THEN RAISE EXCEPTION 'Unreviewed foreign key depends on delivery: %', dependency; END IF;

  SELECT format('%I.%I', n.nspname, p.proname) INTO dependency
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT IN ('delivery','pg_catalog','information_schema')
    AND p.prokind='f' AND p.prosrc ~ '\mdelivery\.[a-z_]'
  LIMIT 1;
  IF dependency IS NOT NULL THEN RAISE EXCEPTION 'Unreviewed function still references delivery: %', dependency; END IF;

  SELECT format('%I.%I (%I)', n.nspname, c.relname, t.tgname) INTO dependency
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
  WHERE pn.nspname='delivery' AND n.nspname<>'delivery' AND NOT t.tgisinternal LIMIT 1;
  IF dependency IS NOT NULL THEN RAISE EXCEPTION 'Unreviewed trigger depends on delivery: %', dependency; END IF;

  SELECT format('%I.%I', n.nspname, c.relname) INTO dependency
  FROM pg_depend d JOIN pg_rewrite r ON d.classid='pg_rewrite'::regclass AND r.oid=d.objid
  JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_class target ON d.refclassid='pg_class'::regclass AND target.oid=d.refobjid
  JOIN pg_namespace tn ON tn.oid=target.relnamespace
  WHERE tn.nspname='delivery' AND n.nspname<>'delivery' LIMIT 1;
  IF dependency IS NOT NULL THEN RAISE EXCEPTION 'Unreviewed view depends on delivery: %', dependency; END IF;

  SELECT format('%I.%I (%I)', p.schemaname,p.tablename,p.policyname) INTO dependency
  FROM pg_policies p WHERE p.schemaname<>'delivery'
    AND (COALESCE(p.qual,'') || COALESCE(p.with_check,'')) ~ 'delivery\.|can_access_delivery'
  LIMIT 1;
  IF dependency IS NOT NULL THEN RAISE EXCEPTION 'Unreviewed policy depends on delivery: %', dependency; END IF;

  -- Also cover compiled SQL functions, composite types, inherited tables and
  -- other catalog-tracked dependencies that a source-text check cannot see.
  WITH RECURSIVE dependencies(classid,objid,objsubid) AS (
    SELECT 'pg_namespace'::regclass::oid,oid,0 FROM pg_namespace WHERE nspname='delivery'
    UNION
    SELECT d.classid,d.objid,d.objsubid FROM pg_depend d JOIN dependencies parent
      ON d.refclassid=parent.classid AND d.refobjid=parent.objid
      AND (parent.objsubid=0 OR parent.objsubid=d.refobjsubid)
    WHERE d.deptype<>'p'
  )
  SELECT description.identity INTO dependency
  FROM dependencies d
  CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) description
  LEFT JOIN pg_constraint co ON d.classid='pg_constraint'::regclass AND co.oid=d.objid
  LEFT JOIN pg_trigger tr ON d.classid='pg_trigger'::regclass AND tr.oid=d.objid
  LEFT JOIN pg_rewrite rw ON d.classid='pg_rewrite'::regclass AND rw.oid=d.objid
  LEFT JOIN pg_policy pol ON d.classid='pg_policy'::regclass AND pol.oid=d.objid
  LEFT JOIN pg_class owner_table ON owner_table.oid=COALESCE(co.conrelid,tr.tgrelid,rw.ev_class,pol.polrelid)
  LEFT JOIN pg_namespace owner_namespace ON owner_namespace.oid=owner_table.relnamespace
  WHERE COALESCE(description.schema,owner_namespace.nspname) NOT IN ('delivery','pg_catalog','pg_toast')
    AND NOT (COALESCE(tr.tgisinternal,false) AND EXISTS (
      -- Removing delivery's own foreign keys also removes their internal RI
      -- triggers on the referenced shared tables; the shared rows stay intact.
      SELECT 1 FROM pg_constraint foreign_key
      JOIN pg_class child ON child.oid=foreign_key.conrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid=child.relnamespace
      WHERE foreign_key.oid=tr.tgconstraint AND child_namespace.nspname='delivery'
    ))
  LIMIT 1;
  IF dependency IS NOT NULL THEN RAISE EXCEPTION 'Unreviewed object depends on delivery: %', dependency; END IF;
END;
$retirement_preflight$;

-- CASCADE is confined by the preflight above; contained data is intentionally deleted.
DROP SCHEMA IF EXISTS delivery CASCADE;

-- This per-post setting was specific to the retired workflow; agent identities remain.
ALTER TABLE crm.agents DROP COLUMN IF EXISTS courier_delivery_fee;

-- Strip the retired schema from explicit PostgREST role configuration, if present.
DO $api_configuration$
DECLARE configured text; filtered text;
BEGIN
  SELECT substring(setting FROM length('pgrst.db_schemas=')+1) INTO configured
  FROM pg_roles r, unnest(r.rolconfig) setting
  WHERE r.rolname='authenticator' AND setting LIKE 'pgrst.db_schemas=%';
  IF configured IS NOT NULL THEN
    SELECT string_agg(btrim(name), ',') INTO filtered
    FROM unnest(string_to_array(configured, ',')) name WHERE btrim(name)<>'delivery';
    IF filtered IS NOT NULL THEN
      EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas TO %L', filtered);
    END IF;
  END IF;
END;
$api_configuration$;

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
COMMIT;
