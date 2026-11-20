CREATE TABLE IF NOT EXISTS public.order_financing_edit_operations (
  operation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  order_id uuid NOT NULL,
  loan_id uuid NOT NULL,
  request jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.order_financing_edit_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_financing_edit_operations FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_pending_financed_sales_order(
  p_order_id uuid,
  p_loan_id uuid,
  p_expected_order_version bigint,
  p_expected_loan_version bigint,
  p_operation_id uuid,
  p_order jsonb,
  p_installment_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_order crm.sales_orders%ROWTYPE;
  v_loan public.loans%ROWTYPE;
  v_partner crm.business_partners%ROWTYPE;
  v_saved_request jsonb;
  v_request jsonb;
  v_result jsonb;
  v_method text;
  v_module text;
  v_currency text;
  v_total numeric;
  v_installment_count integer;
  v_installment_frequency text;
  v_first_due_date date;
  v_base_amount numeric;
  v_planned_amount numeric;
  v_due_date date;
  v_existing_installment_id uuid;
  v_index integer;
  v_usage numeric := 0;
  v_new_exposure numeric;
BEGIN
  IF v_workspace_id IS NULL OR p_operation_id IS NULL OR p_order_id IS NULL OR p_loan_id IS NULL THEN
    RAISE EXCEPTION 'A workspace, order, loan, and operation are required' USING ERRCODE = '22023';
  END IF;
  IF p_order IS NULL OR jsonb_typeof(p_order) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_order->'items') IS DISTINCT FROM 'array'
    OR COALESCE(cardinality(p_installment_ids), 0) = 0
  THEN
    RAISE EXCEPTION 'financed_order_schedule_invalid' USING ERRCODE = '22023';
  END IF;
  IF public.current_user_role() NOT IN ('admin', 'staff')
    OR NOT COALESCE(public.current_user_can_access_sales_orders(v_workspace_id), false)
  THEN
    RAISE EXCEPTION 'You are not allowed to edit this sales order' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order
  FROM crm.sales_orders
  WHERE id = p_order_id AND workspace_id = v_workspace_id AND NOT COALESCE(is_deleted, false)
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002'; END IF;
  IF (public.current_user_has_coach_permission(v_workspace_id)
      AND v_order.created_by IS DISTINCT FROM auth.uid())
    OR (public.current_user_has_view_own_permission('orders.view_own')
      AND v_order.created_by IS DISTINCT FROM auth.uid()
      AND NOT private.sales_agent_commissions_can_view_assigned_order(v_workspace_id, p_order_id)
      AND NOT private.agent_sales_accounts_can_view_own_order(v_workspace_id, v_order.sales_account_agent_id))
    OR (NOT public.current_user_has_coach_permission(v_workspace_id)
      AND NOT (
        (v_order.business_partner_id IS NOT NULL
          AND crm.can_access_business_partner(v_workspace_id, v_order.business_partner_id, 'customer'))
        OR (v_order.business_partner_id IS NULL
          AND crm.can_access_customer_link(v_workspace_id, v_order.customer_id))
      ))
    OR (NOT public.current_user_has_coach_permission(v_workspace_id)
      AND NOT public.sales_order_service_details_visible(auth.uid(), v_workspace_id, v_order.items))
  THEN
    RAISE EXCEPTION 'You are not allowed to edit this sales order' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object(
    'order_id', p_order_id,
    'loan_id', p_loan_id,
    'expected_order_version', p_expected_order_version,
    'expected_loan_version', p_expected_loan_version,
    'order', jsonb_build_object(
      'items', p_order->'items',
      'subtotal', p_order->'subtotal',
      'discount', p_order->'discount',
      'tax', p_order->'tax',
      'total', p_order->'total',
      'currency', p_order->'currency',
      'exchange_rate', p_order->'exchange_rate',
      'exchange_rate_source', p_order->'exchange_rate_source',
      'exchange_rate_timestamp', p_order->'exchange_rate_timestamp',
      'exchange_rates', p_order->'exchange_rates',
      'source_storage_id', p_order->'source_storage_id',
      'order_adjustments', p_order->'order_adjustments',
      'expected_delivery_date', p_order->'expected_delivery_date',
      'notes', p_order->'notes',
      'commission_enabled', p_order->'commission_enabled',
      'commission_mode', p_order->'commission_mode',
      'commission_mode_captured_at', p_order->'commission_mode_captured_at',
      'installment_count', p_order->'installment_count',
      'installment_frequency', p_order->'installment_frequency',
      'first_due_date', p_order->'first_due_date',
      'created_at', p_order->'created_at',
      'status', p_order->'status',
      'payment_method', p_order->'payment_method',
      'linked_loan_id', p_order->'linked_loan_id',
      'is_paid', p_order->'is_paid',
      'paid_amount', p_order->'paid_amount',
      'initial_payment_amount', p_order->'initial_payment_amount'
    ),
    'installment_ids', to_jsonb(p_installment_ids)
  );
  SELECT request INTO v_saved_request
  FROM public.order_financing_edit_operations
  WHERE operation_id = p_operation_id AND workspace_id = v_workspace_id;
  IF FOUND THEN
    IF v_saved_request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'financed_order_version_conflict' USING ERRCODE = '40001';
    END IF;
    RETURN private.loan_aggregate_result(p_loan_id);
  END IF;

  IF v_order.version IS DISTINCT FROM p_expected_order_version THEN
    RAISE EXCEPTION 'financed_order_version_conflict' USING ERRCODE = '40001';
  END IF;
  IF v_order.status IS DISTINCT FROM 'pending'
    OR COALESCE(v_order.is_archived, false)
    OR COALESCE(v_order.is_paid, false)
    OR COALESCE(v_order.payment_status, 'unpaid') IS DISTINCT FROM 'unpaid'
    OR COALESCE(v_order.paid_amount, 0) > 0.0005
    OR COALESCE(v_order.initial_payment_amount, 0) > 0.0005
    OR COALESCE(v_order.balance_amount, v_order.total, 0) < COALESCE(v_order.total, 0) - 0.0005
    OR v_order.linked_loan_id IS DISTINCT FROM p_loan_id
    OR COALESCE(v_order.payment_method, '') NOT IN ('loan', 'installments')
  THEN
    RAISE EXCEPTION 'financed_order_not_editable' USING ERRCODE = '23514';
  END IF;

  v_method := v_order.payment_method;
  v_module := CASE WHEN v_method = 'loan' THEN 'loans' ELSE 'installments' END;
  PERFORM private.assert_loan_write_access(v_workspace_id, v_module);

  SELECT * INTO v_loan
  FROM public.loans
  WHERE id = p_loan_id AND workspace_id = v_workspace_id AND NOT COALESCE(is_deleted, false)
  FOR UPDATE;
  IF NOT FOUND
    OR v_loan.source IS DISTINCT FROM 'order'
    OR v_loan.order_type IS DISTINCT FROM 'sales'
    OR v_loan.order_id IS DISTINCT FROM p_order_id
    OR v_loan.status NOT IN ('active', 'overdue')
    OR v_loan.version IS DISTINCT FROM p_expected_loan_version
    OR v_loan.loan_category IS DISTINCT FROM (CASE WHEN v_method = 'loan' THEN 'simple' ELSE 'standard' END)
    OR v_loan.direction IS DISTINCT FROM 'lent'
    OR lower(v_loan.settlement_currency) IS DISTINCT FROM lower(v_order.currency)
    OR COALESCE(v_loan.total_paid_amount, 0) > 0.0005
    OR abs(COALESCE(v_loan.balance_amount, 0) - COALESCE(v_order.total, 0)) > 0.0005
    OR abs(COALESCE(v_loan.principal_amount, 0) - COALESCE(v_order.total, 0)) > 0.0005
  THEN
    RAISE EXCEPTION 'financed_order_loan_mismatch' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loan_payments payment
    WHERE payment.workspace_id = v_workspace_id AND payment.loan_id = p_loan_id
      AND NOT COALESCE(payment.is_deleted, false)
  ) OR EXISTS (
    SELECT 1 FROM public.payment_transactions transaction
    WHERE transaction.workspace_id = v_workspace_id
      AND NOT COALESCE(transaction.is_deleted, false)
      AND (
        (transaction.source_module = 'loans' AND transaction.source_record_id = p_loan_id)
        OR (transaction.source_type = 'sales_order' AND transaction.source_record_id = p_order_id)
      )
  ) THEN
    RAISE EXCEPTION 'financed_order_has_payment_history' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loan_installments installment
    WHERE installment.workspace_id = v_workspace_id AND installment.loan_id = p_loan_id
      AND NOT COALESCE(installment.is_deleted, false)
      AND (
        COALESCE(installment.paid_amount, 0) > 0.0005
        OR abs(COALESCE(installment.balance_amount, 0) - COALESCE(installment.planned_amount, 0)) > 0.0005
        OR installment.status NOT IN ('unpaid', 'overdue')
      )
  ) THEN
    RAISE EXCEPTION 'financed_order_has_payment_history' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.loan_installments
  WHERE workspace_id = v_workspace_id AND loan_id = p_loan_id AND NOT COALESCE(is_deleted, false)
  ORDER BY installment_no FOR UPDATE;

  v_currency := lower(COALESCE(NULLIF(p_order->>'currency', ''), v_order.currency));
  IF v_currency IS DISTINCT FROM lower(v_order.currency)
    OR v_currency IS DISTINCT FROM lower(v_loan.settlement_currency)
  THEN
    RAISE EXCEPTION 'financed_order_currency_locked' USING ERRCODE = '23514';
  END IF;
  v_total := round(COALESCE(NULLIF(p_order->>'total', '')::numeric, 0), 3);
  IF v_total <= 0 OR COALESCE(NULLIF(p_order->>'initial_payment_amount', '')::numeric, 0) > 0.0005
    OR COALESCE(NULLIF(p_order->>'paid_amount', '')::numeric, 0) > 0.0005
    OR COALESCE((p_order->>'is_paid')::boolean, false)
    OR COALESCE(p_order->>'status', 'pending') IS DISTINCT FROM 'pending'
    OR COALESCE(p_order->>'payment_status', 'unpaid') IS DISTINCT FROM 'unpaid'
    OR COALESCE(p_order->>'payment_method', '') IS DISTINCT FROM v_method
    OR NULLIF(p_order->>'linked_loan_id', '')::uuid IS DISTINCT FROM p_loan_id
  THEN
    RAISE EXCEPTION 'financed_order_still_unpaid' USING ERRCODE = '23514';
  END IF;

  v_installment_frequency := COALESCE(NULLIF(p_order->>'installment_frequency', ''), v_loan.installment_frequency, 'monthly');
  IF v_installment_frequency NOT IN ('daily', 'weekly', 'biweekly', 'monthly') THEN
    RAISE EXCEPTION 'financed_order_schedule_invalid' USING ERRCODE = '22023';
  END IF;
  v_first_due_date := NULLIF(p_order->>'first_due_date', '')::date;
  v_installment_count := CASE
    WHEN v_method = 'loan' THEN 1
    ELSE GREATEST(COALESCE(NULLIF(p_order->>'installment_count', '')::integer, 1), 1)
  END;
  IF v_method = 'installments' AND v_first_due_date IS NULL THEN
    RAISE EXCEPTION 'financed_order_schedule_required' USING ERRCODE = '23514';
  END IF;
  IF cardinality(p_installment_ids) <> v_installment_count THEN
    RAISE EXCEPTION 'financed_order_schedule_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_installment_count > 120 THEN
    RAISE EXCEPTION 'financed_order_schedule_invalid' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_installment_ids) AS supplied(id)
    WHERE id IS NULL
  ) OR (SELECT count(DISTINCT id) FROM unnest(p_installment_ids) AS supplied(id)) <> v_installment_count THEN
    RAISE EXCEPTION 'financed_order_schedule_invalid' USING ERRCODE = '22023';
  END IF;

  IF v_loan.linked_party_type = 'business_partner' AND v_loan.linked_party_id IS NOT NULL THEN
    SELECT * INTO v_partner
    FROM crm.business_partners
    WHERE id = v_loan.linked_party_id AND workspace_id = v_workspace_id AND NOT COALESCE(is_deleted, false)
    FOR UPDATE;
    IF FOUND AND v_partner.receivable_credit_limit IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.loans other
        WHERE other.workspace_id = v_workspace_id AND other.linked_party_id = v_loan.linked_party_id
          AND other.direction = 'lent' AND other.status NOT IN ('completed', 'cancelled')
          AND other.balance_amount > 0 AND NOT COALESCE(other.is_deleted, false) AND other.id <> p_loan_id
          AND public.convert_financed_amount(other.balance_amount, other.settlement_currency,
            v_partner.default_currency, other.exchange_rate_snapshot) IS NULL
      ) THEN
        RAISE EXCEPTION 'missing_credit_limit_exchange_rate';
      END IF;
      SELECT COALESCE(sum(public.convert_financed_amount(other.balance_amount, other.settlement_currency,
        v_partner.default_currency, other.exchange_rate_snapshot)), 0)
      INTO v_usage
      FROM public.loans other
      WHERE other.workspace_id = v_workspace_id AND other.linked_party_id = v_loan.linked_party_id
        AND other.direction = 'lent' AND other.status NOT IN ('completed', 'cancelled')
        AND other.balance_amount > 0 AND NOT COALESCE(other.is_deleted, false) AND other.id <> p_loan_id;
      v_new_exposure := public.convert_financed_amount(
        v_total, v_loan.settlement_currency, v_partner.default_currency, v_loan.exchange_rate_snapshot
      );
      IF v_new_exposure IS NULL THEN RAISE EXCEPTION 'missing_credit_limit_exchange_rate'; END IF;
      IF v_usage + v_new_exposure > v_partner.receivable_credit_limit THEN
        RAISE EXCEPTION 'credit_limit_exceeded';
      END IF;
    END IF;
  END IF;

  UPDATE crm.sales_orders
  SET items = p_order->'items',
      subtotal = COALESCE(NULLIF(p_order->>'subtotal', '')::numeric, 0),
      discount = COALESCE(NULLIF(p_order->>'discount', '')::numeric, 0),
      tax = COALESCE(NULLIF(p_order->>'tax', '')::numeric, 0),
      total = v_total,
      exchange_rate = NULLIF(p_order->>'exchange_rate', '')::numeric,
      exchange_rate_source = NULLIF(p_order->>'exchange_rate_source', ''),
      exchange_rate_timestamp = NULLIF(p_order->>'exchange_rate_timestamp', '')::timestamptz,
      exchange_rates = CASE WHEN p_order ? 'exchange_rates' THEN
        CASE
          WHEN p_order->'exchange_rates' = 'null'::jsonb THEN NULL
          WHEN jsonb_typeof(p_order->'exchange_rates') = 'array' THEN
            CASE WHEN jsonb_array_length(p_order->'exchange_rates') = 0 THEN NULL
              ELSE p_order->'exchange_rates' END
          ELSE p_order->'exchange_rates'
        END
        ELSE exchange_rates END,
      balance_amount = v_total,
      paid_amount = 0,
      payment_status = 'unpaid',
      is_paid = false,
      paid_at = NULL,
      initial_payment_amount = 0,
      is_installment_based = (v_method = 'installments'),
      installment_count = COALESCE(NULLIF(p_order->>'installment_count', '')::integer, 0),
      installment_frequency = v_installment_frequency,
      first_due_date = v_first_due_date,
      next_due_date = v_first_due_date,
      source_storage_id = NULLIF(p_order->>'source_storage_id', '')::uuid,
      order_adjustments = CASE WHEN p_order ? 'order_adjustments'
        THEN NULLIF(p_order->'order_adjustments', 'null'::jsonb) ELSE order_adjustments END,
      expected_delivery_date = NULLIF(p_order->>'expected_delivery_date', '')::timestamptz,
      created_at = COALESCE(NULLIF(p_order->>'created_at', '')::timestamptz, created_at),
      notes = NULLIF(p_order->>'notes', ''),
      commission_enabled = COALESCE((p_order->>'commission_enabled')::boolean, commission_enabled),
      commission_mode = CASE WHEN COALESCE((p_order->>'commission_enabled')::boolean, commission_enabled)
        THEN COALESCE(NULLIF(p_order->>'commission_mode', ''), commission_mode) ELSE NULL END,
      commission_mode_captured_at = CASE WHEN COALESCE((p_order->>'commission_enabled')::boolean, commission_enabled)
        THEN COALESCE(NULLIF(p_order->>'commission_mode_captured_at', '')::timestamptz, commission_mode_captured_at)
        ELSE NULL END,
      updated_at = now(),
      version = COALESCE(version, 0) + 1
  WHERE id = p_order_id AND workspace_id = v_workspace_id;

  v_base_amount := round(v_total / v_installment_count, 3);
  FOR v_index IN 1..v_installment_count LOOP
    v_planned_amount := CASE
      WHEN v_index = v_installment_count THEN round(v_total - (v_base_amount * (v_installment_count - 1)), 3)
      ELSE v_base_amount
    END;
    v_due_date := CASE
      WHEN v_first_due_date IS NULL THEN NULL
      WHEN v_installment_frequency = 'daily' THEN v_first_due_date + (v_index - 1)
      WHEN v_installment_frequency = 'weekly' THEN v_first_due_date + ((v_index - 1) * 7)
      WHEN v_installment_frequency = 'biweekly' THEN v_first_due_date + ((v_index - 1) * 14)
      ELSE (v_first_due_date + make_interval(months => v_index - 1))::date
    END;

    SELECT id INTO v_existing_installment_id
    FROM public.loan_installments
    WHERE workspace_id = v_workspace_id AND loan_id = p_loan_id
      AND installment_no = v_index AND NOT COALESCE(is_deleted, false)
    FOR UPDATE;
    IF FOUND THEN
      IF p_installment_ids[v_index] IS DISTINCT FROM v_existing_installment_id THEN
        RAISE EXCEPTION 'financed_order_version_conflict' USING ERRCODE = '40001';
      END IF;
      UPDATE public.loan_installments
      SET due_date = v_due_date,
          planned_amount = v_planned_amount,
          paid_amount = 0,
          balance_amount = v_planned_amount,
          status = CASE WHEN v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN 'overdue' ELSE 'unpaid' END,
          paid_at = NULL,
          integrity_version = GREATEST(COALESCE(integrity_version, 0), 1),
          updated_at = now(),
          version = COALESCE(version, 0) + 1
      WHERE id = v_existing_installment_id;
    ELSE
      SELECT id INTO v_existing_installment_id
      FROM public.loan_installments
      WHERE id = p_installment_ids[v_index] AND workspace_id = v_workspace_id
        AND loan_id = p_loan_id AND COALESCE(is_deleted, false)
      FOR UPDATE;
      IF FOUND THEN
        UPDATE public.loan_installments
        SET installment_no = v_index,
            due_date = v_due_date,
            planned_amount = v_planned_amount,
            paid_amount = 0,
            balance_amount = v_planned_amount,
            status = CASE WHEN v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN 'overdue' ELSE 'unpaid' END,
            paid_at = NULL,
            is_deleted = false,
            integrity_version = GREATEST(COALESCE(integrity_version, 0), 1),
            updated_at = now(),
            version = COALESCE(version, 0) + 1
        WHERE id = v_existing_installment_id;
      ELSE
        INSERT INTO public.loan_installments (
          id, loan_id, workspace_id, installment_no, due_date, planned_amount,
          paid_amount, balance_amount, status, paid_at, integrity_version,
          created_at, updated_at, version, is_deleted
        ) VALUES (
          p_installment_ids[v_index], p_loan_id, v_workspace_id, v_index, v_due_date,
          v_planned_amount, 0, v_planned_amount,
          CASE WHEN v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN 'overdue' ELSE 'unpaid' END,
          NULL, 1, now(), now(), 1, false
        );
      END IF;
    END IF;
  END LOOP;

  UPDATE public.loan_installments
  SET is_deleted = true,
      status = 'cancelled',
      integrity_version = GREATEST(COALESCE(integrity_version, 0), 1),
      updated_at = now(),
      version = COALESCE(version, 0) + 1
  WHERE workspace_id = v_workspace_id AND loan_id = p_loan_id
    AND installment_no > v_installment_count AND NOT COALESCE(is_deleted, false);

  UPDATE public.loans
  SET principal_amount = v_total,
      total_paid_amount = 0,
      balance_amount = v_total,
      installment_count = v_installment_count,
      installment_frequency = v_installment_frequency,
      first_due_date = v_first_due_date,
      next_due_date = v_first_due_date,
      status = CASE WHEN v_first_due_date IS NOT NULL AND v_first_due_date < CURRENT_DATE THEN 'overdue' ELSE 'active' END,
      updated_at = now(),
      version = COALESCE(version, 0) + 1,
      integrity_version = GREATEST(COALESCE(integrity_version, 0), 1)
  WHERE id = p_loan_id AND workspace_id = v_workspace_id;

  v_result := private.loan_aggregate_result(p_loan_id);
  INSERT INTO public.order_financing_edit_operations (
    operation_id, workspace_id, order_id, loan_id, request
  ) VALUES (
    p_operation_id, v_workspace_id, p_order_id, p_loan_id, v_request
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_pending_financed_sales_order(uuid, uuid, bigint, bigint, uuid, jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_pending_financed_sales_order(uuid, uuid, bigint, bigint, uuid, jsonb, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
