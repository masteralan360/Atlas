CREATE OR REPLACE FUNCTION public.get_net_revenue(p_workspace_id uuid DEFAULT NULL::uuid, p_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(total_revenue numeric, total_cost numeric, net_profit numeric, total_sales_count bigint, total_items_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF p_workspace_id IS NULL THEN
        SELECT workspace_id INTO p_workspace_id FROM public.profiles WHERE id = auth.uid();
    END IF;

    RETURN QUERY
    SELECT 
        COALESCE(SUM((si.quantity - si.returned_quantity) * COALESCE(si.converted_unit_price, si.unit_price)), 0) as total_revenue,
        COALESCE(SUM((si.quantity - si.returned_quantity) * si.cost_price), 0) as total_cost,
        COALESCE(SUM(((si.quantity - si.returned_quantity) * COALESCE(si.converted_unit_price, si.unit_price)) - ((si.quantity - si.returned_quantity) * si.cost_price)), 0) as net_profit,
        COUNT(DISTINCT s.id) as total_sales_count,
        SUM(si.quantity - si.returned_quantity) as total_items_count
    FROM public.sales s
    INNER JOIN public.sale_items si ON s.id = si.sale_id
    WHERE s.workspace_id = p_workspace_id
      AND COALESCE(s.is_returned, FALSE) = FALSE
      AND (p_start_date IS NULL OR s.created_at >= p_start_date)
      AND (p_end_date IS NULL OR s.created_at <= p_end_date);
END;
$function$
