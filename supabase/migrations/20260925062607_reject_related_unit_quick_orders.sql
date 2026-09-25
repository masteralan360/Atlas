-- Reject related-unit products before the atomic Quick Order writes any stock,
-- payment, or order rows. The regular Sale Order lifecycle supports these units.

CREATE OR REPLACE FUNCTION public.complete_quick_sales_order(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order_payload jsonb := COALESCE(payload->'order', '{}'::jsonb);
  v_payment_payload jsonb := COALESCE(payload->'payment', 'null'::jsonb);
  v_workspace_id uuid := NULLIF(v_order_payload->>'workspace_id', '')::uuid;
  v_order_id uuid := NULLIF(v_order_payload->>'id', '')::uuid;
  v_now timestamptz := clock_timestamp();
  v_plan text;
  v_order crm.sales_orders%ROWTYPE;
  v_payment public.payment_transactions%ROWTYPE;
  v_inventory public.inventory%ROWTYPE;
  v_changed_inventory public.inventory%ROWTYPE;
  v_batch public.stock_batches%ROWTYPE;
  v_changed_batch public.stock_batches%ROWTYPE;
  v_product record;
  v_item jsonb;
  v_updated_item jsonb;
  v_updated_items jsonb := '[]'::jsonb;
  v_changed_inventories jsonb := '[]'::jsonb;
  v_changed_batches jsonb := '[]'::jsonb;
  v_batch_allocations jsonb;
  v_payment_json jsonb := 'null'::jsonb;
  v_product_id uuid;
  v_storage_id uuid;
  v_required_quantity numeric;
  v_pending_reserved numeric;
  v_remaining_quantity numeric;
  v_allocated_quantity numeric;
  v_total_allocated numeric;
  v_original_cost_total numeric;
  v_converted_cost_total numeric;
  v_original_batch_cost numeric;
  v_converted_batch_cost numeric;
  v_fallback_original_cost numeric;
  v_fallback_converted_cost numeric;
  v_original_currency text;
  v_settlement_currency text;
  v_total numeric := COALESCE(NULLIF(v_order_payload->>'total', '')::numeric, 0);
  v_paid_amount numeric := COALESCE(NULLIF(v_order_payload->>'paid_amount', '')::numeric, 0);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;

  IF v_workspace_id IS NULL OR v_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Order workspace does not match the authenticated workspace'
      USING ERRCODE = '42501';
  END IF;

  SELECT workspace.plan::text
  INTO v_plan
  FROM public.workspaces AS workspace
  WHERE workspace.id = v_workspace_id;

  IF NOT COALESCE(public.workspace_module_allowed(v_workspace_id, v_plan, 'pos'), false)
    OR NOT COALESCE(public.workspace_module_allowed(v_workspace_id, v_plan, 'orders'), false)
    OR NOT COALESCE(
      public.workspace_capability_allowed(v_workspace_id, v_plan, 'quickOrder'),
      false
    ) THEN
    RAISE EXCEPTION 'Quick Order is not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;

  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'Quick Order requires an id' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM crm.customers AS customer
    WHERE customer.id = NULLIF(v_order_payload->>'customer_id', '')::uuid
      AND customer.workspace_id = v_workspace_id
      AND NOT customer.is_deleted
      AND (
        NULLIF(v_order_payload->>'business_partner_id', '')::uuid IS NULL
        OR customer.business_partner_id = NULLIF(v_order_payload->>'business_partner_id', '')::uuid
      )
  ) THEN
    RAISE EXCEPTION 'Quick Order customer is unavailable' USING ERRCODE = '23503';
  END IF;

  IF NULLIF(v_order_payload->>'business_partner_id', '')::uuid IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM crm.business_partners AS partner
      WHERE partner.id = NULLIF(v_order_payload->>'business_partner_id', '')::uuid
        AND partner.workspace_id = v_workspace_id
        AND NOT partner.is_deleted
        AND partner.merged_into_business_partner_id IS NULL
    ) THEN
    RAISE EXCEPTION 'Quick Order business partner is unavailable' USING ERRCODE = '23503';
  END IF;

  IF NULLIF(v_order_payload->>'sales_account_agent_id', '')::uuid IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM crm.agents AS agent
      WHERE agent.id = NULLIF(v_order_payload->>'sales_account_agent_id', '')::uuid
        AND agent.workspace_id = v_workspace_id
        AND NOT agent.is_deleted
        AND agent.status = 'active'
        AND agent.sales_account_enabled
    ) THEN
    RAISE EXCEPTION 'Quick Order sales account is unavailable' USING ERRCODE = '23503';
  END IF;

  -- Retrying the same request id is safe. This also protects a caller from
  -- duplicating an order when the first HTTP response was interrupted after
  -- the database transaction committed.
  SELECT sales_order.*
  INTO v_order
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.id = v_order_id
    AND sales_order.workspace_id = v_workspace_id
    AND NOT sales_order.is_deleted;

  IF FOUND THEN
    SELECT payment.*
    INTO v_payment
    FROM public.payment_transactions AS payment
    WHERE payment.workspace_id = v_workspace_id
      AND payment.source_type = 'sales_order'
      AND payment.source_record_id = v_order_id
      AND NOT payment.is_deleted
    ORDER BY payment.created_at, payment.id
    LIMIT 1;

    IF FOUND THEN
      v_payment_json := to_jsonb(v_payment);
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(inventory_row)), '[]'::jsonb)
    INTO v_changed_inventories
    FROM public.inventory AS inventory_row
    JOIN (
      SELECT DISTINCT
        NULLIF(item->>'productId', '')::uuid AS product_id,
        COALESCE(
          NULLIF(item->>'storageId', '')::uuid,
          v_order.source_storage_id
        ) AS storage_id
      FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item
    ) AS position
      ON position.product_id = inventory_row.product_id
     AND position.storage_id = inventory_row.storage_id
    WHERE inventory_row.workspace_id = v_workspace_id;

    SELECT COALESCE(jsonb_agg(to_jsonb(batch_row)), '[]'::jsonb)
    INTO v_changed_batches
    FROM public.stock_batches AS batch_row
    WHERE batch_row.workspace_id = v_workspace_id
      AND batch_row.id IN (
        SELECT NULLIF(allocation->>'batchId', '')::uuid
        FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(item->'batchAllocations') = 'array'
              THEN item->'batchAllocations'
            ELSE '[]'::jsonb
          END
        ) AS allocation
      );

    RETURN jsonb_build_object(
      'order', to_jsonb(v_order),
      'payment', v_payment_json,
      'inventory', v_changed_inventories,
      'stock_batches', v_changed_batches,
      'replayed', true
    );
  END IF;

  IF jsonb_typeof(v_order_payload->'items') <> 'array'
    OR jsonb_array_length(v_order_payload->'items') = 0 THEN
    RAISE EXCEPTION 'Quick Order requires at least one item' USING ERRCODE = '22023';
  END IF;

  -- Related selling units use base-unit stock quantities, but this atomic
  -- checkout only supports single-unit lines. Check the authoritative product
  -- conversion as well as line metadata so an older or direct client cannot
  -- bypass the POS guard by omitting the unit snapshot.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_order_payload->'items') AS entry(item)
    LEFT JOIN public.product_unit_conversions AS conversion
      ON conversion.workspace_id = v_workspace_id
     AND conversion.product_id = NULLIF(entry.item->>'productId', '')::uuid
     AND NOT conversion.is_deleted
    WHERE conversion.id IS NOT NULL
       OR NULLIF(entry.item->>'unitRelationshipId', '') IS NOT NULL
       OR NULLIF(entry.item->>'baseUnitRef', '') IS NOT NULL
       OR COALESCE(NULLIF(entry.item->>'unitFactor', '')::numeric, 1) <> 1
  ) THEN
    RAISE EXCEPTION 'quick_order_related_units_unsupported' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(v_order_payload->>'payment_method', '') IN ('loan', 'installments') THEN
    RAISE EXCEPTION 'Financed orders require the standard order lifecycle'
      USING ERRCODE = '22023';
  END IF;

  IF v_total < 0
    OR COALESCE(NULLIF(v_order_payload->>'payment_status', ''), 'unpaid') <> 'paid'
    OR COALESCE(NULLIF(v_order_payload->>'is_paid', '')::boolean, false) IS NOT TRUE
    OR abs(v_paid_amount - v_total) > 0.0005
    OR abs(COALESCE(NULLIF(v_order_payload->>'balance_amount', '')::numeric, 0)) > 0.0005 THEN
    RAISE EXCEPTION 'Quick Order must be fully paid' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN
    SELECT item.value
    FROM jsonb_array_elements(v_order_payload->'items') AS item(value)
  LOOP
    v_product_id := NULLIF(v_item->>'productId', '')::uuid;
    v_required_quantity := round(
      COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0)
      + COALESCE(
          NULLIF(v_item->>'freeBonusQuantity', '')::numeric,
          NULLIF(v_item->>'freeQuantity', '')::numeric,
          0
        ),
      6
    );

    IF v_product_id IS NULL OR v_required_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid Quick Order item' USING ERRCODE = '22023';
    END IF;

    SELECT
      product.id,
      COALESCE(product.is_service, false) AS is_service,
      product.cost_price,
      lower(COALESCE(product.currency, 'usd')) AS currency
    INTO v_product
    FROM public.products AS product
    WHERE product.id = v_product_id
      AND product.workspace_id = v_workspace_id
      AND NOT product.is_deleted;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found for Quick Order item %', v_product_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_product.is_service AND (v_product.cost_price IS NULL OR v_product.cost_price < 0) THEN
      RAISE EXCEPTION 'Product cost is required before sale'
        USING ERRCODE = '23514';
    END IF;

    v_updated_item := v_item;

    IF NOT v_product.is_service THEN
      v_storage_id := COALESCE(
        NULLIF(v_item->>'storageId', '')::uuid,
        NULLIF(v_order_payload->>'source_storage_id', '')::uuid
      );

      IF v_storage_id IS NULL THEN
        RAISE EXCEPTION 'Source storage is required for product %', v_product_id
          USING ERRCODE = '22023';
      END IF;

      SELECT inventory_row.*
      INTO v_inventory
      FROM public.inventory AS inventory_row
      WHERE inventory_row.workspace_id = v_workspace_id
        AND inventory_row.product_id = v_product_id
        AND inventory_row.storage_id = v_storage_id
        AND NOT inventory_row.is_deleted
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Inventory position was not found for product %', v_product_id
          USING ERRCODE = '23503';
      END IF;

      -- Pending sales orders reserve stock without deducting it. Keep their
      -- reserved quantity backed while serializing immediate orders on the
      -- inventory row lock.
      SELECT COALESCE(sum(
        COALESCE(NULLIF(pending_item->>'quantity', '')::numeric, 0)
        + COALESCE(
            NULLIF(pending_item->>'freeBonusQuantity', '')::numeric,
            NULLIF(pending_item->>'freeQuantity', '')::numeric,
            0
          )
      ), 0)
      INTO v_pending_reserved
      FROM crm.sales_orders AS pending_order
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(pending_order.items, '[]'::jsonb)
      ) AS pending_item
      WHERE pending_order.workspace_id = v_workspace_id
        AND pending_order.status = 'pending'
        AND NOT pending_order.is_deleted
        AND NULLIF(pending_item->>'productId', '')::uuid = v_product_id
        AND COALESCE(
          NULLIF(pending_item->>'storageId', '')::uuid,
          pending_order.source_storage_id
        ) = v_storage_id;

      IF v_inventory.quantity - v_pending_reserved + 0.0000005 < v_required_quantity THEN
        RAISE EXCEPTION 'Insufficient stock for product %', v_product_id
          USING ERRCODE = '23514';
      END IF;

      v_batch_allocations := '[]'::jsonb;
      v_remaining_quantity := v_required_quantity;
      v_total_allocated := 0;
      v_original_cost_total := 0;
      v_converted_cost_total := 0;
      v_fallback_original_cost := COALESCE(NULLIF(v_item->>'costPrice', '')::numeric, 0);
      v_fallback_converted_cost := COALESCE(
        NULLIF(v_item->>'convertedCostPrice', '')::numeric,
        v_fallback_original_cost
      );
      v_original_currency := lower(COALESCE(NULLIF(v_item->>'originalCurrency', ''), v_product.currency));
      v_settlement_currency := lower(COALESCE(
        NULLIF(v_item->>'settlementCurrency', ''),
        NULLIF(v_order_payload->>'currency', ''),
        v_original_currency
      ));

      -- Quick Order does not expose manual batch selection. Allocate FEFO/FIFO
      -- directly from the authoritative rows, then use ordinary unbatched stock
      -- for any remaining quantity exactly like the local planner.
      FOR v_batch IN
        SELECT batch_row.*
        FROM public.stock_batches AS batch_row
        WHERE batch_row.workspace_id = v_workspace_id
          AND batch_row.product_id = v_product_id
          AND batch_row.storage_id = v_storage_id
          AND NOT batch_row.is_deleted
          AND batch_row.quantity > 0
        ORDER BY
          batch_row.expiry_date ASC NULLS LAST,
          batch_row.manufacturing_date ASC NULLS LAST,
          batch_row.created_at ASC,
          batch_row.batch_number ASC
        FOR UPDATE
      LOOP
        EXIT WHEN v_remaining_quantity <= 0.0000005;

        v_allocated_quantity := LEAST(v_remaining_quantity, v_batch.quantity);
        IF v_allocated_quantity <= 0.0000005 THEN
          CONTINUE;
        END IF;

        v_original_batch_cost := round(COALESCE(
          public.convert_financed_amount(
            v_batch.cost_price,
            v_batch.currency,
            v_original_currency,
            v_order_payload->'exchange_rates'
          ),
          v_batch.cost_price
        ), 3);
        v_converted_batch_cost := round(COALESCE(
          public.convert_financed_amount(
            v_batch.cost_price,
            v_batch.currency,
            v_settlement_currency,
            v_order_payload->'exchange_rates'
          ),
          v_batch.cost_price
        ), 3);

        v_original_cost_total := v_original_cost_total
          + (v_original_batch_cost * v_allocated_quantity);
        v_converted_cost_total := v_converted_cost_total
          + (v_converted_batch_cost * v_allocated_quantity);
        v_total_allocated := v_total_allocated + v_allocated_quantity;

        v_batch_allocations := v_batch_allocations || jsonb_build_array(
          jsonb_build_object(
            'batchId', v_batch.id,
            'batchNumber', v_batch.batch_number,
            'quantity', v_allocated_quantity,
            'price', v_batch.price,
            'costPrice', v_batch.cost_price,
            'currency', lower(v_batch.currency),
            'expiryDate', v_batch.expiry_date,
            'manufacturingDate', v_batch.manufacturing_date
          )
        );

        UPDATE public.stock_batches AS batch_row
        SET
          quantity = round(batch_row.quantity - v_allocated_quantity, 6),
          is_deleted = (batch_row.quantity - v_allocated_quantity) <= 0.0000005,
          updated_at = v_now,
          version = COALESCE(batch_row.version, 0) + 1
        WHERE batch_row.id = v_batch.id
        RETURNING batch_row.* INTO v_changed_batch;

        v_changed_batches := v_changed_batches
          || jsonb_build_array(to_jsonb(v_changed_batch));
        v_remaining_quantity := round(v_remaining_quantity - v_allocated_quantity, 6);
      END LOOP;

      v_original_cost_total := v_original_cost_total
        + (v_fallback_original_cost * GREATEST(v_required_quantity - v_total_allocated, 0));
      v_converted_cost_total := v_converted_cost_total
        + (v_fallback_converted_cost * GREATEST(v_required_quantity - v_total_allocated, 0));

      v_updated_item := v_updated_item || jsonb_build_object(
        'storageId', v_storage_id,
        'reservedQuantity', v_required_quantity,
        'fulfilledQuantity', v_required_quantity,
        'costPrice', v_original_cost_total / v_required_quantity,
        'convertedCostPrice', v_converted_cost_total / v_required_quantity,
        'batchAllocations', CASE
          WHEN jsonb_array_length(v_batch_allocations) > 0 THEN v_batch_allocations
          ELSE 'null'::jsonb
        END
      );

      UPDATE public.inventory AS inventory_row
      SET
        quantity = round(inventory_row.quantity - v_required_quantity, 6),
        is_deleted = (inventory_row.quantity - v_required_quantity) <= 0.0000005,
        updated_at = v_now,
        version = COALESCE(inventory_row.version, 0) + 1
      WHERE inventory_row.id = v_inventory.id
      RETURNING inventory_row.* INTO v_changed_inventory;

      v_changed_inventories := v_changed_inventories
        || jsonb_build_array(to_jsonb(v_changed_inventory));
    END IF;

    v_updated_items := v_updated_items || jsonb_build_array(v_updated_item);
  END LOOP;

  INSERT INTO crm.sales_orders (
    id,
    workspace_id,
    order_number,
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
    shipping_address,
    notes,
    items,
    created_at,
    updated_at,
    sync_status,
    version,
    is_deleted,
    source_storage_id,
    is_locked,
    business_partner_id,
    source_channel,
    marketplace_order_id,
    payment_status,
    paid_amount,
    balance_amount,
    is_installment_based,
    installment_count,
    installment_frequency,
    first_due_date,
    next_due_date,
    created_by,
    initial_payment_amount,
    linked_loan_id,
    approval_status,
    approval_requested_by,
    approval_requested_at,
    approval_reviewed_by,
    approval_reviewed_at,
    original_total_amount,
    returned_amount,
    return_status,
    returned_at,
    returned_by,
    order_adjustments,
    initial_payment_account_id,
    initial_payment_account_name_snapshot,
    sales_account_agent_id,
    commission_enabled
  ) VALUES (
    v_order_id,
    v_workspace_id,
    COALESCE(NULLIF(v_order_payload->>'order_number', ''), 'SO-PENDING-' || upper(v_order_id::text)),
    NULLIF(v_order_payload->>'customer_id', '')::uuid,
    NULLIF(v_order_payload->>'customer_name', ''),
    COALESCE(NULLIF(v_order_payload->>'subtotal', '')::numeric, 0),
    COALESCE(NULLIF(v_order_payload->>'discount', '')::numeric, 0),
    COALESCE(NULLIF(v_order_payload->>'tax', '')::numeric, 0),
    v_total,
    lower(COALESCE(NULLIF(v_order_payload->>'currency', ''), 'usd')),
    NULLIF(v_order_payload->>'exchange_rate', '')::numeric,
    NULLIF(v_order_payload->>'exchange_rate_source', ''),
    NULLIF(v_order_payload->>'exchange_rate_timestamp', '')::timestamptz,
    v_order_payload->'exchange_rates',
    'completed',
    NULLIF(v_order_payload->>'expected_delivery_date', '')::timestamptz,
    v_now,
    true,
    COALESCE(NULLIF(v_order_payload->>'paid_at', '')::timestamptz, v_now),
    NULLIF(v_order_payload->>'payment_method', ''),
    v_now,
    COALESCE(v_order_payload->>'shipping_address', ''),
    NULLIF(v_order_payload->>'notes', ''),
    v_updated_items,
    COALESCE(NULLIF(v_order_payload->>'created_at', '')::timestamptz, v_now),
    v_now,
    'synced',
    1,
    false,
    NULLIF(v_order_payload->>'source_storage_id', '')::uuid,
    false,
    NULLIF(v_order_payload->>'business_partner_id', '')::uuid,
    COALESCE(NULLIF(v_order_payload->>'source_channel', ''), 'manual'),
    NULLIF(v_order_payload->>'marketplace_order_id', '')::uuid,
    'paid',
    v_paid_amount,
    0,
    false,
    0,
    NULL,
    NULL,
    NULL,
    auth.uid(),
    0,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULLIF(v_order_payload->>'original_total_amount', '')::numeric,
    COALESCE(NULLIF(v_order_payload->>'returned_amount', '')::numeric, 0),
    COALESCE(NULLIF(v_order_payload->>'return_status', ''), 'none'),
    NULLIF(v_order_payload->>'returned_at', '')::timestamptz,
    NULLIF(v_order_payload->>'returned_by', '')::uuid,
    v_order_payload->'order_adjustments',
    NULLIF(v_order_payload->>'initial_payment_account_id', '')::uuid,
    NULLIF(v_order_payload->>'initial_payment_account_name_snapshot', ''),
    NULLIF(v_order_payload->>'sales_account_agent_id', '')::uuid,
    COALESCE(NULLIF(v_order_payload->>'commission_enabled', '')::boolean, true)
  )
  RETURNING * INTO v_order;

  IF v_paid_amount > 0.0005 THEN
    IF jsonb_typeof(v_payment_payload) <> 'object' THEN
      RAISE EXCEPTION 'Quick Order payment details are required' USING ERRCODE = '22023';
    END IF;

    IF NULLIF(v_payment_payload->>'source_record_id', '')::uuid IS DISTINCT FROM v_order.id
      OR COALESCE(NULLIF(v_payment_payload->>'direction', ''), '') <> 'incoming'
      OR abs(COALESCE(NULLIF(v_payment_payload->>'amount', '')::numeric, 0) - v_paid_amount) > 0.0005
      OR lower(COALESCE(NULLIF(v_payment_payload->>'currency', ''), '')) <> lower(v_order.currency)
      OR NULLIF(v_payment_payload->>'account_id', '')::uuid
        IS DISTINCT FROM v_order.initial_payment_account_id THEN
      RAISE EXCEPTION 'Quick Order payment does not match the order' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.payment_transactions (
      id,
      workspace_id,
      source_module,
      source_type,
      source_record_id,
      source_subrecord_id,
      direction,
      amount,
      currency,
      payment_method,
      paid_at,
      counterparty_name,
      reference_label,
      note,
      created_by,
      account_id,
      account_name_snapshot,
      reversal_of_transaction_id,
      metadata,
      created_at,
      updated_at,
      version,
      is_deleted
    ) VALUES (
      COALESCE(NULLIF(v_payment_payload->>'id', '')::uuid, gen_random_uuid()),
      v_workspace_id,
      'orders',
      'sales_order',
      v_order.id,
      NULL,
      'incoming',
      v_paid_amount,
      lower(v_order.currency),
      v_order.payment_method,
      COALESCE(v_order.paid_at, v_now),
      v_order.customer_name,
      v_order.order_number,
      v_order.notes,
      auth.uid(),
      NULLIF(v_payment_payload->>'account_id', '')::uuid,
      NULLIF(v_payment_payload->>'account_name_snapshot', ''),
      NULL,
      jsonb_build_object(
        'orderStatus', 'completed',
        'sourceChannel', v_order.source_channel,
        'isDownPayment', false,
        'isFinancingInitialPayment', false
      ),
      v_now,
      v_now,
      1,
      false
    )
    RETURNING * INTO v_payment;

    v_payment_json := to_jsonb(v_payment);
  END IF;

  RETURN jsonb_build_object(
    'order', to_jsonb(v_order),
    'payment', v_payment_json,
    'inventory', v_changed_inventories,
    'stock_batches', v_changed_batches,
    'replayed', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_quick_sales_order(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_quick_sales_order(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_quick_sales_order(jsonb) TO authenticated, service_role;
