CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_workspace_created_id
  ON crm.sales_orders (workspace_id, created_at DESC, id DESC)
  WHERE COALESCE(is_deleted, false) = false;

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_workspace_created_id
  ON crm.purchase_orders (workspace_id, created_at DESC, id DESC)
  WHERE COALESCE(is_deleted, false) = false;

CREATE INDEX IF NOT EXISTS idx_crm_sales_orders_order_number_trgm
  ON crm.sales_orders USING gin (order_number extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;

CREATE INDEX IF NOT EXISTS idx_crm_purchase_orders_order_number_trgm
  ON crm.purchase_orders USING gin (order_number extensions.gin_trgm_ops)
  WHERE COALESCE(is_deleted, false) = false;

CREATE OR REPLACE FUNCTION crm.get_orders_list_page(
  p_workspace_id uuid,
  p_order_type text,
  p_created_from timestamptz,
  p_created_to timestamptz,
  p_fulfilled_from timestamptz,
  p_fulfilled_to timestamptz,
  p_status text,
  p_payment_status text,
  p_ecommerce_filter text,
  p_commission_mode text,
  p_search text,
  p_include_archived boolean,
  p_page integer,
  p_page_size integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH normalized AS (
    SELECT
      GREATEST(COALESCE(p_page, 1), 1) AS page_number,
      LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100) AS page_size,
      LOWER(BTRIM(COALESCE(p_search, ''))) AS search_term,
      COALESCE(p_order_type, 'sales') AS order_type,
      COALESCE(p_include_archived, false) AS include_archived,
      public.current_user_role() IS DISTINCT FROM 'admin'
        AND EXISTS (
          SELECT 1
          FROM public.storage_member_exclusions AS exclusion
          WHERE exclusion.workspace_id = p_workspace_id
            AND exclusion.user_id = auth.uid()
            AND COALESCE(exclusion.is_deleted, false) = false
        ) AS storage_restricted
  ),
  raw_orders AS (
    SELECT
      order_row.id,
      order_row.workspace_id,
      order_row.created_at,
      order_row.created_by,
      order_row.updated_at,
      order_row.status,
      order_row.is_archived,
      order_row.order_number,
      order_row.customer_name AS counterparty_name,
      order_row.customer_id AS counterparty_id,
      order_row.business_partner_id,
      order_row.source_storage_id AS fallback_storage_id,
      order_row.source_channel,
      order_row.commission_mode,
      order_row.commission_enabled,
      order_row.return_status,
      order_row.actual_delivery_date,
      order_row.payment_status,
      order_row.is_paid,
      order_row.paid_amount,
      order_row.balance_amount,
      order_row.total,
      order_row.subtotal,
      order_row.discount,
      order_row.tax,
      order_row.currency,
      order_row.items,
      to_jsonb(order_row) AS order_json,
      'sales'::text AS order_type
    FROM crm.sales_orders AS order_row
    CROSS JOIN normalized
    WHERE normalized.order_type = 'sales'
      AND order_row.workspace_id = p_workspace_id
      AND p_workspace_id = public.current_workspace_id()
      AND COALESCE(order_row.is_deleted, false) = false
    UNION ALL
    SELECT
      order_row.id,
      order_row.workspace_id,
      order_row.created_at,
      order_row.created_by,
      order_row.updated_at,
      order_row.status,
      order_row.is_archived,
      order_row.order_number,
      order_row.supplier_name AS counterparty_name,
      order_row.supplier_id AS counterparty_id,
      order_row.business_partner_id,
      order_row.destination_storage_id AS fallback_storage_id,
      NULL::text AS source_channel,
      NULL::text AS commission_mode,
      NULL::boolean AS commission_enabled,
      NULL::text AS return_status,
      order_row.actual_delivery_date,
      order_row.payment_status,
      order_row.is_paid,
      order_row.paid_amount,
      order_row.balance_amount,
      order_row.total,
      order_row.subtotal,
      order_row.discount,
      0::numeric AS tax,
      order_row.currency,
      order_row.items,
      to_jsonb(order_row) AS order_json,
      'purchase'::text AS order_type
    FROM crm.purchase_orders AS order_row
    CROSS JOIN normalized
    WHERE normalized.order_type = 'purchase'
      AND order_row.workspace_id = p_workspace_id
      AND p_workspace_id = public.current_workspace_id()
      AND COALESCE(order_row.is_deleted, false) = false
  ),
  with_visible_items AS (
    SELECT
      raw_orders.*,
      COALESCE(visible.items, '[]'::jsonb) AS visible_items,
      COALESCE(visible.visible_count, 0) AS visible_item_count,
      COALESCE(jsonb_array_length(raw_orders.items), 0) AS original_item_count,
      COALESCE(visible.visible_subtotal, 0) AS visible_subtotal
    FROM raw_orders
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(item.value ORDER BY item.ordinality) AS items,
        COUNT(*) FILTER (WHERE item_visibility.is_visible) AS visible_count,
        COALESCE(SUM(CASE
          WHEN item_visibility.is_visible
            THEN COALESCE(NULLIF(COALESCE(item.value ->> 'lineTotal', item.value ->> 'line_total'), '')::numeric, 0)
          ELSE 0
        END), 0) AS visible_subtotal
      FROM jsonb_array_elements(COALESCE(raw_orders.items, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN COALESCE(item.value ->> 'isService', item.value ->> 'is_service', 'false') = 'true'
            OR COALESCE(item.value ->> 'storageId', item.value ->> 'storage_id') = '__atlas_services__'
            THEN true
          ELSE public.current_user_can_access_storage(
            raw_orders.workspace_id,
            NULLIF(COALESCE(
              item.value ->> 'storageId',
              item.value ->> 'storage_id',
              raw_orders.fallback_storage_id::text
            ), '')::uuid
          )
        END AS is_visible
      ) AS item_visibility
      WHERE item_visibility.is_visible
    ) AS visible ON true
  ),
  redacted_orders AS (
    SELECT
      visible_orders.*,
      CASE
        WHEN NOT (SELECT storage_restricted FROM normalized)
          THEN COALESCE(visible_orders.subtotal, 0)
        ELSE visible_orders.visible_subtotal
      END AS visible_subtotal_amount,
      CASE
        WHEN NOT (SELECT storage_restricted FROM normalized)
          THEN COALESCE(visible_orders.discount, 0)
        WHEN COALESCE(visible_orders.subtotal, 0) > 0
          THEN COALESCE(visible_orders.discount, 0) * visible_orders.visible_subtotal / visible_orders.subtotal
        ELSE 0
      END AS visible_discount,
      CASE
        WHEN visible_orders.order_type = 'sales'
          AND (SELECT storage_restricted FROM normalized)
          THEN CASE
            WHEN COALESCE(visible_orders.subtotal, 0) > 0
              THEN COALESCE(visible_orders.tax, 0) * visible_orders.visible_subtotal / visible_orders.subtotal
            ELSE 0
          END
        ELSE COALESCE(visible_orders.tax, 0)
      END AS visible_tax,
      CASE
        WHEN NOT (SELECT storage_restricted FROM normalized)
          THEN COALESCE(visible_orders.total, 0)
        WHEN COALESCE(visible_orders.subtotal, 0) > 0
          THEN GREATEST(0,
            visible_orders.visible_subtotal
            - COALESCE(visible_orders.discount, 0) * visible_orders.visible_subtotal / visible_orders.subtotal
            + CASE WHEN visible_orders.order_type = 'sales'
                THEN COALESCE(visible_orders.tax, 0) * visible_orders.visible_subtotal / visible_orders.subtotal
                ELSE 0
              END
          )
        ELSE GREATEST(0, visible_orders.visible_subtotal)
      END AS visible_total,
      CASE
        WHEN NOT (SELECT storage_restricted FROM normalized)
          THEN LEAST(COALESCE(visible_orders.total, 0), COALESCE(visible_orders.paid_amount, 0))
        WHEN COALESCE(visible_orders.subtotal, 0) > 0
          THEN LEAST(
            GREATEST(0,
              visible_orders.visible_subtotal
              - COALESCE(visible_orders.discount, 0) * visible_orders.visible_subtotal / visible_orders.subtotal
              + CASE WHEN visible_orders.order_type = 'sales'
                  THEN COALESCE(visible_orders.tax, 0) * visible_orders.visible_subtotal / visible_orders.subtotal
                  ELSE 0
                END
            ),
            COALESCE(visible_orders.paid_amount, 0) * visible_orders.visible_subtotal / visible_orders.subtotal
          )
        ELSE 0
      END AS visible_paid_amount
    FROM with_visible_items AS visible_orders
    WHERE visible_orders.original_item_count = 0 OR visible_orders.visible_item_count > 0
  ),
  enriched_orders AS (
    SELECT
      redacted_orders.*,
      GREATEST(0, redacted_orders.visible_total - redacted_orders.visible_paid_amount) AS visible_balance_amount,
      CASE
        WHEN redacted_orders.payment_status IN ('paid', 'partial', 'unpaid')
          THEN redacted_orders.payment_status
        WHEN redacted_orders.visible_paid_amount <= 0 THEN 'unpaid'
        WHEN redacted_orders.visible_paid_amount >= redacted_orders.visible_total THEN 'paid'
        ELSE 'partial'
      END AS effective_payment_status,
      redacted_orders.order_json || jsonb_build_object(
        'items', redacted_orders.visible_items,
        'subtotal', redacted_orders.visible_subtotal_amount,
        'discount', redacted_orders.visible_discount,
        'tax', redacted_orders.visible_tax,
        'total', redacted_orders.visible_total,
        'paid_amount', redacted_orders.visible_paid_amount,
        'balance_amount', GREATEST(0, redacted_orders.visible_total - redacted_orders.visible_paid_amount),
        'source_storage_id', CASE
          WHEN redacted_orders.order_type <> 'sales' THEN redacted_orders.order_json -> 'source_storage_id'
          WHEN public.current_user_can_access_storage(redacted_orders.workspace_id, NULLIF(redacted_orders.order_json ->> 'source_storage_id', '')::uuid)
            THEN redacted_orders.order_json -> 'source_storage_id'
          ELSE 'null'::jsonb
        END,
        'destination_storage_id', CASE
          WHEN redacted_orders.order_type <> 'purchase' THEN redacted_orders.order_json -> 'destination_storage_id'
          WHEN public.current_user_can_access_storage(redacted_orders.workspace_id, NULLIF(redacted_orders.order_json ->> 'destination_storage_id', '')::uuid)
            THEN redacted_orders.order_json -> 'destination_storage_id'
          ELSE 'null'::jsonb
        END
      ) AS visible_order_json
    FROM redacted_orders
  ),
  filtered_orders AS (
    SELECT enriched_orders.*
    FROM enriched_orders
    CROSS JOIN normalized
    WHERE (normalized.include_archived OR COALESCE(enriched_orders.is_archived, false) = false)
      AND (NOT normalized.include_archived OR COALESCE(enriched_orders.is_archived, false) = true)
      AND (p_created_from IS NULL OR enriched_orders.created_at >= p_created_from)
      AND (p_created_to IS NULL OR enriched_orders.created_at < p_created_to)
      AND (p_fulfilled_from IS NULL OR enriched_orders.actual_delivery_date >= p_fulfilled_from)
      AND (p_fulfilled_to IS NULL OR enriched_orders.actual_delivery_date < p_fulfilled_to)
      AND (NULLIF(p_status, '') IS NULL OR p_status = 'all' OR enriched_orders.status = p_status)
      AND (
        NULLIF(p_payment_status, '') IS NULL
        OR p_payment_status = 'all'
        OR (p_payment_status = 'returned' AND enriched_orders.order_type = 'sales' AND enriched_orders.return_status = 'full')
        OR (p_payment_status IN ('paid', 'partial', 'unpaid') AND enriched_orders.effective_payment_status = p_payment_status)
      )
      AND (
        COALESCE(p_ecommerce_filter, 'all') = 'all'
        OR (p_ecommerce_filter = 'ecommerce' AND enriched_orders.source_channel = 'marketplace')
        OR (p_ecommerce_filter = 'nonEcommerce' AND COALESCE(enriched_orders.source_channel, 'manual') <> 'marketplace')
      )
      AND (
        COALESCE(p_commission_mode, 'all') = 'all'
        OR enriched_orders.order_type <> 'sales'
        OR CASE
          WHEN enriched_orders.commission_mode IS NOT NULL THEN enriched_orders.commission_mode
          WHEN COALESCE(enriched_orders.commission_enabled, true) = false THEN NULL
          ELSE 'payable'
        END = p_commission_mode
      )
      AND (
        normalized.search_term = ''
        OR COALESCE(enriched_orders.order_number, '') ILIKE '%' || normalized.search_term || '%'
        OR POSITION(normalized.search_term IN LOWER(COALESCE(enriched_orders.counterparty_name, ''))) > 0
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(enriched_orders.visible_items) AS item(value)
          WHERE POSITION(normalized.search_term IN LOWER(COALESCE(
            item.value ->> 'productName',
            item.value ->> 'name',
            item.value ->> 'product_name',
            ''
          ))) > 0
          OR POSITION(normalized.search_term IN LOWER(COALESCE(
            item.value ->> 'productSku',
            item.value ->> 'product_sku',
            item.value ->> 'sku',
            ''
          ))) > 0
        )
        OR (
          enriched_orders.order_type = 'sales'
          AND EXISTS (
            SELECT 1
            FROM crm.sales_order_agent_assignments AS assignment
            INNER JOIN crm.agents AS agent ON agent.id = assignment.agent_id
            INNER JOIN crm.list_visible_business_partners(p_workspace_id) AS partner
              ON partner.id = agent.business_partner_id
            WHERE assignment.workspace_id = enriched_orders.workspace_id
              AND assignment.order_id = enriched_orders.id
              AND COALESCE(assignment.is_deleted, false) = false
              AND assignment.unassigned_at IS NULL
              AND COALESCE(agent.is_deleted, false) = false
              AND COALESCE(partner.is_deleted, false) = false
              AND (
                private.sales_agent_commissions_has_permission(enriched_orders.workspace_id, 'salesAgentCommissions.viewAll')
                OR private.sales_agent_commissions_has_permission(enriched_orders.workspace_id, 'salesAgentCommissions.assignOrders')
                OR (
                  private.sales_agent_commissions_has_permission(enriched_orders.workspace_id, 'salesAgentCommissions.viewOwn')
                  AND agent.linked_user_id = auth.uid()
                )
              )
              AND POSITION(normalized.search_term IN LOWER(COALESCE(partner.partner_name, ''))) > 0
          )
        )
      )
  ),
  page_orders AS (
    SELECT *
    FROM filtered_orders
    ORDER BY created_at DESC NULLS LAST, id DESC
    OFFSET (SELECT (page_number - 1) * page_size FROM normalized)
    LIMIT (SELECT page_size FROM normalized)
  ),
  order_totals AS (
    SELECT currency, SUM(visible_total) AS total
    FROM filtered_orders
    WHERE status <> 'cancelled'
    GROUP BY currency
  ),
  outstanding_totals AS (
    SELECT
      currency,
      SUM(visible_balance_amount) AS total,
      COUNT(*) FILTER (WHERE effective_payment_status = 'unpaid') AS unpaid_count,
      COUNT(*) FILTER (WHERE effective_payment_status = 'partial') AS partial_count
    FROM filtered_orders
    WHERE status NOT IN ('draft', 'cancelled', 'returned')
      AND COALESCE(return_status, 'none') <> 'full'
      AND effective_payment_status <> 'paid'
      AND visible_balance_amount > 0
    GROUP BY currency
  ),
  orders_with_preview_agents AS (
    SELECT
      filtered_orders.*,
      COALESCE((
        SELECT array_agg(candidate.agent_id)
        FROM (
          SELECT assignment.agent_id
          FROM crm.sales_order_agent_assignments AS assignment
          LEFT JOIN crm.agents AS assignment_agent
            ON assignment_agent.id = assignment.agent_id
            AND assignment_agent.workspace_id = filtered_orders.workspace_id
          WHERE filtered_orders.order_type = 'sales'
            AND assignment.workspace_id = filtered_orders.workspace_id
            AND assignment.order_id = filtered_orders.id
            AND COALESCE(assignment.is_deleted, false) = false
            AND assignment.unassigned_at IS NULL
            AND (
              private.sales_agent_commissions_has_permission(filtered_orders.workspace_id, 'salesAgentCommissions.assignOrders')
              OR private.sales_agent_commissions_has_permission(filtered_orders.workspace_id, 'salesAgentCommissions.viewAll')
              OR (
                private.sales_agent_commissions_has_permission(filtered_orders.workspace_id, 'salesAgentCommissions.viewOwn')
                AND assignment_agent.linked_user_id = auth.uid()
              )
            )
          UNION
          SELECT creator_agent.id
          FROM crm.agents AS creator_agent
          WHERE filtered_orders.order_type = 'sales'
            AND creator_agent.workspace_id = filtered_orders.workspace_id
            AND COALESCE(creator_agent.is_deleted, false) = false
            AND creator_agent.agent_type = 'field_agent'
            AND creator_agent.status = 'active'
            AND creator_agent.linked_user_id = filtered_orders.created_by
            AND (
              filtered_orders.created_by = auth.uid()
              OR private.sales_agent_commissions_has_permission(filtered_orders.workspace_id, 'salesAgentCommissions.assignOrders')
              OR private.sales_agent_commissions_has_permission(filtered_orders.workspace_id, 'salesAgentCommissions.viewAll')
            )
        ) AS candidate
      ), ARRAY[]::uuid[]) AS preview_agent_ids
    FROM filtered_orders
  ),
  product_commission_rules AS (
    SELECT DISTINCT ON (rule.workspace_id, rule.product_id)
      rule.id,
      rule.workspace_id,
      rule.product_id,
      rule.commission_type,
      rule.rate_percent,
      rule.fixed_amount,
      rule.fixed_currency,
      rule.recipient_scope
    FROM crm.product_commission_rules AS rule
    WHERE rule.workspace_id = p_workspace_id
      AND COALESCE(rule.is_deleted, false) = false
      AND COALESCE(rule.is_active, false) = true
      AND rule.effective_from <= now()
      AND (rule.effective_to IS NULL OR rule.effective_to > now())
    ORDER BY rule.workspace_id, rule.product_id, rule.effective_from DESC
  ),
  product_commission_preview_lines AS (
    SELECT
      order_row.id AS order_id,
      order_row.currency,
      CASE
        WHEN rule.commission_type = 'fixed_amount'
          THEN round(rule.fixed_amount * conversion.factor, 3)
        ELSE GREATEST(0, COALESCE(NULLIF(COALESCE(
          item.value ->> 'convertedUnitPrice',
          item.value ->> 'converted_unit_price'
        ), '')::numeric, 0)) * rule.rate_percent / 100
      END
      * COALESCE(NULLIF(COALESCE(item.value ->> 'quantity', item.value ->> 'qty'), '')::numeric, 0)
      * recipient_count.eligible_count AS total,
      rule.commission_type = 'fixed_amount' AND conversion.factor IS NULL AS unavailable_conversion
    FROM orders_with_preview_agents AS order_row
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(order_row.visible_items, '[]'::jsonb)) AS item(value)
    JOIN product_commission_rules AS rule
      ON rule.workspace_id = order_row.workspace_id
      AND rule.product_id = CASE
        WHEN COALESCE(item.value ->> 'productId', item.value ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN COALESCE(item.value ->> 'productId', item.value ->> 'product_id')::uuid
        ELSE NULL
      END
      AND cardinality(order_row.preview_agent_ids) > 0
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN rule.recipient_scope = 'all_assigned' THEN cardinality(order_row.preview_agent_ids)::integer
        ELSE (
          SELECT COUNT(*)::integer
          FROM crm.product_commission_rule_agents AS recipient
          WHERE recipient.workspace_id = order_row.workspace_id
            AND recipient.rule_id = rule.id
            AND recipient.agent_id = ANY(order_row.preview_agent_ids)
            AND COALESCE(recipient.is_deleted, false) = false
        )
      END AS eligible_count
    ) AS recipient_count
    LEFT JOIN LATERAL (
      SELECT
        MAX(rate.rate_value) FILTER (WHERE UPPER(rate.value ->> 'pair') = 'USD/IQD') AS usd_iqd,
        MAX(rate.rate_value) FILTER (WHERE UPPER(rate.value ->> 'pair') = 'USD/EUR') AS usd_eur,
        MAX(rate.rate_value) FILTER (WHERE UPPER(rate.value ->> 'pair') = 'EUR/IQD') AS eur_iqd,
        MAX(rate.rate_value) FILTER (WHERE UPPER(rate.value ->> 'pair') = 'USD/TRY') AS usd_try,
        MAX(rate.rate_value) FILTER (WHERE UPPER(rate.value ->> 'pair') = 'TRY/IQD') AS try_iqd
      FROM (
        SELECT
          value,
          NULLIF(value ->> 'rate', '')::numeric
            / NULLIF(COALESCE(NULLIF(value ->> 'priceBasisAmount', '')::numeric,
                NULLIF(value ->> 'price_basis_amount', '')::numeric, 100), 0) AS rate_value
        FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(COALESCE(
            order_row.order_json -> 'exchangeRates',
            order_row.order_json -> 'exchange_rates',
            '[]'::jsonb
          )) = 'array' THEN COALESCE(
            order_row.order_json -> 'exchangeRates',
            order_row.order_json -> 'exchange_rates',
            '[]'::jsonb
          )
          ELSE '[]'::jsonb
        END) AS snapshot(value)
        WHERE NULLIF(value ->> 'rate', '')::numeric > 0
      ) AS rate
    ) AS rates ON true
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN LOWER(rule.fixed_currency) = LOWER(order_row.currency) THEN 1::numeric
        WHEN rule.fixed_currency = 'usd' AND order_row.currency = 'iqd' THEN rates.usd_iqd
        WHEN rule.fixed_currency = 'iqd' AND order_row.currency = 'usd' AND rates.usd_iqd > 0 THEN 1 / rates.usd_iqd
        WHEN rule.fixed_currency = 'usd' AND order_row.currency = 'eur' THEN rates.usd_eur
        WHEN rule.fixed_currency = 'eur' AND order_row.currency = 'usd' AND rates.usd_eur > 0 THEN 1 / rates.usd_eur
        WHEN rule.fixed_currency = 'eur' AND order_row.currency = 'iqd' THEN rates.eur_iqd
        WHEN rule.fixed_currency = 'iqd' AND order_row.currency = 'eur' AND rates.eur_iqd > 0 THEN 1 / rates.eur_iqd
        WHEN rule.fixed_currency = 'usd' AND order_row.currency = 'try' THEN rates.usd_try
        WHEN rule.fixed_currency = 'try' AND order_row.currency = 'usd' AND rates.usd_try > 0 THEN 1 / rates.usd_try
        WHEN rule.fixed_currency = 'try' AND order_row.currency = 'iqd' THEN rates.try_iqd
        WHEN rule.fixed_currency = 'iqd' AND order_row.currency = 'try' AND rates.try_iqd > 0 THEN 1 / rates.try_iqd
        WHEN rule.fixed_currency = 'try' AND order_row.currency = 'eur'
          AND rates.try_iqd > 0 AND rates.eur_iqd > 0 THEN rates.try_iqd / rates.eur_iqd
        WHEN rule.fixed_currency = 'eur' AND order_row.currency = 'try'
          AND rates.try_iqd > 0 AND rates.eur_iqd > 0 THEN rates.eur_iqd / rates.try_iqd
        ELSE NULL
      END AS factor
    ) AS conversion
    WHERE order_row.order_type = 'sales'
      AND recipient_count.eligible_count > 0
      AND COALESCE(NULLIF(COALESCE(item.value ->> 'quantity', item.value ->> 'qty'), '')::numeric, 0) > 0
  ),
  product_commission_preview_by_order AS (
    SELECT
      order_id,
      currency,
      SUM(total) AS total,
      BOOL_OR(unavailable_conversion) AS unavailable_conversion
    FROM product_commission_preview_lines
    GROUP BY order_id, currency
  ),
  product_commission_preview_totals AS (
    SELECT
      order_row.currency,
      SUM(COALESCE(preview.total, 0)) AS total,
      COALESCE(BOOL_OR(preview.unavailable_conversion), false) AS unavailable_conversion
    FROM filtered_orders AS order_row
    LEFT JOIN product_commission_preview_by_order AS preview
      ON preview.order_id = order_row.id
    WHERE order_row.order_type = 'sales'
    GROUP BY order_row.currency
  ),
  totals AS (
    SELECT
      COUNT(*)::integer AS total_count,
      COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending_count,
      MIN(created_at) AS min_created_at,
      MAX(created_at) AS max_created_at
    FROM filtered_orders
  )
  SELECT jsonb_build_object(
    'orders', COALESCE((
      SELECT jsonb_agg(page_orders.visible_order_json ORDER BY page_orders.created_at DESC NULLS LAST, page_orders.id DESC)
      FROM page_orders
    ), '[]'::jsonb),
    'total_count', totals.total_count,
    'page_count', GREATEST(1, CEIL(totals.total_count::numeric / (SELECT page_size FROM normalized))::integer),
    'pending_count', CASE WHEN (SELECT order_type FROM normalized) = 'sales' THEN totals.pending_count ELSE 0 END,
    'min_created_at', totals.min_created_at,
    'max_created_at', totals.max_created_at,
    'totals_by_currency', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('currency', order_totals.currency, 'total', order_totals.total) ORDER BY order_totals.currency)
      FROM order_totals
    ), '[]'::jsonb),
    'outstanding_by_currency', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'currency', outstanding_totals.currency,
        'total', outstanding_totals.total,
        'unpaid_count', outstanding_totals.unpaid_count,
        'partial_count', outstanding_totals.partial_count
      ) ORDER BY outstanding_totals.currency)
      FROM outstanding_totals
    ), '[]'::jsonb),
    'product_commission_preview_by_currency', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'currency', product_commission_preview_totals.currency,
        'total', product_commission_preview_totals.total,
        'unavailable_conversion', product_commission_preview_totals.unavailable_conversion
      ) ORDER BY product_commission_preview_totals.currency)
      FROM product_commission_preview_totals
    ), '[]'::jsonb)
  )
  FROM totals;
$function$;

REVOKE ALL ON FUNCTION crm.get_orders_list_page(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, text, text, text, text, text, boolean, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.get_orders_list_page(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, text, text, text, text, text, boolean, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
