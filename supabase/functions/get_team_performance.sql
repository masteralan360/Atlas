CREATE OR REPLACE FUNCTION public.get_team_performance(p_workspace_id uuid DEFAULT NULL::uuid, p_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(cashier_id uuid, cashier_name text, total_sales_count bigint, total_revenue numeric, total_items_count bigint, average_sale_value numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF p_workspace_id IS NULL THEN
        SELECT workspace_id INTO p_workspace_id FROM public.profiles WHERE id = auth.uid();
    END IF;

    RETURN QUERY
    SELECT 
        s.cashier_id,
        COALESCE(p.name, 'Unknown') as cashier_name,
        COUNT(DISTINCT s.id) as total_sales_count,
        COALESCE(SUM((si.quantity - si.returned_quantity) * COALESCE(si.converted_unit_price, si.unit_price)), 0) as total_revenue,
        SUM(si.quantity - si.returned_quantity) as total_items_count,
        COALESCE(AVG(s.total_amount), 0) as average_sale_value
    FROM public.sales s
    INNER JOIN public.sale_items si ON s.id = si.sale_id
    LEFT JOIN public.profiles p ON s.cashier_id = p.id
    WHERE s.workspace_id = p_workspace_id
      AND COALESCE(s.is_returned, FALSE) = FALSE
      AND (p_start_date IS NULL OR s.created_at >= p_start_date)
      AND (p_end_date IS NULL OR s.created_at <= p_end_date)
    GROUP BY s.cashier_id, p.name
    ORDER BY total_revenue DESC;
END;
$function$
