CREATE OR REPLACE FUNCTION public.queue_marketplace_pending_order_notifications(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_due_date date;
  v_item_count integer := 0;
BEGIN
  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE id = p_order_id
    AND status = 'pending'
    AND COALESCE(is_deleted, false) = false;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_due_date := timezone('utc', v_order.created_at)::date;

  SELECT COALESCE(SUM(GREATEST(COALESCE((item.value ->> 'quantity')::integer, 1), 1)), 0)
  INTO v_item_count
  FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item(value);

  PERFORM public.upsert_notification_event(
    v_order.workspace_id,
    p.id,
    'marketplace_order_pending',
    v_order.id::text,
    v_due_date,
    jsonb_build_object(
      'entity_type', 'marketplace_order_pending',
      'title', format('Pending marketplace order %s', v_order.order_number),
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'customer_name', v_order.customer_name,
      'customer_phone', v_order.customer_phone,
      'customer_city', v_order.customer_city,
      'amount', v_order.total,
      'currency', COALESCE(NULLIF(v_order.currency, ''), 'iqd'),
      'created_at', v_order.created_at,
      'due_date', v_due_date,
      'item_count', v_item_count
    )
  )
  FROM public.profiles p
  WHERE p.workspace_id = v_order.workspace_id
    AND LOWER(BTRIM(COALESCE(p.role, ''))) IN ('admin', 'staff');
END;
$function$;
