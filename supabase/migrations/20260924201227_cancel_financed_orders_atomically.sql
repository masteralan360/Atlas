-- The Cloud/Hybrid client must not infer that a linked loan was removed from
-- its Dexie cache. Cancel the order and its financing against authoritative
-- rows in one database transaction. Historical payments remain as reversal
-- pairs; the loan and schedule are soft-deleted for audit.
CREATE OR REPLACE FUNCTION private.cancel_order_with_financing(
  p_order_type text,
  p_order_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_plan text;
  v_sales crm.sales_orders%ROWTYPE;
  v_purchase crm.purchase_orders%ROWTYPE;
  v_loan public.loans%ROWTYPE;
  v_loan_payment public.loan_payments%ROWTYPE;
  v_order_payment public.payment_transactions%ROWTYPE;
  v_order_source_type text;
  v_order_status text;
  v_payment_method text;
  v_order_number text;
  v_linked_loan_id uuid;
  v_loan_transaction_id uuid;
  v_active_installments integer;
  v_active_loans integer;
  v_reversed_amount numeric;
  v_remaining numeric;
  v_rows integer;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_workspace_id IS NULL
    OR COALESCE(public.current_user_role(), '') NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'order_cancellation_not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_order_type IS NULL OR p_order_type NOT IN ('sales', 'purchase')
    OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'invalid_order_cancellation_request' USING ERRCODE = '22023';
  END IF;

  SELECT workspace.plan::text INTO v_plan
  FROM public.workspaces AS workspace WHERE workspace.id = v_workspace_id;
  IF v_plan IS NULL OR NOT COALESCE(
    public.workspace_module_allowed(v_workspace_id, v_plan, 'orders'), false
  ) THEN
    RAISE EXCEPTION 'orders_module_not_available' USING ERRCODE = '42501';
  END IF;

  IF p_order_type = 'sales' THEN
    SELECT * INTO v_sales FROM crm.sales_orders
    WHERE id = p_order_id AND workspace_id = v_workspace_id AND NOT is_deleted
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002'; END IF;
    v_order_status := v_sales.status;
    v_payment_method := v_sales.payment_method;
    v_order_number := v_sales.order_number;
    v_linked_loan_id := v_sales.linked_loan_id;
    v_order_source_type := 'sales_order';
  ELSE
    SELECT * INTO v_purchase FROM crm.purchase_orders
    WHERE id = p_order_id AND workspace_id = v_workspace_id AND NOT is_deleted
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002'; END IF;
    v_order_status := v_purchase.status;
    v_payment_method := v_purchase.payment_method;
    v_order_number := v_purchase.order_number;
    v_linked_loan_id := v_purchase.linked_loan_id;
    v_order_source_type := 'purchase_order';
  END IF;

  IF COALESCE(v_payment_method, '') NOT IN ('loan', 'installments')
    AND v_linked_loan_id IS NULL THEN
    RAISE EXCEPTION 'order_is_not_financed' USING ERRCODE = '22023';
  END IF;
  IF v_order_status NOT IN ('draft', 'cancelled',
    CASE WHEN p_order_type = 'sales' THEN 'pending' ELSE 'ordered' END
  ) THEN
    RAISE EXCEPTION 'invalid_order_transition' USING ERRCODE = '23514';
  END IF;

  -- Resolve by source identity as well as linked_loan_id. A stale or missing
  -- client link must never let an active order loan escape cancellation.
  SELECT COUNT(*) INTO v_active_loans FROM public.loans AS loan
  WHERE loan.workspace_id = v_workspace_id
    AND loan.source = 'order' AND loan.order_type = p_order_type
    AND loan.order_id = p_order_id AND NOT loan.is_deleted;
  IF v_active_loans > 1 THEN
    RAISE EXCEPTION 'financed_order_has_multiple_active_loans' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_loan
  FROM public.loans AS loan
  WHERE loan.workspace_id = v_workspace_id
    AND loan.source = 'order'
    AND loan.order_type = p_order_type
    AND loan.order_id = p_order_id
  ORDER BY loan.is_deleted ASC, loan.created_at DESC
  LIMIT 1 FOR UPDATE;
  IF v_linked_loan_id IS NOT NULL
    AND (v_loan.id IS NULL OR v_loan.id IS DISTINCT FROM v_linked_loan_id) THEN
    RAISE EXCEPTION 'financed_order_loan_mismatch' USING ERRCODE = '23514';
  END IF;

  -- Retries of an already completed cancellation are read-only. Existing
  -- cancelled orders with an active loan require the separate manual audit;
  -- this function deliberately does not repair historical records.
  IF v_order_status = 'cancelled' THEN
    IF v_loan.id IS NOT NULL AND NOT v_loan.is_deleted THEN
      RAISE EXCEPTION 'cancelled_order_has_active_loan' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_order_status <> 'draft' AND v_loan.id IS NULL THEN
      RAISE EXCEPTION 'financed_order_loan_missing' USING ERRCODE = '23514';
    END IF;
    IF v_loan.id IS NOT NULL AND v_loan.is_deleted AND EXISTS (
      SELECT 1 FROM public.loan_installments AS installment
      WHERE installment.loan_id = v_loan.id AND NOT installment.is_deleted
    ) THEN
      RAISE EXCEPTION 'deleted_loan_has_active_installments' USING ERRCODE = '23514';
    END IF;

    -- Order down payments can be partly reversed. Add only the exact
    -- remaining counter-entry so every original/reversal chain nets to zero.
    FOR v_order_payment IN
      SELECT * FROM public.payment_transactions AS payment
      WHERE payment.workspace_id = v_workspace_id
        AND payment.source_type = v_order_source_type
        AND payment.source_record_id = p_order_id
        AND payment.reversal_of_transaction_id IS NULL
        AND NOT payment.is_deleted
        AND payment.amount > 0
      ORDER BY payment.paid_at DESC, payment.created_at DESC, payment.id DESC
      FOR UPDATE
    LOOP
      SELECT COALESCE(SUM(ABS(reversal.amount)), 0) INTO v_reversed_amount
      FROM public.payment_transactions AS reversal
      WHERE reversal.reversal_of_transaction_id = v_order_payment.id
        AND reversal.workspace_id = v_workspace_id
        AND NOT reversal.is_deleted;
      v_remaining := v_order_payment.amount - v_reversed_amount;
      IF v_remaining < -0.0005 THEN
        RAISE EXCEPTION 'order_payment_reversal_exceeds_original' USING ERRCODE = '23514';
      END IF;
      IF v_remaining > 0.0005 THEN
        IF v_order_payment.void_id IS NOT NULL THEN
          RAISE EXCEPTION 'voided_order_payment_cannot_be_reversed' USING ERRCODE = '23514';
        END IF;
        INSERT INTO public.payment_transactions (
          id, workspace_id, source_module, source_type, source_record_id,
          source_subrecord_id, direction, amount, currency, payment_method,
          paid_at, counterparty_name, reference_label, note, created_by,
          account_id, account_name_snapshot, cashier_shift_occurrence_id,
          reversal_of_transaction_id, metadata, created_at, updated_at,
          version, is_deleted
        ) VALUES (
          gen_random_uuid(), v_workspace_id, v_order_payment.source_module,
          v_order_payment.source_type, v_order_payment.source_record_id,
          v_order_payment.source_subrecord_id, v_order_payment.direction,
          -v_remaining, v_order_payment.currency, v_order_payment.payment_method,
          now(), v_order_payment.counterparty_name,
          v_order_payment.reference_label,
          'Order ' || v_order_number || ' cancelled', auth.uid(),
          v_order_payment.account_id, v_order_payment.account_name_snapshot,
          v_order_payment.cashier_shift_occurrence_id, v_order_payment.id,
          COALESCE(v_order_payment.metadata, '{}'::jsonb)
            || jsonb_build_object('reversal', true),
          now(), now(), 1, false
        );
      END IF;
    END LOOP;

    IF v_loan.id IS NOT NULL AND NOT v_loan.is_deleted THEN
      -- The existing loan helper enforces latest-first reversals and writes
      -- linked cash/account counter-entries before the loan is removed.
      FOR v_loan_payment IN
        SELECT * FROM public.loan_payments AS payment
        WHERE payment.workspace_id = v_workspace_id
          AND payment.loan_id = v_loan.id AND NOT payment.is_deleted
        ORDER BY payment.paid_at DESC, payment.created_at DESC, payment.id DESC
      LOOP
        SELECT transaction.id INTO v_loan_transaction_id
        FROM public.payment_transactions AS transaction
        WHERE transaction.workspace_id = v_workspace_id
          AND transaction.source_module = 'loans'
          AND transaction.source_record_id = v_loan.id
          AND transaction.reversal_of_transaction_id IS NULL
          AND NOT transaction.is_deleted
          AND (
            transaction.id = v_loan_payment.payment_transaction_id
            OR transaction.metadata->>'loanPaymentId' = v_loan_payment.id::text
            OR (transaction.source_type <> 'loan_installment'
              AND transaction.source_subrecord_id = v_loan_payment.id)
          )
        ORDER BY (transaction.id = v_loan_payment.payment_transaction_id) DESC,
          transaction.created_at DESC
        LIMIT 1;
        IF v_loan_transaction_id IS NULL THEN
          RAISE EXCEPTION 'loan_payment_transaction_missing' USING ERRCODE = '23514';
        END IF;
        PERFORM private.reverse_loan_payment(jsonb_build_object(
          'workspace_id', v_workspace_id,
          'original_transaction_id', v_loan_transaction_id,
          'reversal_transaction_id', gen_random_uuid(),
          'paid_at', now(),
          'note', 'Order ' || v_order_number || ' cancelled',
          'created_by', auth.uid()
        ));
      END LOOP;

      IF EXISTS (
        SELECT 1 FROM public.loan_payments AS payment
        WHERE payment.loan_id = v_loan.id AND NOT payment.is_deleted
      ) THEN
        RAISE EXCEPTION 'loan_payments_remain_after_cancellation' USING ERRCODE = '23514';
      END IF;

      SELECT COUNT(*) INTO v_active_installments
      FROM public.loan_installments AS installment
      WHERE installment.loan_id = v_loan.id AND NOT installment.is_deleted;
      UPDATE public.loan_installments AS installment
      SET is_deleted = true, updated_at = now(), version = installment.version + 1
      WHERE installment.loan_id = v_loan.id AND NOT installment.is_deleted;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> v_active_installments THEN
        RAISE EXCEPTION 'loan_installment_cancellation_incomplete' USING ERRCODE = '23514';
      END IF;

      UPDATE public.loans AS loan
      SET is_deleted = true, updated_at = now(), version = loan.version + 1
      WHERE loan.id = v_loan.id AND NOT loan.is_deleted;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'loan_cancellation_incomplete' USING ERRCODE = '23514';
      END IF;
    END IF;

    IF p_order_type = 'sales' THEN
      UPDATE crm.sales_orders AS sales_order
      SET status = 'cancelled', linked_loan_id = NULL,
          is_paid = false, payment_status = 'unpaid', paid_amount = 0,
          balance_amount = GREATEST(COALESCE(sales_order.total, 0), 0),
          paid_at = NULL, initial_payment_amount = 0, next_due_date = NULL,
          updated_at = now(), version = sales_order.version + 1
      WHERE sales_order.id = p_order_id AND sales_order.workspace_id = v_workspace_id;
    ELSE
      UPDATE crm.purchase_orders AS purchase_order
      SET status = 'cancelled', linked_loan_id = NULL,
          is_paid = false, payment_status = 'unpaid', paid_amount = 0,
          balance_amount = GREATEST(COALESCE(purchase_order.total, 0), 0),
          paid_at = NULL, initial_payment_amount = 0, next_due_date = NULL,
          updated_at = now(), version = purchase_order.version + 1
      WHERE purchase_order.id = p_order_id AND purchase_order.workspace_id = v_workspace_id;
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'order_cancellation_incomplete' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_loan.id IS NOT NULL THEN
    v_result := private.loan_aggregate_result(v_loan.id);
  ELSE
    v_result := jsonb_build_object(
      'loan', NULL, 'installments', '[]'::jsonb,
      'payments', '[]'::jsonb, 'transactions', '[]'::jsonb,
      'linked_order', CASE WHEN p_order_type = 'sales' THEN
        (SELECT to_jsonb(sales_order) FROM crm.sales_orders AS sales_order WHERE sales_order.id = p_order_id)
      ELSE
        (SELECT to_jsonb(purchase_order) FROM crm.purchase_orders AS purchase_order WHERE purchase_order.id = p_order_id)
      END
    );
  END IF;

  RETURN v_result || jsonb_build_object(
    'order_transactions', COALESCE((
      SELECT jsonb_agg(to_jsonb(payment) ORDER BY payment.paid_at, payment.created_at, payment.id)
      FROM public.payment_transactions AS payment
      WHERE payment.workspace_id = v_workspace_id
        AND payment.source_type = v_order_source_type
        AND payment.source_record_id = p_order_id
    ), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_order_with_financing(
  p_order_type text,
  p_order_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.cancel_order_with_financing(p_order_type, p_order_id);
$function$;

REVOKE ALL ON FUNCTION private.cancel_order_with_financing(text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.cancel_order_with_financing(text, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_order_with_financing(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_order_with_financing(text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.cancel_order_with_financing(text, uuid) IS
  'Atomically reverse financed order payments, soft-delete its order loan, and cancel the order. Does not repair historical cancelled orders.';

-- Reject any future direct status change that would recreate the orphaned
-- loan condition. The RPC deletes the loan before updating the order.
CREATE OR REPLACE FUNCTION private.guard_financed_order_cancellation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
    AND OLD.payment_method IN ('loan', 'installments') THEN
    RAISE EXCEPTION 'cancelled_financed_order_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM NEW.status
    AND (NEW.linked_loan_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.loans AS loan
      WHERE loan.workspace_id = NEW.workspace_id
        AND ((loan.source = 'order'
          AND loan.order_type = TG_ARGV[0]
          AND loan.order_id = NEW.id)
          OR loan.id = NEW.linked_loan_id)
        AND NOT loan.is_deleted
    )) THEN
    RAISE EXCEPTION 'financed_order_requires_atomic_cancellation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_financed_order_cancellation()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_financed_sales_order_cancellation ON crm.sales_orders;
CREATE TRIGGER guard_financed_sales_order_cancellation
BEFORE UPDATE OF status ON crm.sales_orders
FOR EACH ROW EXECUTE FUNCTION private.guard_financed_order_cancellation('sales');

DROP TRIGGER IF EXISTS guard_financed_purchase_order_cancellation ON crm.purchase_orders;
CREATE TRIGGER guard_financed_purchase_order_cancellation
BEFORE UPDATE OF status ON crm.purchase_orders
FOR EACH ROW EXECUTE FUNCTION private.guard_financed_order_cancellation('purchase');

NOTIFY pgrst, 'reload schema';
