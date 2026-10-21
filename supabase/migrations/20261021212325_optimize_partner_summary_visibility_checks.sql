-- Resolve the existing privacy policy once per request for unrestricted viewers,
-- rather than re-reading profile/capability state for every aggregate row.
-- Restricted viewers still pass the existing group-visibility helper.
CREATE OR REPLACE FUNCTION crm.read_business_partner_summaries(
  p_workspace_id uuid, p_partner_ids uuid[] DEFAULT NULL
) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
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
  ), merchant AS (
    SELECT p.id AS partner_id,e.currency,sum(e.amount) AS balance
    FROM partners p JOIN delivery.delivery_merchant_profiles m
      ON m.workspace_id=p_workspace_id AND m.business_partner_id=p.id AND NOT m.is_deleted
    JOIN delivery.delivery_ledger_entries e ON e.workspace_id=p_workspace_id AND e.merchant_profile_id=m.id AND NOT e.is_deleted
    GROUP BY p.id,e.currency
  ), courier AS (
    SELECT p.id AS partner_id,e.currency,sum(e.amount) AS balance
    FROM partners p JOIN crm.agents a ON a.workspace_id=p_workspace_id AND a.id=p.agent_facet_id AND NOT a.is_deleted
    JOIN delivery.delivery_ledger_entries e ON e.workspace_id=p_workspace_id AND e.agent_id=a.id AND NOT e.is_deleted
    GROUP BY p.id,e.currency
  ), delivery AS (
    SELECT COALESCE(m.partner_id,c.partner_id) AS partner_id,COALESCE(m.currency,c.currency) AS currency,
      GREATEST(COALESCE(c.balance,0),0)+GREATEST(-COALESCE(m.balance,0),0) AS receivable,
      GREATEST(COALESCE(m.balance,0),0)+GREATEST(-COALESCE(c.balance,0),0) AS payable
    FROM merchant m FULL JOIN courier c ON c.partner_id=m.partner_id AND c.currency=m.currency
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
    SELECT d.partner_id,d.currency,p.default_currency,d.receivable,d.payable,NULL::jsonb,false
    FROM delivery d JOIN partners p ON p.id=d.partner_id
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
REVOKE ALL ON FUNCTION crm.read_business_partner_summaries(uuid,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.read_business_partner_summaries(uuid,uuid[]) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION crm.list_business_partner_directory_page(
  p_workspace_id uuid,
  p_roles text[] DEFAULT NULL,
  p_include_merged boolean DEFAULT false,
  p_include_real_estate_roles boolean DEFAULT false,
  p_include_agent_roles boolean DEFAULT false,
  p_include_ecommerce boolean DEFAULT true,
  p_search text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20,
  p_include_metadata boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, crm
AS $function$
DECLARE
  v_page integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100);
  v_offset bigint;
  v_search text := NULLIF(BTRIM(p_search), '');
  v_pattern text;
  v_result jsonb;
  v_unrestricted boolean;
BEGIN
  IF auth.uid() IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

  v_unrestricted := public.current_user_role()='admin'
    OR COALESCE(public.workspace_get_override_value(p_workspace_id,'capability','businessPartnerGroupPrivacy'),'revoke')<>'grant';
  v_offset := (v_page::bigint - 1) * v_page_size;
  IF v_search IS NOT NULL THEN
    v_pattern := '%' || REPLACE(REPLACE(REPLACE(v_search, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  END IF;

  IF NOT p_include_metadata THEN
    WITH page_rows AS (
      SELECT partner.*
      FROM crm.business_partners AS partner
      WHERE partner.workspace_id = p_workspace_id
        AND partner.workspace_id = public.current_workspace_id()
        AND COALESCE(partner.is_deleted, false) = false
        AND (p_include_merged OR partner.merged_into_business_partner_id IS NULL)
        AND partner.role <> 'witness'
        AND (p_include_real_estate_roles OR partner.role NOT IN ('buyer', 'seller'))
        AND (p_include_agent_roles OR partner.role <> 'agent')
        AND (
          COALESCE(CARDINALITY(p_roles), 0) = 0
          OR partner.role = ANY(p_roles)
          OR (partner.role = 'both' AND p_roles && ARRAY['customer', 'supplier']::text[])
        )
        AND (p_include_ecommerce OR COALESCE(partner.is_ecommerce, false) = false)
        AND (v_unrestricted OR crm.can_access_business_partner(
          partner.workspace_id,
          partner.id,
          CASE WHEN partner.role = 'supplier' THEN 'supplier' ELSE 'customer' END
        ))
        AND (
          v_search IS NULL
          OR partner.partner_name ILIKE v_pattern ESCAPE E'\\'
          OR COALESCE(partner.phone, '') ILIKE v_pattern ESCAPE E'\\'
          OR COALESCE(partner.city, '') ILIKE v_pattern ESCAPE E'\\'
          OR (
            partner.role = 'agent'
            AND EXISTS (
              SELECT 1
              FROM crm.agents AS agent
              WHERE agent.workspace_id = p_workspace_id
                AND agent.business_partner_id = partner.id
                AND COALESCE(agent.is_deleted, false) = false
                AND (
                  agent.zone ILIKE v_pattern ESCAPE E'\\'
                  OR agent.agent_type ILIKE v_pattern ESCAPE E'\\'
                  OR agent.status ILIKE v_pattern ESCAPE E'\\'
                )
            )
          )
        )
      ORDER BY partner.partner_name COLLATE "C" ASC, partner.id ASC
      LIMIT v_page_size
      OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(value ORDER BY value->>'partner_name' COLLATE "C", value->>'id') FROM crm.read_business_partner_summaries(p_workspace_id,
        COALESCE(array_agg(page_rows.id),ARRAY[]::uuid[])) value), '[]'::jsonb)
    )
    INTO v_result
    FROM page_rows;

    RETURN v_result;
  END IF;

  WITH eligible_identities AS MATERIALIZED (
    SELECT partner.*
    FROM crm.business_partners AS partner
    WHERE partner.workspace_id = p_workspace_id
      AND partner.workspace_id = public.current_workspace_id()
      AND COALESCE(partner.is_deleted, false) = false
      AND (p_include_merged OR partner.merged_into_business_partner_id IS NULL)
      AND partner.role <> 'witness'
      AND (p_include_real_estate_roles OR partner.role NOT IN ('buyer', 'seller'))
      AND (p_include_agent_roles OR partner.role <> 'agent')
      AND (
        COALESCE(CARDINALITY(p_roles), 0) = 0
        OR partner.role = ANY(p_roles)
        OR (partner.role = 'both' AND p_roles && ARRAY['customer', 'supplier']::text[])
      )
      AND (p_include_ecommerce OR COALESCE(partner.is_ecommerce, false) = false)
      AND (v_unrestricted OR crm.can_access_business_partner(
        partner.workspace_id,
        partner.id,
        CASE WHEN partner.role = 'supplier' THEN 'supplier' ELSE 'customer' END
      ))
  ),
  eligible AS MATERIALIZED (
    SELECT calculated.*,value->'receivable_currency_totals' AS receivable_currency_totals,
      value->'payable_currency_totals' AS payable_currency_totals,'server'::text AS summary_source
    FROM crm.read_business_partner_summaries(p_workspace_id,
      COALESCE((SELECT array_agg(id) FROM eligible_identities),ARRAY[]::uuid[])) value
    CROSS JOIN LATERAL jsonb_populate_record(NULL::crm.business_partners,value) calculated
  ),
  matching AS MATERIALIZED (
    SELECT eligible.*
    FROM eligible
    WHERE v_search IS NULL
      OR eligible.partner_name ILIKE v_pattern ESCAPE E'\\'
      OR COALESCE(eligible.phone, '') ILIKE v_pattern ESCAPE E'\\'
      OR COALESCE(eligible.city, '') ILIKE v_pattern ESCAPE E'\\'
      OR (
        eligible.role = 'agent'
        AND EXISTS (
          SELECT 1
          FROM crm.agents AS agent
          WHERE agent.workspace_id = p_workspace_id
            AND agent.business_partner_id = eligible.id
            AND COALESCE(agent.is_deleted, false) = false
            AND (
              agent.zone ILIKE v_pattern ESCAPE E'\\'
              OR agent.agent_type ILIKE v_pattern ESCAPE E'\\'
              OR agent.status ILIKE v_pattern ESCAPE E'\\'
            )
        )
      )
  ),
  summary AS (
    SELECT jsonb_build_object(
      'partnerCount', COUNT(*),
      'totalSalesOrders', COALESCE(SUM(total_sales_orders), 0),
      'totalPurchaseOrders', COALESCE(SUM(total_purchase_orders), 0),
      'suppliersWithPurchases', COUNT(*) FILTER (WHERE total_purchase_value > 0),
      'customersWithOutstanding', COUNT(*) FILTER (WHERE receivable_balance > 0),
      'receivableTotals', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('currency', totals.default_currency, 'amount', totals.amount)
          ORDER BY totals.default_currency)
        FROM (
          SELECT default_currency, SUM(receivable_balance) AS amount
          FROM eligible
          GROUP BY default_currency
        ) AS totals
      ), '[]'::jsonb),
      'payableTotals', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('currency', totals.default_currency, 'amount', totals.amount)
          ORDER BY totals.default_currency)
        FROM (
          SELECT default_currency, SUM(payable_balance) AS amount
          FROM eligible
          GROUP BY default_currency
        ) AS totals
      ), '[]'::jsonb)
    ) AS value
    FROM eligible
  ),
  page_rows AS (
    SELECT matching.*
    FROM matching
    ORDER BY matching.partner_name COLLATE "C" ASC, matching.id ASC
    LIMIT v_page_size
    OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page_rows)) FROM page_rows), '[]'::jsonb),
    'totalCount', (SELECT COUNT(*) FROM matching),
    'summary', (SELECT value FROM summary)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION crm.list_business_partner_directory_page(
  uuid, text[], boolean, boolean, boolean, boolean, text, integer, integer, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.list_business_partner_directory_page(
  uuid, text[], boolean, boolean, boolean, boolean, text, integer, integer, boolean
) TO authenticated, service_role;
