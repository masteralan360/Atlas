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
  v_line_revenue_total numeric := 0;
  v_product_revenue numeric := 0;
  v_product_cost_total numeric := 0;
  v_product_discount numeric := 0;
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

  SELECT
    COALESCE(SUM(line_data.line_revenue), 0),
    COALESCE(SUM(CASE
      WHEN NOT COALESCE(product.is_service, false)
       AND COALESCE(item.value ->> 'storageId', item.value ->> 'storage_id') IS NOT NULL
        THEN line_data.line_revenue
      ELSE 0
    END), 0),
    COALESCE(SUM(CASE
      WHEN NOT COALESCE(product.is_service, false)
       AND COALESCE(item.value ->> 'storageId', item.value ->> 'storage_id') IS NOT NULL
        THEN line_data.line_cost
      ELSE 0
    END), 0)
    INTO v_line_revenue_total, v_product_revenue, v_product_cost_total
  FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item(value)
  LEFT JOIN public.products AS product
    ON product.id::text = COALESCE(item.value ->> 'productId', item.value ->> 'product_id')
   AND product.workspace_id = v_workspace_id
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN COALESCE(item.value ->> 'lineTotal', item.value ->> 'line_total', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN COALESCE(item.value ->> 'lineTotal', item.value ->> 'line_total')::numeric
        ELSE 0
      END AS line_revenue,
      CASE
        WHEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor', '') ~ '^[0-9]+([.][0-9]+)?$'
          AND COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric > 0
          THEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric
        ELSE 1
      END AS unit_factor,
      CASE
        WHEN COALESCE(item.value ->> 'convertedUomCostPrice', item.value ->> 'converted_uom_cost_price', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN COALESCE(item.value ->> 'convertedUomCostPrice', item.value ->> 'converted_uom_cost_price')::numeric
        WHEN COALESCE(item.value ->> 'uomCostPrice', item.value ->> 'uom_cost_price', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN CASE
            WHEN COALESCE(item.value ->> 'convertedCostPrice', item.value ->> 'converted_cost_price', '') ~ '^[0-9]+([.][0-9]+)?$'
             AND COALESCE(item.value ->> 'costPrice', item.value ->> 'cost_price', '') ~ '^[0-9]+([.][0-9]+)?$'
             AND COALESCE(item.value ->> 'costPrice', item.value ->> 'cost_price')::numeric > 0
              THEN COALESCE(item.value ->> 'uomCostPrice', item.value ->> 'uom_cost_price')::numeric
                * COALESCE(item.value ->> 'convertedCostPrice', item.value ->> 'converted_cost_price')::numeric
                / COALESCE(item.value ->> 'costPrice', item.value ->> 'cost_price')::numeric
            ELSE COALESCE(item.value ->> 'uomCostPrice', item.value ->> 'uom_cost_price')::numeric
          END
        WHEN COALESCE(item.value ->> 'convertedCostPrice', item.value ->> 'converted_cost_price', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN COALESCE(item.value ->> 'convertedCostPrice', item.value ->> 'converted_cost_price')::numeric
            * CASE
              WHEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor', '') ~ '^[0-9]+([.][0-9]+)?$'
                AND COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric > 0
                THEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric
              ELSE 1
            END
        WHEN COALESCE(item.value ->> 'costPrice', item.value ->> 'cost_price', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN COALESCE(item.value ->> 'costPrice', item.value ->> 'cost_price')::numeric
            * CASE
              WHEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor', '') ~ '^[0-9]+([.][0-9]+)?$'
                AND COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric > 0
                THEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric
              ELSE 1
            END
        ELSE 0
      END AS selected_unit_cost,
      CASE
        WHEN COALESCE(item.value ->> 'inventoryQuantity', item.value ->> 'inventory_quantity', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN COALESCE(item.value ->> 'inventoryQuantity', item.value ->> 'inventory_quantity')::numeric
        WHEN COALESCE(item.value ->> 'quantity', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN COALESCE(item.value ->> 'quantity', '')::numeric
            * CASE
              WHEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor', '') ~ '^[0-9]+([.][0-9]+)?$'
                AND COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric > 0
                THEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric
              ELSE 1
            END
        ELSE 0
      END AS paid_inventory_quantity,
      CASE
        WHEN COALESCE(item.value ->> 'freeBonusInventoryQuantity', item.value ->> 'free_bonus_inventory_quantity', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN COALESCE(item.value ->> 'freeBonusInventoryQuantity', item.value ->> 'free_bonus_inventory_quantity')::numeric
        WHEN COALESCE(item.value ->> 'freeBonusQuantity', item.value ->> 'free_bonus_quantity', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN COALESCE(item.value ->> 'freeBonusQuantity', item.value ->> 'free_bonus_quantity')::numeric
            * CASE
              WHEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor', '') ~ '^[0-9]+([.][0-9]+)?$'
                AND COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric > 0
                THEN COALESCE(item.value ->> 'unitFactor', item.value ->> 'unit_factor')::numeric
              ELSE 1
            END
        ELSE 0
      END AS free_inventory_quantity
  ) AS parsed
  CROSS JOIN LATERAL (
    SELECT
      parsed.line_revenue,
      parsed.selected_unit_cost / parsed.unit_factor
        * (parsed.paid_inventory_quantity + parsed.free_inventory_quantity) AS line_cost
  ) AS line_data;

  v_product_discount := CASE
    WHEN v_line_revenue_total > 0
      THEN COALESCE(v_order.discount, 0) * (v_product_revenue / v_line_revenue_total)
    ELSE 0
  END;
  v_total := COALESCE(v_order.total, 0);
  v_gross_profit := v_product_revenue - v_product_discount - v_product_cost_total;
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
