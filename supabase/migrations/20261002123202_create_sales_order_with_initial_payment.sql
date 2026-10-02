-- Keep creation and its first payment atomic without bypassing the caller's
-- RLS, product/unit validation, account permissions, or overpayment guards.
CREATE OR REPLACE FUNCTION public.create_sales_order_with_initial_payment(
  p_order jsonb, p_transaction jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_order crm.sales_orders%ROWTYPE;
  v_saved crm.sales_orders%ROWTYPE;
  v_payment public.payment_transactions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_columns text;
BEGIN
  IF pg_catalog.jsonb_typeof(p_order) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(p_transaction) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_order_payment_payload' USING ERRCODE = '23514';
  END IF;
  v_order := pg_catalog.jsonb_populate_record(NULL::crm.sales_orders, p_order);
  v_payment := pg_catalog.jsonb_populate_record(NULL::public.payment_transactions, p_transaction);
  IF auth.uid() IS NULL
    OR v_order.workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR COALESCE(public.current_user_role(), '') NOT IN ('admin', 'staff')
    OR NOT public.current_user_can_access_sales_orders(v_order.workspace_id) THEN
    RAISE EXCEPTION 'order_payment_workspace_access_denied' USING ERRCODE = '42501';
  END IF;
  IF v_order.id IS NULL OR v_payment.id IS NULL
    OR v_order.status IS NULL OR v_order.status NOT IN ('draft', 'pending', 'completed')
    OR COALESCE(v_order.is_deleted, false) OR COALESCE(v_order.is_locked, false)
    OR COALESCE(v_order.is_archived, false) OR v_order.approval_status = 'requested'
    OR v_order.payment_method = 'loan' OR v_order.linked_loan_id IS NOT NULL
    OR COALESCE(v_order.return_status, 'none') <> 'none'
    OR COALESCE(v_order.returned_amount, 0) <> 0
    OR v_payment.workspace_id IS DISTINCT FROM v_order.workspace_id
    OR v_payment.source_module IS DISTINCT FROM 'orders'
    OR v_payment.source_type IS DISTINCT FROM 'sales_order'
    OR v_payment.source_record_id IS DISTINCT FROM v_order.id
    OR v_payment.source_subrecord_id IS NOT NULL
    OR v_payment.direction IS DISTINCT FROM 'incoming'
    OR v_payment.currency IS DISTINCT FROM v_order.currency
    OR v_payment.account_id IS DISTINCT FROM v_order.initial_payment_account_id
    OR v_order.total IS NULL OR v_order.total <= 0
    OR v_payment.amount IS NULL OR v_payment.amount <= 0
    OR v_payment.amount IS DISTINCT FROM v_order.paid_amount
    OR v_payment.amount > v_order.total
    OR v_payment.amount IS DISTINCT FROM (CASE WHEN v_order.payment_method = 'installments'
      THEN v_order.initial_payment_amount ELSE v_order.total END)
    OR v_order.balance_amount IS DISTINCT FROM (v_order.total - v_payment.amount)
    OR v_order.is_paid IS DISTINCT FROM (v_payment.amount = v_order.total)
    OR v_order.payment_status IS DISTINCT FROM (CASE WHEN v_payment.amount = v_order.total THEN 'paid' ELSE 'partial' END)
    OR (v_order.payment_method = 'installments' AND v_payment.amount >= v_order.total)
    OR v_payment.payment_method IS DISTINCT FROM (CASE WHEN v_order.payment_method = 'installments'
      THEN 'cash' ELSE v_order.payment_method END)
    OR COALESCE(v_payment.is_deleted, false) OR v_payment.void_id IS NOT NULL
    OR v_payment.reversal_of_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_order_payment_payload' USING ERRCODE = '23514';
  END IF;

  -- Serialize creation retries even before the parent row exists. Subsequent
  -- payment writes retain their existing parent-row lock and validation.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'initial-sales-order:' || v_order.id::text, 0));
  SELECT * INTO v_saved FROM crm.sales_orders WHERE id = v_order.id FOR UPDATE;
  IF FOUND AND v_saved.workspace_id IS DISTINCT FROM v_order.workspace_id THEN
    RAISE EXCEPTION 'order_payment_workspace_access_denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_existing FROM public.payment_transactions WHERE id = v_payment.id;
  IF FOUND THEN
    IF v_saved.id IS NULL
      OR v_existing.workspace_id IS DISTINCT FROM v_payment.workspace_id
      OR v_existing.source_type IS DISTINCT FROM v_payment.source_type
      OR v_existing.source_record_id IS DISTINCT FROM v_order.id
      OR v_existing.source_subrecord_id IS NOT NULL
      OR v_existing.amount IS DISTINCT FROM v_payment.amount
      OR v_existing.currency IS DISTINCT FROM v_payment.currency
      OR v_existing.payment_method IS DISTINCT FROM v_payment.payment_method
      OR v_existing.direction IS DISTINCT FROM v_payment.direction
      OR v_existing.account_id IS DISTINCT FROM v_payment.account_id
      OR v_existing.reversal_of_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'order_payment_idempotency_conflict' USING ERRCODE = '23514';
    END IF;
    -- Return the first receipt; never reset later edits, fulfillment or returns.
    RETURN pg_catalog.jsonb_build_object('order', pg_catalog.to_jsonb(v_saved),
      'payment', pg_catalog.to_jsonb(v_existing));
  END IF;
  IF v_saved.id IS NOT NULL THEN
    IF v_saved.total IS DISTINCT FROM v_order.total
      OR v_saved.paid_amount IS DISTINCT FROM v_order.paid_amount
      OR v_saved.currency IS DISTINCT FROM v_order.currency
      OR v_saved.payment_method IS DISTINCT FROM v_order.payment_method
      OR v_saved.customer_id IS DISTINCT FROM v_order.customer_id
      OR v_saved.is_deleted OR v_saved.is_locked OR v_saved.is_archived THEN
      RAISE EXCEPTION 'order_payment_idempotency_conflict' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- Insert only supplied columns so ordinary table defaults remain effective.
    -- Identifiers come exclusively from pg_attribute, values use a parameter.
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_order) AS key(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'crm.sales_orders'::regclass
          AND attribute.attname = key.name AND attribute.attnum > 0
          AND NOT attribute.attisdropped AND attribute.attgenerated = '')) THEN
      RAISE EXCEPTION 'invalid_order_payment_payload' USING ERRCODE = '23514';
    END IF;
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO v_columns FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'crm.sales_orders'::regclass AND attribute.attnum > 0
      AND NOT attribute.attisdropped AND attribute.attgenerated = '' AND p_order ? attribute.attname;
    EXECUTE pg_catalog.format(
      'INSERT INTO crm.sales_orders (%s) SELECT %s FROM pg_catalog.jsonb_populate_record(NULL::crm.sales_orders, $1) ON CONFLICT (id) DO NOTHING RETURNING *',
      v_columns, v_columns) INTO v_saved USING p_order;
    IF v_saved.id IS NULL THEN
      RAISE EXCEPTION 'order_payment_idempotency_conflict' USING ERRCODE = '23514';
    END IF;
  END IF;
  v_payment.reference_label := v_saved.order_number;
  v_payment.created_by := COALESCE(v_payment.created_by, auth.uid());
  v_payment.created_at := COALESCE(v_payment.created_at, pg_catalog.now());
  v_payment.updated_at := COALESCE(v_payment.updated_at, pg_catalog.now());
  v_payment.version := COALESCE(v_payment.version, 1);
  v_payment.is_deleted := false;
  INSERT INTO public.payment_transactions SELECT (v_payment).* RETURNING * INTO v_payment;
  RETURN pg_catalog.jsonb_build_object('order', pg_catalog.to_jsonb(v_saved),
    'payment', pg_catalog.to_jsonb(v_payment));
END;
$function$;
REVOKE ALL ON FUNCTION public.create_sales_order_with_initial_payment(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sales_order_with_initial_payment(jsonb, jsonb) TO authenticated;
