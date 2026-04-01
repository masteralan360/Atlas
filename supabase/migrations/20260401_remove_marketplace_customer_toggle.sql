CREATE OR REPLACE FUNCTION public.normalize_marketplace_workspace_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.visibility := COALESCE(NULLIF(lower(trim(COALESCE(NEW.visibility, 'private'))), ''), 'private');
  NEW.store_slug := NULLIF(lower(trim(COALESCE(NEW.store_slug, ''))), '');
  NEW.store_description := NULLIF(trim(COALESCE(NEW.store_description, '')), '');
  NEW.ecommerce := COALESCE(NEW.ecommerce, false);

  IF NEW.visibility NOT IN ('private', 'public') THEN
    RAISE EXCEPTION 'Workspace visibility must be private or public';
  END IF;

  IF NEW.visibility = 'public' AND NEW.deleted_at IS NULL THEN
    IF COALESCE(NEW.data_mode, 'cloud') = 'local' THEN
      RAISE EXCEPTION 'Local workspaces cannot be published to the marketplace';
    END IF;

    IF NEW.store_slug IS NULL THEN
      RAISE EXCEPTION 'A store slug is required before a workspace can be published';
    END IF;

    NEW.ecommerce := true;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS ecommerce_auto_create_customers;

CREATE OR REPLACE FUNCTION public.transition_marketplace_order(order_id uuid, next_status text, cancel_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, crm
AS $function$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_workspace public.workspaces%ROWTYPE;
  v_next_status text := lower(trim(COALESCE(next_status, '')));
  v_cancel_reason text := NULLIF(trim(COALESCE(cancel_reason, '')), '');
  v_item jsonb;
  v_line_item jsonb;
  v_product_id uuid;
  v_requested_qty integer;
  v_declared_storage_id uuid;
  v_resolved_storage_id uuid;
  v_inventory_quantity integer;
  v_warning_messages text[] := ARRAY[]::text[];
  v_missing_storage_count integer := 0;
  v_inventory_completed boolean := false;
  v_business_partner_id uuid;
  v_customer_id uuid;
  v_sales_order_id uuid;
  v_sales_order_number text;
  v_phone_norm text;
  v_email_norm text;
  v_existing_customer_id uuid;
  v_existing_partner_is_ecommerce boolean := false;
  v_delivery_timestamp timestamp with time zone := timezone('utc', now());
  v_shipping_address text;
  v_order_notes text;
  v_sales_order_items jsonb := '[]'::jsonb;
  v_product_name text;
  v_product_sku text;
  v_product_cost_price numeric;
  v_product_storage_id uuid;
  v_item_storage_id uuid;
  v_item_currency text;
  v_item_name text;
  v_item_sku text;
  v_item_unit_price numeric;
  v_item_line_total numeric;
  v_common_storage_id uuid;
  v_common_storage_initialized boolean := false;
  v_has_storage_conflict boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF public.current_workspace_id() IS NULL THEN
    RAISE EXCEPTION 'Workspace context is missing';
  END IF;

  IF public.current_user_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Only admins and staff can manage marketplace orders';
  END IF;

  IF v_next_status NOT IN ('confirmed', 'processing', 'shipped', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Unsupported marketplace order status';
  END IF;

  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE id = order_id
    AND workspace_id = public.current_workspace_id()
    AND COALESCE(is_deleted, false) = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Marketplace order not found';
  END IF;

  SELECT *
  INTO v_workspace
  FROM public.workspaces
  WHERE id = v_order.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace not found for marketplace order';
  END IF;

  IF v_order.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'This marketplace order is already finalized';
  END IF;

  CASE v_order.status
    WHEN 'pending' THEN
      IF v_next_status NOT IN ('confirmed', 'cancelled') THEN
        RAISE EXCEPTION 'Pending orders can only move to confirmed or cancelled';
      END IF;
    WHEN 'confirmed' THEN
      IF v_next_status NOT IN ('processing', 'cancelled') THEN
        RAISE EXCEPTION 'Confirmed orders can only move to processing or cancelled';
      END IF;
    WHEN 'processing' THEN
      IF v_next_status NOT IN ('shipped', 'cancelled') THEN
        RAISE EXCEPTION 'Processing orders can only move to shipped or cancelled';
      END IF;
    WHEN 'shipped' THEN
      IF v_next_status <> 'delivered' THEN
        RAISE EXCEPTION 'Shipped orders can only move to delivered';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported current marketplace order status';
  END CASE;

  IF v_next_status = 'confirmed' THEN
    UPDATE public.marketplace_orders
    SET
      status = 'confirmed',
      confirmed_at = COALESCE(confirmed_at, timezone('utc', now())),
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'confirmed',
      'inventory_deducted', v_order.inventory_deducted,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

  IF v_next_status = 'processing' THEN
    UPDATE public.marketplace_orders
    SET
      status = 'processing',
      processing_at = COALESCE(processing_at, timezone('utc', now())),
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'processing',
      'inventory_deducted', v_order.inventory_deducted,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

  IF v_next_status = 'shipped' THEN
    UPDATE public.marketplace_orders
    SET
      status = 'shipped',
      shipped_at = COALESCE(shipped_at, timezone('utc', now())),
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'shipped',
      'inventory_deducted', v_order.inventory_deducted,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

  IF v_next_status = 'cancelled' THEN
    UPDATE public.marketplace_orders
    SET
      status = 'cancelled',
      cancelled_at = COALESCE(cancelled_at, timezone('utc', now())),
      cancel_reason = v_cancel_reason,
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'cancelled',
      'inventory_deducted', v_order.inventory_deducted,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

  IF NOT COALESCE(v_order.inventory_deducted, false) THEN
    FOR v_item IN
      SELECT *
      FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb))
    LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_requested_qty := COALESCE((v_item->>'quantity')::integer, 0);
      v_declared_storage_id := NULLIF(v_item->>'storage_id', '')::uuid;

      IF v_product_id IS NULL OR v_requested_qty <= 0 THEN
        CONTINUE;
      END IF;

      v_resolved_storage_id := v_declared_storage_id;

      IF v_resolved_storage_id IS NULL THEN
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(storage_id::text)::uuid ELSE NULL END
        INTO v_resolved_storage_id
        FROM public.inventory
        WHERE workspace_id = v_order.workspace_id
          AND product_id = v_product_id
          AND COALESCE(is_deleted, false) = false;
      END IF;

      IF v_resolved_storage_id IS NULL THEN
        SELECT storage_id
        INTO v_resolved_storage_id
        FROM public.products
        WHERE id = v_product_id
          AND workspace_id = v_order.workspace_id
          AND COALESCE(is_deleted, false) = false;
      END IF;

      IF v_resolved_storage_id IS NULL THEN
        v_missing_storage_count := v_missing_storage_count + 1;
        v_warning_messages := array_append(
          v_warning_messages,
          format('No storage could be resolved for %s', COALESCE(NULLIF(v_item->>'name', ''), v_product_id::text))
        );
        CONTINUE;
      END IF;

      SELECT quantity
      INTO v_inventory_quantity
      FROM public.inventory
      WHERE workspace_id = v_order.workspace_id
        AND product_id = v_product_id
        AND storage_id = v_resolved_storage_id
      LIMIT 1
      FOR UPDATE;

      IF COALESCE(v_inventory_quantity, 0) < v_requested_qty THEN
        v_warning_messages := array_append(
          v_warning_messages,
          format('Inventory for %s will go negative after delivery', COALESCE(NULLIF(v_item->>'name', ''), v_product_id::text))
        );
      END IF;

      INSERT INTO public.inventory (
        id,
        workspace_id,
        product_id,
        storage_id,
        quantity,
        created_at,
        updated_at,
        version,
        is_deleted
      )
      VALUES (
        gen_random_uuid(),
        v_order.workspace_id,
        v_product_id,
        v_resolved_storage_id,
        0 - v_requested_qty,
        timezone('utc', now()),
        timezone('utc', now()),
        1,
        false
      )
      ON CONFLICT (workspace_id, product_id, storage_id)
      DO UPDATE SET
        quantity = COALESCE(public.inventory.quantity, 0) + EXCLUDED.quantity,
        updated_at = timezone('utc', now()),
        version = COALESCE(public.inventory.version, 0) + 1,
        is_deleted = false;
    END LOOP;

    v_inventory_completed := v_missing_storage_count = 0;
  ELSE
    v_inventory_completed := true;
  END IF;

  IF v_missing_storage_count > 0 THEN
    v_warning_messages := array_append(
      v_warning_messages,
      'Inventory was not fully deducted because some items were missing a resolved storage.'
    );
  END IF;

  v_business_partner_id := v_order.business_partner_id;
  v_customer_id := v_order.customer_id;
  v_sales_order_id := v_order.sales_order_id;

  IF v_sales_order_id IS NULL THEN
    v_phone_norm := NULLIF(regexp_replace(COALESCE(v_order.customer_phone, ''), '\D', '', 'g'), '');
    v_email_norm := NULLIF(lower(trim(COALESCE(v_order.customer_email, ''))), '');

    SELECT
      bp.id,
      COALESCE(bp.customer_facet_id, c.id),
      COALESCE(bp.is_ecommerce, false)
    INTO
      v_business_partner_id,
      v_existing_customer_id,
      v_existing_partner_is_ecommerce
    FROM crm.business_partners bp
    LEFT JOIN crm.customers c
      ON c.business_partner_id = bp.id
     AND c.workspace_id = bp.workspace_id
     AND COALESCE(c.is_deleted, false) = false
    WHERE bp.workspace_id = v_order.workspace_id
      AND COALESCE(bp.is_deleted, false) = false
      AND bp.merged_into_business_partner_id IS NULL
      AND bp.role IN ('customer', 'both')
      AND (
        (v_phone_norm IS NOT NULL AND regexp_replace(COALESCE(bp.phone, ''), '\D', '', 'g') = v_phone_norm)
        OR (v_email_norm IS NOT NULL AND lower(trim(COALESCE(bp.email, ''))) = v_email_norm)
      )
    ORDER BY
      CASE
        WHEN v_phone_norm IS NOT NULL AND regexp_replace(COALESCE(bp.phone, ''), '\D', '', 'g') = v_phone_norm THEN 0
        ELSE 1
      END,
      CASE
        WHEN v_email_norm IS NOT NULL AND lower(trim(COALESCE(bp.email, ''))) = v_email_norm THEN 0
        ELSE 1
      END,
      bp.updated_at DESC NULLS LAST
    LIMIT 1;

    IF v_business_partner_id IS NULL THEN
      INSERT INTO crm.business_partners (
        workspace_id,
        name,
        contact_name,
        email,
        phone,
        address,
        city,
        country,
        notes,
        default_currency,
        role,
        credit_limit,
        customer_facet_id,
        supplier_facet_id,
        total_sales_orders,
        total_sales_value,
        receivable_balance,
        total_purchase_orders,
        total_purchase_value,
        payable_balance,
        total_loan_count,
        loan_outstanding_balance,
        net_exposure,
        merged_into_business_partner_id,
        is_ecommerce,
        created_at,
        updated_at,
        sync_status,
        version,
        is_deleted
      )
      VALUES (
        v_order.workspace_id,
        v_order.customer_name,
        NULL,
        v_order.customer_email,
        v_order.customer_phone,
        v_order.customer_address,
        v_order.customer_city,
        NULL,
        format('Created automatically from marketplace order %s', v_order.order_number),
        lower(COALESCE(v_order.currency, v_workspace.default_currency::text, 'usd')),
        'customer',
        0,
        NULL,
        NULL,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        NULL,
        true,
        v_order.created_at,
        v_delivery_timestamp,
        'synced',
        1,
        false
      )
      RETURNING id
      INTO v_business_partner_id;

      v_existing_partner_is_ecommerce := true;
    END IF;

    IF COALESCE(v_existing_customer_id, v_customer_id) IS NULL THEN
      INSERT INTO crm.customers (
        workspace_id,
        business_partner_id,
        name,
        email,
        phone,
        address,
        city,
        country,
        notes,
        default_currency,
        total_orders,
        total_spent,
        outstanding_balance,
        created_at,
        updated_at,
        sync_status,
        version,
        is_deleted,
        credit_limit,
        is_ecommerce
      )
      VALUES (
        v_order.workspace_id,
        v_business_partner_id,
        v_order.customer_name,
        v_order.customer_email,
        v_order.customer_phone,
        v_order.customer_address,
        v_order.customer_city,
        NULL,
        format('Created automatically from marketplace order %s', v_order.order_number),
        lower(COALESCE(v_order.currency, v_workspace.default_currency::text, 'usd')),
        0,
        0,
        0,
        v_order.created_at,
        v_delivery_timestamp,
        'synced',
        1,
        false,
        0,
        COALESCE(v_existing_partner_is_ecommerce, false)
      )
      RETURNING id
      INTO v_customer_id;

      UPDATE crm.business_partners
      SET
        customer_facet_id = v_customer_id,
        updated_at = v_delivery_timestamp,
        version = COALESCE(version, 0) + 1
      WHERE id = v_business_partner_id;
    ELSE
      v_customer_id := COALESCE(v_existing_customer_id, v_customer_id);
    END IF;

    FOR v_item IN
      SELECT *
      FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb))
    LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_requested_qty := COALESCE((v_item->>'quantity')::integer, 0);

      IF v_requested_qty <= 0 THEN
        CONTINUE;
      END IF;

      v_product_name := NULL;
      v_product_sku := NULL;
      v_product_cost_price := NULL;
      v_product_storage_id := NULL;

      IF v_product_id IS NOT NULL THEN
        SELECT
          name,
          sku,
          cost_price,
          storage_id
        INTO
          v_product_name,
          v_product_sku,
          v_product_cost_price,
          v_product_storage_id
        FROM public.products
        WHERE id = v_product_id
          AND workspace_id = v_order.workspace_id
          AND COALESCE(is_deleted, false) = false
        LIMIT 1;
      END IF;

      v_item_currency := lower(COALESCE(NULLIF(v_item->>'currency', ''), v_order.currency, v_workspace.default_currency::text, 'usd'));
      v_item_name := COALESCE(v_product_name, NULLIF(v_item->>'name', ''), 'Unknown Product');
      v_item_sku := COALESCE(v_product_sku, NULLIF(v_item->>'sku', ''), '');
      v_item_unit_price := COALESCE((v_item->>'unit_price')::numeric, 0);
      v_item_line_total := COALESCE((v_item->>'line_total')::numeric, v_item_unit_price * v_requested_qty);
      v_item_storage_id := COALESCE(NULLIF(v_item->>'storage_id', '')::uuid, v_product_storage_id);

      IF v_item_storage_id IS NOT NULL THEN
        IF NOT v_common_storage_initialized THEN
          v_common_storage_id := v_item_storage_id;
          v_common_storage_initialized := true;
        ELSIF v_common_storage_id IS DISTINCT FROM v_item_storage_id THEN
          v_has_storage_conflict := true;
        END IF;
      ELSE
        v_has_storage_conflict := true;
      END IF;

      v_line_item := jsonb_build_object(
        'id', gen_random_uuid()::text,
        'productId', COALESCE(v_product_id::text, v_item->>'product_id', gen_random_uuid()::text),
        'storageId', v_item_storage_id,
        'productName', v_item_name,
        'productSku', v_item_sku,
        'quantity', v_requested_qty,
        'lineTotal', v_item_line_total,
        'originalCurrency', v_item_currency,
        'originalUnitPrice', v_item_unit_price,
        'convertedUnitPrice', v_item_unit_price,
        'settlementCurrency', lower(COALESCE(v_order.currency, v_workspace.default_currency::text, 'usd')),
        'costPrice', COALESCE(v_product_cost_price, 0),
        'convertedCostPrice', COALESCE(v_product_cost_price, 0),
        'reservedQuantity', v_requested_qty,
        'fulfilledQuantity', v_requested_qty
      );

      v_sales_order_items := v_sales_order_items || jsonb_build_array(v_line_item);
    END LOOP;

    IF v_has_storage_conflict THEN
      v_common_storage_id := NULL;
    END IF;

    v_shipping_address := NULLIF(
      trim(concat_ws(', ',
        NULLIF(trim(COALESCE(v_order.customer_address, '')), ''),
        NULLIF(trim(COALESCE(v_order.customer_city, '')), '')
      )),
      ''
    );

    v_order_notes := format('Marketplace order %s', v_order.order_number);
    IF v_order.customer_notes IS NOT NULL THEN
      v_order_notes := format('%s%sCustomer note: %s', v_order_notes, E'\n\n', v_order.customer_notes);
    END IF;

    INSERT INTO crm.sales_orders (
      order_number,
      workspace_id,
      business_partner_id,
      customer_id,
      customer_name,
      subtotal,
      discount,
      tax,
      total,
      currency,
      exchange_rate,
      exchange_rate_source,
      exchange_rate_timestamp,
      exchange_rates,
      status,
      expected_delivery_date,
      actual_delivery_date,
      is_paid,
      paid_at,
      payment_method,
      reserved_at,
      source_storage_id,
      shipping_address,
      notes,
      items,
      is_locked,
      source_channel,
      marketplace_order_id,
      created_at,
      updated_at,
      sync_status,
      version,
      is_deleted
    )
    VALUES (
      '',
      v_order.workspace_id,
      v_business_partner_id,
      v_customer_id,
      v_order.customer_name,
      COALESCE(v_order.subtotal, 0),
      0,
      0,
      COALESCE(v_order.total, v_order.subtotal, 0),
      lower(COALESCE(v_order.currency, v_workspace.default_currency::text, 'usd')),
      1,
      'marketplace',
      v_order.created_at,
      '[]'::jsonb,
      'completed',
      v_order.shipped_at,
      v_delivery_timestamp,
      false,
      NULL,
      'credit',
      NULL,
      v_common_storage_id,
      v_shipping_address,
      v_order_notes,
      v_sales_order_items,
      false,
      'marketplace',
      v_order.id,
      v_order.created_at,
      v_delivery_timestamp,
      'synced',
      1,
      false
    )
    RETURNING id, order_number
    INTO v_sales_order_id, v_sales_order_number;
  END IF;

  UPDATE public.marketplace_orders
  SET
    status = 'delivered',
    delivered_at = COALESCE(delivered_at, v_delivery_timestamp),
    inventory_deducted = COALESCE(v_order.inventory_deducted, false) OR v_inventory_completed,
    business_partner_id = COALESCE(v_business_partner_id, business_partner_id),
    customer_id = COALESCE(v_customer_id, customer_id),
    sales_order_id = COALESCE(v_sales_order_id, sales_order_id),
    version = COALESCE(version, 0) + 1
  WHERE id = v_order.id;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'status', 'delivered',
    'inventory_deducted', COALESCE(v_order.inventory_deducted, false) OR v_inventory_completed,
    'sales_order_id', v_sales_order_id,
    'customer_id', v_customer_id,
    'business_partner_id', v_business_partner_id,
    'warning',
      CASE
        WHEN COALESCE(array_length(v_warning_messages, 1), 0) > 0
          THEN array_to_string(v_warning_messages, '; ')
        ELSE NULL
      END,
    'warnings', to_jsonb(COALESCE(v_warning_messages, ARRAY[]::text[]))
  );
END;
$function$;
