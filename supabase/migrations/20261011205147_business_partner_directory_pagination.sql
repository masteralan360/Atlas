-- Keep partner directories bounded at the API boundary while preserving the
-- workspace visibility check used by the existing full-list reader.
CREATE INDEX IF NOT EXISTS business_partners_directory_workspace_name_id_idx
  ON crm.business_partners (workspace_id, partner_name COLLATE "C", id)
  WHERE COALESCE(is_deleted, false) = false
    AND merged_into_business_partner_id IS NULL;

CREATE INDEX IF NOT EXISTS business_partners_directory_workspace_role_name_id_idx
  ON crm.business_partners (workspace_id, role, partner_name COLLATE "C", id)
  WHERE COALESCE(is_deleted, false) = false
    AND merged_into_business_partner_id IS NULL;

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
BEGIN
  IF p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

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
        AND crm.can_access_business_partner(
          partner.workspace_id,
          partner.id,
          CASE WHEN partner.role = 'supplier' THEN 'supplier' ELSE 'customer' END
        )
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
      'items', COALESCE(jsonb_agg(to_jsonb(page_rows)), '[]'::jsonb)
    )
    INTO v_result
    FROM page_rows;

    RETURN v_result;
  END IF;

  WITH eligible AS MATERIALIZED (
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
      AND crm.can_access_business_partner(
        partner.workspace_id,
        partner.id,
        CASE WHEN partner.role = 'supplier' THEN 'supplier' ELSE 'customer' END
      )
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
