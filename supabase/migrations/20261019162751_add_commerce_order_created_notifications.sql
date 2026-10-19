ALTER TABLE notifications.workspace_disabled_types
  DROP CONSTRAINT IF EXISTS notifications_workspace_disabled_types_type_check;

ALTER TABLE notifications.workspace_disabled_types
  ADD CONSTRAINT notifications_workspace_disabled_types_type_check CHECK (notification_type IN (
    'marketplace_order_pending', 'commerce_order_created',
    'order_approval_request', 'order_approval_approved',
    'loan_installment_overdue', 'expense_item_overdue', 'payroll_overdue', 'inventory_low_stock',
    'garden_job_assigned', 'garden_job_rescheduled', 'garden_job_completed'
  ));

CREATE OR REPLACE FUNCTION public.set_workspace_notification_type_disabled(
  p_notification_type text,
  p_disabled boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_notification_type text := NULLIF(BTRIM(COALESCE(p_notification_type, '')), '');
BEGIN
  IF v_workspace_id IS NULL OR public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'notification_settings_admin_required' USING ERRCODE = '42501';
  END IF;
  IF v_notification_type NOT IN (
    'marketplace_order_pending', 'commerce_order_created',
    'order_approval_request', 'order_approval_approved',
    'loan_installment_overdue', 'expense_item_overdue', 'payroll_overdue', 'inventory_low_stock',
    'garden_job_assigned', 'garden_job_rescheduled', 'garden_job_completed'
  ) THEN
    RAISE EXCEPTION 'unsupported_notification_type' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_disabled, true) THEN
    INSERT INTO notifications.workspace_disabled_types (workspace_id, notification_type, disabled_by)
    VALUES (v_workspace_id, v_notification_type, auth.uid())
    ON CONFLICT (workspace_id, notification_type) DO UPDATE
      SET disabled_by = EXCLUDED.disabled_by, updated_at = now();
  ELSE
    DELETE FROM notifications.workspace_disabled_types
    WHERE workspace_id = v_workspace_id AND notification_type = v_notification_type;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.queue_commerce_order_created_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, crm, notifications
AS $function$
DECLARE
  v_workspace_id uuid;
  v_order_id uuid;
  v_record_payload jsonb;
  v_order crm.sales_orders%ROWTYPE;
  v_user record;
  v_cost_total numeric := 0;
  v_gross_profit numeric := 0;
  v_total numeric := 0;
  v_currency text;
  v_order_sequence text;
  v_buyer_name text;
  v_order_date date;
BEGIN
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'commerce_operations_records' THEN
    IF NEW.record_type IS DISTINCT FROM 'order_details'
      OR COALESCE(NEW.is_deleted, false)
      OR NEW.related_order_id IS NULL THEN
      RETURN NEW;
    END IF;
    v_workspace_id := NEW.workspace_id;
    v_order_id := NEW.related_order_id;
    v_record_payload := COALESCE(NEW.payload, '{}'::jsonb);
  ELSIF TG_TABLE_SCHEMA = 'crm' AND TG_TABLE_NAME = 'sales_orders' THEN
    v_workspace_id := NEW.workspace_id;
    v_order_id := NEW.id;
    SELECT COALESCE(record.payload, '{}'::jsonb)
      INTO v_record_payload
    FROM public.commerce_operations_records AS record
    WHERE record.workspace_id = v_workspace_id
      AND record.related_order_id = v_order_id
      AND record.record_type = 'order_details'
      AND COALESCE(record.is_deleted, false) = false
      AND COALESCE(record.payload ->> 'channel', '') IN ('social', 'wholesale')
    ORDER BY record.created_at ASC, record.id ASC
    LIMIT 1;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF COALESCE(v_record_payload ->> 'channel', '') NOT IN ('social', 'wholesale') THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_order
  FROM crm.sales_orders AS order_row
  WHERE order_row.id = v_order_id
    AND order_row.workspace_id = v_workspace_id
    AND COALESCE(order_row.is_deleted, false) = false;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN COALESCE(item.value ->> 'costPrice', item.value ->> 'cost_price', item.value ->> 'convertedCostPrice', item.value ->> 'converted_cost_price', '') ~ '^-?[0-9]+([.][0-9]+)?$'
       AND COALESCE(item.value ->> 'quantity', '') ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN COALESCE(item.value ->> 'costPrice', item.value ->> 'cost_price', item.value ->> 'convertedCostPrice', item.value ->> 'converted_cost_price')::numeric
          * COALESCE(item.value ->> 'quantity', '')::numeric
      ELSE 0
    END
  ), 0)
    INTO v_cost_total
  FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item(value);

  v_total := COALESCE(v_order.total, 0);
  v_gross_profit := v_total - v_cost_total;
  v_currency := UPPER(COALESCE(NULLIF(BTRIM(v_order.currency), ''), 'IQD'));
  v_order_sequence := COALESCE(NULLIF(BTRIM(v_order.order_number), ''), v_order.id::text);
  v_buyer_name := NULLIF(BTRIM(COALESCE(v_order.customer_name, '')), '');
  IF v_buyer_name IS NULL THEN
    v_buyer_name := NULLIF(BTRIM(COALESCE(v_record_payload ->> 'buyerName', v_record_payload ->> 'buyer_name', '')), '');
  END IF;
  v_buyer_name := COALESCE(regexp_replace(v_buyer_name, '[[:space:]]+', ' ', 'g'), '');
  v_order_date := timezone('utc', COALESCE(v_order.created_at, now()))::date;

  FOR v_user IN
    SELECT profile.id
    FROM public.profiles AS profile
    WHERE profile.workspace_id = v_workspace_id
      AND LOWER(BTRIM(COALESCE(profile.role, ''))) IN ('admin', 'staff')
  LOOP
    PERFORM public.upsert_notification_event(
      v_workspace_id,
      v_user.id,
      'commerce_order_created',
      v_order.id::text,
      v_order_date,
      jsonb_build_object(
        'title', 'New commerce order',
        'body', format(
          '%s | %s | Total: %s %s | Gross profit: %s %s',
          v_order_sequence,
          v_buyer_name,
          trim(to_char(v_total, 'FM999999999999999990.##')),
          v_currency,
          trim(to_char(v_gross_profit, 'FM999999999999999990.##')),
          v_currency
        ),
        'route', '/orders/' || v_order.id::text,
        'action_label', 'Open order',
        'scope', 'workspace',
        'priority', 'normal',
        'order_id', v_order.id,
        'order_sequence', v_order_sequence,
        'buyer_name', v_buyer_name,
        'total', v_total,
        'gross_profit', v_gross_profit,
        'currency', v_currency,
        'channel', v_record_payload ->> 'channel'
      )
    );
  END LOOP;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.queue_commerce_order_created_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS queue_commerce_order_created_from_intake ON public.commerce_operations_records;
CREATE TRIGGER queue_commerce_order_created_from_intake
  AFTER INSERT ON public.commerce_operations_records
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_commerce_order_created_notification();

DROP TRIGGER IF EXISTS queue_commerce_order_created_from_sales_order ON crm.sales_orders;
CREATE TRIGGER queue_commerce_order_created_from_sales_order
  AFTER INSERT ON crm.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_commerce_order_created_notification();
