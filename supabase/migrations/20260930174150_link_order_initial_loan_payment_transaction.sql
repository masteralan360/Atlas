-- A simple order loan represents the full order obligation. The amount entered
-- on the order form is its first repayment, rather than a separate down
-- payment. Keep the legacy path for orders that already posted a down payment
-- so clients from an earlier release cannot be double-posted during rollout.
CREATE OR REPLACE FUNCTION public.activate_financed_order(
  p_order_type text,
  p_order_id uuid,
  p_target_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, crm, payment_accounts, pg_temp
AS $function$
DECLARE
  v_sales crm.sales_orders%ROWTYPE;
  v_purchase crm.purchase_orders%ROWTYPE;
  v_workspace_id uuid := public.current_workspace_id();
  v_loan_id uuid;
  v_order_number text;
  v_partner_id uuid;
  v_partner_name text;
  v_payment_method text;
  v_total numeric;
  v_balance numeric;
  v_initial_payment numeric := 0;
  v_initial_payment_account_id uuid;
  v_initial_payment_account_name text;
  v_exchange_rates jsonb;
  v_installment_count integer;
  v_installment_frequency text;
  v_first_due_date date;
  v_created_by uuid;
  v_payment_at timestamptz;
  v_direction text;
  v_legacy_down_payment boolean := false;
  v_loan_payment_id uuid;
  v_loan_transaction_id uuid;
  v_loan_no text;
  v_touched_installment_ids jsonb := '[]'::jsonb;
BEGIN
  IF v_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_required'; END IF;

  IF p_order_type = 'sales' THEN
    SELECT * INTO v_sales FROM crm.sales_orders
    WHERE id = p_order_id AND workspace_id = v_workspace_id AND is_deleted = false
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
    IF v_sales.status <> 'draft' OR p_target_status <> 'pending' THEN RAISE EXCEPTION 'invalid_order_transition'; END IF;

    v_order_number := v_sales.order_number;
    v_partner_id := COALESCE(v_sales.business_partner_id, v_sales.customer_id);
    v_partner_name := COALESCE(v_sales.customer_name, 'Customer');
    v_payment_method := v_sales.payment_method;
    v_total := v_sales.total;
    v_balance := v_sales.balance_amount;
    v_initial_payment := GREATEST(COALESCE(v_sales.initial_payment_amount, 0), 0);
    v_initial_payment_account_id := v_sales.initial_payment_account_id;
    v_initial_payment_account_name := v_sales.initial_payment_account_name_snapshot;
    v_exchange_rates := v_sales.exchange_rates;
    v_installment_count := v_sales.installment_count;
    v_installment_frequency := v_sales.installment_frequency;
    v_first_due_date := v_sales.first_due_date;
    v_created_by := v_sales.created_by;
    v_payment_at := COALESCE(v_sales.updated_at, now());
    v_direction := 'lent';
  ELSIF p_order_type = 'purchase' THEN
    SELECT * INTO v_purchase FROM crm.purchase_orders
    WHERE id = p_order_id AND workspace_id = v_workspace_id AND is_deleted = false
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
    IF v_purchase.status <> 'draft' OR p_target_status <> 'ordered' THEN RAISE EXCEPTION 'invalid_order_transition'; END IF;

    v_order_number := v_purchase.order_number;
    v_partner_id := COALESCE(v_purchase.business_partner_id, v_purchase.supplier_id);
    v_partner_name := COALESCE(v_purchase.supplier_name, 'Supplier');
    v_payment_method := v_purchase.payment_method;
    v_total := v_purchase.total;
    v_balance := v_purchase.balance_amount;
    v_initial_payment := GREATEST(COALESCE(v_purchase.initial_payment_amount, 0), 0);
    v_initial_payment_account_id := v_purchase.initial_payment_account_id;
    v_initial_payment_account_name := v_purchase.initial_payment_account_name_snapshot;
    v_exchange_rates := v_purchase.exchange_rates;
    v_installment_count := v_purchase.installment_count;
    v_installment_frequency := v_purchase.installment_frequency;
    v_first_due_date := v_purchase.first_due_date;
    v_created_by := v_purchase.created_by;
    v_payment_at := COALESCE(v_purchase.updated_at, now());
    v_direction := 'borrowed';
  ELSE
    RAISE EXCEPTION 'invalid_order_type';
  END IF;

  IF v_payment_method NOT IN ('loan', 'installments') THEN
    IF p_order_type = 'sales' AND NOT COALESCE(v_sales.is_paid, false) THEN
      RAISE EXCEPTION 'non_financed_order_must_be_paid';
    ELSIF p_order_type = 'purchase' AND NOT COALESCE(v_purchase.is_paid, false) THEN
      RAISE EXCEPTION 'non_financed_order_must_be_paid';
    END IF;
  ELSE
    IF v_balance <= 0 THEN RAISE EXCEPTION 'invalid_financed_balance'; END IF;

    -- Existing desktop clients post a loan's initial amount as an order
    -- down-payment before this RPC runs. Preserve that record and loan basis.
    v_legacy_down_payment := v_payment_method = 'loan' AND EXISTS (
      SELECT 1
      FROM public.payment_transactions payment
      WHERE payment.workspace_id = v_workspace_id
        AND payment.source_type = CASE WHEN p_order_type = 'sales' THEN 'sales_order' ELSE 'purchase_order' END
        AND payment.source_record_id = p_order_id
        AND payment.reversal_of_transaction_id IS NULL
        AND COALESCE(payment.is_deleted, false) = false
        AND payment.metadata ->> 'isFinancingInitialPayment' = 'true'
    );

    v_loan_id := public.create_order_financing_loan(
      v_workspace_id,
      p_order_type,
      p_order_id,
      v_order_number,
      v_partner_id,
      v_partner_name,
      v_payment_method,
      CASE WHEN v_payment_method = 'loan' AND NOT v_legacy_down_payment THEN v_total ELSE v_balance END,
      CASE WHEN p_order_type = 'sales' THEN v_sales.currency ELSE v_purchase.currency END,
      v_exchange_rates,
      v_installment_count,
      v_installment_frequency,
      v_first_due_date,
      v_created_by
    );

    IF v_payment_method = 'loan' AND NOT v_legacy_down_payment AND v_initial_payment > 0 THEN
      v_loan_payment_id := gen_random_uuid();

      UPDATE public.loans
      SET loan_no = loan_no || '-1',
          total_paid_amount = v_initial_payment,
          balance_amount = GREATEST(principal_amount - v_initial_payment, 0),
          status = CASE
            WHEN principal_amount - v_initial_payment <= 0 THEN 'completed'
            WHEN first_due_date < CURRENT_DATE THEN 'overdue'
            ELSE 'active'
          END,
          updated_at = now(),
          version = version + 1
      WHERE id = v_loan_id
      RETURNING loan_no INTO v_loan_no;

      UPDATE public.loan_installments installment
      SET paid_amount = LEAST(installment.planned_amount, v_initial_payment),
          balance_amount = GREATEST(installment.planned_amount - v_initial_payment, 0),
          status = CASE
            WHEN installment.planned_amount - v_initial_payment <= 0 THEN 'paid'
            ELSE 'partial'
          END,
          paid_at = CASE WHEN installment.planned_amount - v_initial_payment <= 0 THEN v_payment_at ELSE NULL END,
          updated_at = now(),
          version = installment.version + 1
      WHERE installment.loan_id = v_loan_id
        AND installment.installment_no = 1
        AND NOT installment.is_deleted;

      SELECT COALESCE(jsonb_agg(installment.id), '[]'::jsonb)
      INTO v_touched_installment_ids
      FROM public.loan_installments installment
      WHERE installment.loan_id = v_loan_id
        AND installment.installment_no = 1
        AND NOT installment.is_deleted;

      v_loan_transaction_id := gen_random_uuid();
      INSERT INTO public.payment_transactions (
        id, workspace_id, source_module, source_type, source_record_id, source_subrecord_id,
        direction, amount, currency, payment_method, paid_at, counterparty_name,
        reference_label, note, created_by, account_id, account_name_snapshot, metadata,
        created_at, updated_at, version, is_deleted
      ) VALUES (
        v_loan_transaction_id, v_workspace_id, 'loans', 'simple_loan', v_loan_id, v_loan_payment_id,
        CASE WHEN v_direction = 'lent' THEN 'incoming' ELSE 'outgoing' END,
        v_initial_payment,
        CASE WHEN p_order_type = 'sales' THEN v_sales.currency ELSE v_purchase.currency END,
        'cash', v_payment_at, v_partner_name, v_loan_no, NULL, v_created_by,
        v_initial_payment_account_id, v_initial_payment_account_name,
        jsonb_build_object(
          'loanPaymentId', v_loan_payment_id,
          'loanCategory', 'simple',
          'loanDirection', v_direction,
          'displaySourceLabel', 'order_loan',
          'isOrderLoanInitialRepayment', true,
          'orderId', p_order_id,
          'orderType', p_order_type,
          'touchedInstallmentIds', v_touched_installment_ids
        ),
        now(), now(), 1, false
      );

      INSERT INTO public.loan_payments (
        id, loan_id, workspace_id, sequence_no, amount, payment_method, paid_at, note,
        created_by, payment_transaction_id, reversed_amount, created_at, updated_at,
        version, is_deleted, integrity_version
      ) VALUES (
        v_loan_payment_id, v_loan_id, v_workspace_id, 1, v_initial_payment, 'cash', v_payment_at,
        NULL, v_created_by, v_loan_transaction_id, 0, now(), now(), 1, false, 1
      );
    END IF;
  END IF;

  IF p_order_type = 'sales' THEN
    UPDATE crm.sales_orders
    SET status = 'pending', linked_loan_id = v_loan_id, updated_at = now(), version = version + 1
    WHERE id = p_order_id;
  ELSE
    UPDATE crm.purchase_orders
    SET status = 'ordered', linked_loan_id = v_loan_id, updated_at = now(), version = version + 1
    WHERE id = p_order_id;
  END IF;

  RETURN jsonb_build_object('order_id', p_order_id, 'order_type', p_order_type, 'status', p_target_status, 'loan_id', v_loan_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.activate_financed_order(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.activate_financed_order(text, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
