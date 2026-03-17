CREATE OR REPLACE FUNCTION public.get_top_products(p_workspace_id uuid DEFAULT NULL::uuid, p_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 10)
 RETURNS TABLE(product_id uuid, product_name text, product_sku text, total_quantity_sold bigint, total_revenue numeric, total_sales_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF p_workspace_id IS NULL THEN
        SELECT workspace_id INTO p_workspace_id FROM public.profiles WHERE id = auth.uid();
    END IF;

    RETURN QUERY
    SELECT 
        pr.id as product_id,
        pr.name as product_name,
        pr.sku as product_sku,
        SUM(si.quantity - si.returned_quantity) as total_quantity_sold,
        COALESCE(SUM((si.quantity - si.returned_quantity) * COALESCE(si.converted_unit_price, si.unit_price)), 0) as total_revenue,
        COUNT(DISTINCT si.sale_id) as total_sales_count
    FROM public.sale_items si
    INNER JOIN public.sales s ON si.sale_id = s.id
    INNER JOIN public.products pr ON si.product_id = pr.id
    WHERE s.workspace_id = p_workspace_id
      AND COALESCE(s.is_returned, FALSE) = FALSE
      AND (p_start_date IS NULL OR s.created_at >= p_start_date)
      AND (p_end_date IS NULL OR s.created_at <= p_end_date)
    GROUP BY pr.id, pr.name, pr.sku
    ORDER BY total_quantity_sold DESC
    LIMIT p_limit;
END;
$function$
