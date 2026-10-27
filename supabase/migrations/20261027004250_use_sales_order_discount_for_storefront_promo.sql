-- Store marketplace promo deductions in the Sales Order's built-in discount
-- field. The marketplace total is already net of the persisted discount.
DO $marketplace_sales_order_discount$
DECLARE
  v_definition text;
  v_updated text;
  v_old_adjustment_column text := $old_column$      marketplace_order_id,
      order_adjustments,
      created_by,$old_column$;
  v_new_adjustment_column text := $new_column$      marketplace_order_id,
      created_by,$new_column$;
  v_old_adjustment_value text := $old_value$      v_order.id,
      CASE WHEN COALESCE(v_order.discount_amount, 0) > 0
        AND NULLIF(trim(COALESCE(v_order.promo_code, '')), '') IS NOT NULL
        THEN jsonb_build_array(jsonb_build_object(
          'id', gen_random_uuid()::text,
          'type', 'deduction',
          'name', format('Promo code %s', v_order.promo_code),
          'currency', lower(COALESCE(v_order.currency, v_workspace.default_currency::text, 'usd')),
          'amount', round(COALESCE(v_order.discount_amount, 0)::numeric, 3),
          'orderCurrency', lower(COALESCE(v_order.currency, v_workspace.default_currency::text, 'usd')),
          'convertedAmount', round(COALESCE(v_order.discount_amount, 0)::numeric, 3),
          'exchangeRate', 1,
          'exchangeRateSource', 'native',
          'exchangeRateTimestamp', v_shipment_timestamp,
          'exchangeRates', '[]'::jsonb
        ))
        ELSE NULL END,
      v_shipped_actor_id,$old_value$;
  v_new_adjustment_value text := $new_value$      v_order.id,
      v_shipped_actor_id,$new_value$;
  v_old_totals text := $old_totals$      COALESCE(v_order.subtotal, 0),
      0,
      0,
      COALESCE(v_order.total, v_order.subtotal, 0),$old_totals$;
  v_new_totals text := $new_totals$      COALESCE(v_order.subtotal, 0),
      COALESCE(v_order.discount_amount, 0),
      0,
      COALESCE(v_order.total, v_order.subtotal, 0),$new_totals$;
BEGIN
  SELECT pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL
    OR position('INSERT INTO crm.sales_orders (' IN v_definition) = 0
    OR position('v_create_sales_order' IN v_definition) = 0
    OR position('order_adjustments' IN v_definition) = 0
    OR position('v_order.discount_amount' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Marketplace shipped-order promo deduction is not in the expected state';
  END IF;

  v_updated := replace(v_definition, v_old_adjustment_column, v_new_adjustment_column);
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Promo order-adjustment column could not be removed from the Sale Order insert';
  END IF;
  v_definition := v_updated;

  v_updated := replace(v_definition, v_old_adjustment_value, v_new_adjustment_value);
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Promo order-adjustment value could not be removed from the Sale Order insert';
  END IF;
  v_definition := v_updated;

  v_updated := replace(v_definition, v_old_totals, v_new_totals);
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Persisted promo discount could not be mapped to the Sale Order discount field';
  END IF;

  IF position('order_adjustments' IN v_updated) > 0
    OR position('''type'', ''deduction''' IN v_updated) > 0
    OR position(v_new_totals IN v_updated) = 0
    OR position('v_create_sales_order' IN v_updated) = 0
  THEN
    RAISE EXCEPTION 'Marketplace Sale Order discount migration failed validation';
  END IF;

  EXECUTE v_updated;
END;
$marketplace_sales_order_discount$;

-- Convert any already-created promo deduction rows to the built-in discount
-- field. Keep unrelated Sale Order adjustments and the persisted net total.
DO $marketplace_sales_order_discount_backfill$
DECLARE
  v_conflicts integer;
BEGIN
  SELECT count(*)::integer
  INTO v_conflicts
  FROM public.marketplace_orders mo
  JOIN crm.sales_orders so
    ON so.id = mo.sales_order_id
   AND so.marketplace_order_id = mo.id
  WHERE NULLIF(trim(mo.promo_code), '') IS NOT NULL
    AND COALESCE(mo.discount_amount, 0) > 0
    AND COALESCE(so.discount, 0) <> 0
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(so.order_adjustments) = 'array'
          THEN so.order_adjustments ELSE '[]'::jsonb END
      ) AS adjustment(value)
      WHERE adjustment.value->>'type' = 'deduction'
        AND adjustment.value->>'name' = format('Promo code %s', mo.promo_code)
        AND COALESCE(adjustment.value->'convertedAmount', adjustment.value->'amount')
          = to_jsonb(round(mo.discount_amount::numeric, 3))
    );

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'Cannot backfill promo deductions because a linked Sale Order already has a discount';
  END IF;

  UPDATE crm.sales_orders so
  SET
    discount = round(mo.discount_amount::numeric, 3),
    order_adjustments = (
      SELECT COALESCE(jsonb_agg(adjustment.value ORDER BY adjustment.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(so.order_adjustments) = 'array'
          THEN so.order_adjustments ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS adjustment(value, ordinality)
      WHERE NOT (
        adjustment.value->>'type' = 'deduction'
        AND adjustment.value->>'name' = format('Promo code %s', mo.promo_code)
        AND COALESCE(adjustment.value->'convertedAmount', adjustment.value->'amount')
          = to_jsonb(round(mo.discount_amount::numeric, 3))
      )
    )
  FROM public.marketplace_orders mo
  WHERE so.id = mo.sales_order_id
    AND so.marketplace_order_id = mo.id
    AND NULLIF(trim(mo.promo_code), '') IS NOT NULL
    AND COALESCE(mo.discount_amount, 0) > 0
    AND COALESCE(so.discount, 0) = 0
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(so.order_adjustments) = 'array'
          THEN so.order_adjustments ELSE '[]'::jsonb END
      ) AS adjustment(value)
      WHERE adjustment.value->>'type' = 'deduction'
        AND adjustment.value->>'name' = format('Promo code %s', mo.promo_code)
        AND COALESCE(adjustment.value->'convertedAmount', adjustment.value->'amount')
          = to_jsonb(round(mo.discount_amount::numeric, 3))
    );
END;
$marketplace_sales_order_discount_backfill$;
