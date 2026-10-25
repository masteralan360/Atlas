CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_created_id
  ON public.marketplace_orders (workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_status_created_id
  ON public.marketplace_orders (workspace_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_number_id
  ON public.marketplace_orders (workspace_id, order_number, id);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_customer_id
  ON public.marketplace_orders (workspace_id, customer_name, id);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_total_id
  ON public.marketplace_orders (workspace_id, total, id);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_order_number_trgm
  ON public.marketplace_orders USING gin (order_number extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_customer_name_trgm
  ON public.marketplace_orders USING gin (customer_name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_customer_phone_trgm
  ON public.marketplace_orders USING gin (customer_phone extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_customer_city_trgm
  ON public.marketplace_orders USING gin (customer_city extensions.gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.get_marketplace_order_summary(
  p_workspace_id uuid,
  p_created_from timestamptz DEFAULT NULL,
  p_created_before timestamptz DEFAULT NULL,
  p_previous_from timestamptz DEFAULT NULL,
  p_previous_before timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  WITH selected_orders AS (
    SELECT status, total, currency, created_at
    FROM public.marketplace_orders
    WHERE workspace_id = p_workspace_id
      AND (p_created_from IS NULL OR created_at >= p_created_from)
      AND (p_created_before IS NULL OR created_at < p_created_before)
  ),
  currency_totals AS (
    SELECT currency, SUM(total) AS total
    FROM selected_orders
    WHERE status <> 'cancelled'
    GROUP BY currency
  )
  SELECT jsonb_build_object(
    'totalCount', COUNT(*),
    'pendingCount', COUNT(*) FILTER (WHERE status = 'pending'),
    'pendingFulfillmentCount', COUNT(*) FILTER (WHERE status IN ('pending', 'confirmed', 'processing')),
    'deliveredCount', COUNT(*) FILTER (WHERE status = 'delivered'),
    'cancelledCount', COUNT(*) FILTER (WHERE status = 'cancelled'),
    'orderValueByCurrency', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('currency', currency, 'total', total) ORDER BY currency)
       FROM currency_totals),
      '[]'::jsonb
    ),
    'previousCount', CASE
      WHEN p_previous_from IS NULL OR p_previous_before IS NULL THEN NULL
      ELSE (
        SELECT COUNT(*)
        FROM public.marketplace_orders
        WHERE workspace_id = p_workspace_id
          AND created_at >= p_previous_from
          AND created_at < p_previous_before
      )
    END,
    'minCreatedAt', MIN(created_at),
    'maxCreatedAt', MAX(created_at)
  )
  FROM selected_orders;
$function$;

REVOKE ALL ON FUNCTION public.get_marketplace_order_summary(uuid, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_marketplace_order_summary(uuid, timestamptz, timestamptz, timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_marketplace_order_summary(uuid, timestamptz, timestamptz, timestamptz, timestamptz) TO authenticated;
