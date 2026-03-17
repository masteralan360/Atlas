CREATE OR REPLACE FUNCTION public.get_sales_summary(p_workspace_id uuid DEFAULT NULL::uuid, p_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    result JSONB;
BEGIN
    IF p_workspace_id IS NULL THEN
        SELECT workspace_id INTO p_workspace_id FROM public.profiles WHERE id = auth.uid();
    END IF;

    SELECT jsonb_build_object(
        'totalRevenue', COALESCE(SUM(CASE WHEN COALESCE(s.is_returned, FALSE) = FALSE THEN (si.quantity - si.returned_quantity) * COALESCE(si.converted_unit_price, si.unit_price) ELSE 0 END), 0),
        'totalCost', COALESCE(SUM(CASE WHEN COALESCE(s.is_returned, FALSE) = FALSE THEN (si.quantity - si.returned_quantity) * si.cost_price ELSE 0 END), 0),
        'netProfit', COALESCE(SUM(CASE WHEN COALESCE(s.is_returned, FALSE) = FALSE THEN ((si.quantity - si.returned_quantity) * COALESCE(si.converted_unit_price, si.unit_price)) - ((si.quantity - si.returned_quantity) * si.cost_price) ELSE 0 END), 0),
        'totalSales', COUNT(DISTINCT CASE WHEN COALESCE(s.is_returned, FALSE) = FALSE THEN s.id END),
        'totalItems', SUM(CASE WHEN COALESCE(s.is_returned, FALSE) = FALSE THEN si.quantity - si.returned_quantity ELSE 0 END),
        'averageSaleValue', COALESCE(AVG(CASE WHEN COALESCE(s.is_returned, FALSE) = FALSE THEN s.total_amount END), 0),
        'returnedSales', COUNT(DISTINCT CASE WHEN s.is_returned = TRUE THEN s.id END),
        'returnedItems', SUM(si.returned_quantity)
    ) INTO result
    FROM public.sales s
    INNER JOIN public.sale_items si ON s.id = si.sale_id
    WHERE s.workspace_id = p_workspace_id
      AND (p_start_date IS NULL OR s.created_at >= p_start_date)
      AND (p_end_date IS NULL OR s.created_at <= p_end_date);

    RETURN result;
END;
$function$
