-- Serialize order payment writes at the database boundary.  The order row is
-- the lock shared by online settlement RPCs and offline mutation replay.
CREATE OR REPLACE FUNCTION public.prevent_order_payment_overpayment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing public.payment_transactions%ROWTYPE;
  v_order_total numeric;
  v_installment_total numeric;
  v_current_paid numeric;
  v_installment_paid numeric;
BEGIN
  IF NEW.source_type NOT IN ('sales_order', 'purchase_order')
    OR NEW.amount <= 0
    OR NEW.reversal_of_transaction_id IS NOT NULL
    OR NEW.is_deleted
    OR NEW.void_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- PostgREST upserts are used by offline replay. Permit a retry of the same
  -- transaction identity, but reject attempts to reuse its ID for another
  -- payment intent.
  SELECT payment.* INTO v_existing
  FROM public.payment_transactions AS payment
  WHERE payment.id = NEW.id;
  IF FOUND THEN
    IF v_existing.workspace_id IS DISTINCT FROM NEW.workspace_id
      OR v_existing.source_type IS DISTINCT FROM NEW.source_type
      OR v_existing.source_record_id IS DISTINCT FROM NEW.source_record_id
      OR v_existing.source_subrecord_id IS DISTINCT FROM NEW.source_subrecord_id
      OR v_existing.direction IS DISTINCT FROM NEW.direction
      OR v_existing.amount IS DISTINCT FROM NEW.amount
      OR v_existing.currency IS DISTINCT FROM NEW.currency
      OR v_existing.payment_method IS DISTINCT FROM NEW.payment_method
      OR v_existing.paid_at IS DISTINCT FROM NEW.paid_at
      OR v_existing.reversal_of_transaction_id IS DISTINCT FROM NEW.reversal_of_transaction_id THEN
      RAISE EXCEPTION 'order_payment_idempotency_conflict' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_type = 'sales_order' THEN
    SELECT sales_order.total INTO v_order_total
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.id = NEW.source_record_id
      AND sales_order.workspace_id = NEW.workspace_id
      AND NOT COALESCE(sales_order.is_deleted, false)
    FOR UPDATE;
  ELSE
    SELECT purchase_order.total INTO v_order_total
    FROM crm.purchase_orders AS purchase_order
    WHERE purchase_order.id = NEW.source_record_id
      AND purchase_order.workspace_id = NEW.workspace_id
      AND NOT COALESCE(purchase_order.is_deleted, false)
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_payment_source_not_found' USING ERRCODE = '23503';
  END IF;

  -- Recheck under the order lock so simultaneous offline upsert retries with
  -- the same payment ID resolve to one persisted payment as well.
  SELECT payment.* INTO v_existing
  FROM public.payment_transactions AS payment
  WHERE payment.id = NEW.id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.workspace_id IS DISTINCT FROM NEW.workspace_id
      OR v_existing.source_type IS DISTINCT FROM NEW.source_type
      OR v_existing.source_record_id IS DISTINCT FROM NEW.source_record_id
      OR v_existing.source_subrecord_id IS DISTINCT FROM NEW.source_subrecord_id
      OR v_existing.direction IS DISTINCT FROM NEW.direction
      OR v_existing.amount IS DISTINCT FROM NEW.amount
      OR v_existing.currency IS DISTINCT FROM NEW.currency
      OR v_existing.payment_method IS DISTINCT FROM NEW.payment_method
      OR v_existing.paid_at IS DISTINCT FROM NEW.paid_at
      OR v_existing.reversal_of_transaction_id IS DISTINCT FROM NEW.reversal_of_transaction_id THEN
      RAISE EXCEPTION 'order_payment_idempotency_conflict' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_subrecord_id IS NOT NULL THEN
    SELECT installment.planned_amount INTO v_installment_total
    FROM crm.order_installments AS installment
    WHERE installment.id = NEW.source_subrecord_id
      AND installment.workspace_id = NEW.workspace_id
      AND installment.order_id = NEW.source_record_id
      AND installment.order_type = CASE NEW.source_type
        WHEN 'sales_order' THEN 'sales' ELSE 'purchase' END
      AND NOT installment.is_deleted
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_payment_installment_not_found' USING ERRCODE = '23503';
    END IF;

    SELECT COALESCE(SUM(GREATEST(original.amount - COALESCE(reversals.amount, 0), 0)), 0)
    INTO v_installment_paid
    FROM public.payment_transactions AS original
    LEFT JOIN LATERAL (
      SELECT SUM(ABS(reversal.amount)) AS amount
      FROM public.payment_transactions AS reversal
      WHERE reversal.reversal_of_transaction_id = original.id
        AND reversal.workspace_id = NEW.workspace_id
        AND NOT COALESCE(reversal.is_deleted, false)
        AND reversal.void_id IS NULL
    ) AS reversals ON true
    WHERE original.workspace_id = NEW.workspace_id
      AND original.source_type = NEW.source_type
      AND original.source_record_id = NEW.source_record_id
      AND original.source_subrecord_id = NEW.source_subrecord_id
      AND original.reversal_of_transaction_id IS NULL
      AND original.amount > 0
      AND NOT COALESCE(original.is_deleted, false)
      AND original.void_id IS NULL;

    IF v_installment_paid + NEW.amount > COALESCE(v_installment_total, 0) + 0.0005 THEN
      RAISE EXCEPTION 'order_installment_payment_exceeds_remaining_balance' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A payment reversal is a linked negative counter-entry. Count each active
  -- original only for its remaining unreversed amount.
  SELECT COALESCE(SUM(GREATEST(original.amount - COALESCE(reversals.amount, 0), 0)), 0)
  INTO v_current_paid
  FROM public.payment_transactions AS original
  LEFT JOIN LATERAL (
    SELECT SUM(ABS(reversal.amount)) AS amount
    FROM public.payment_transactions AS reversal
    WHERE reversal.reversal_of_transaction_id = original.id
      AND reversal.workspace_id = NEW.workspace_id
      AND NOT COALESCE(reversal.is_deleted, false)
      AND reversal.void_id IS NULL
  ) AS reversals ON true
  WHERE original.workspace_id = NEW.workspace_id
    AND original.source_type = NEW.source_type
    AND original.source_record_id = NEW.source_record_id
    AND original.reversal_of_transaction_id IS NULL
    AND original.amount > 0
    AND NOT COALESCE(original.is_deleted, false)
    AND original.void_id IS NULL;

  IF v_current_paid + NEW.amount > COALESCE(v_order_total, 0) + 0.0005 THEN
    RAISE EXCEPTION 'order_payment_exceeds_remaining_balance' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS payment_transactions_prevent_order_overpayment
  ON public.payment_transactions;
CREATE TRIGGER payment_transactions_prevent_order_overpayment
  BEFORE INSERT ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_order_payment_overpayment();

REVOKE ALL ON FUNCTION public.prevent_order_payment_overpayment() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_order_payment(p_transaction jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_payment public.payment_transactions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_order_total numeric;
  v_order_currency text;
  v_order_is_deleted boolean;
  v_order_is_locked boolean;
  v_order_payment_method text;
  v_order_linked_loan_id uuid;
  v_current_paid numeric;
  v_installment_total numeric;
  v_installment_paid numeric;
  v_saved public.payment_transactions%ROWTYPE;
BEGIN
  v_payment := pg_catalog.jsonb_populate_record(
    NULL::public.payment_transactions,
    p_transaction
  );

  IF auth.uid() IS NULL
    OR v_payment.workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR COALESCE(public.current_user_role(), '') NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'order_payment_workspace_access_denied' USING ERRCODE = '42501';
  END IF;

  IF v_payment.id IS NULL
    OR v_payment.source_module IS DISTINCT FROM 'orders'
    OR v_payment.source_type NOT IN ('sales_order', 'purchase_order')
    OR v_payment.source_record_id IS NULL
    OR v_payment.amount IS NULL
    OR v_payment.amount <= 0
    OR v_payment.reversal_of_transaction_id IS NOT NULL
    OR v_payment.is_deleted
    OR v_payment.void_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_order_payment_payload' USING ERRCODE = '23514';
  END IF;

  IF (v_payment.source_type = 'sales_order' AND v_payment.direction <> 'incoming')
    OR (v_payment.source_type = 'purchase_order' AND v_payment.direction <> 'outgoing') THEN
    RAISE EXCEPTION 'invalid_order_payment_direction' USING ERRCODE = '23514';
  END IF;

  -- Fast path for an already committed operation, including a retry after the
  -- order has since changed state.
  SELECT payment.* INTO v_existing
  FROM public.payment_transactions AS payment
  WHERE payment.id = v_payment.id;
  IF FOUND THEN
    IF v_existing.workspace_id IS DISTINCT FROM v_payment.workspace_id
      OR v_existing.source_type IS DISTINCT FROM v_payment.source_type
      OR v_existing.source_record_id IS DISTINCT FROM v_payment.source_record_id
      OR v_existing.source_subrecord_id IS DISTINCT FROM v_payment.source_subrecord_id
      OR v_existing.direction IS DISTINCT FROM v_payment.direction
      OR v_existing.amount IS DISTINCT FROM v_payment.amount
      OR v_existing.currency IS DISTINCT FROM v_payment.currency
      OR v_existing.payment_method IS DISTINCT FROM v_payment.payment_method
      OR v_existing.paid_at IS DISTINCT FROM v_payment.paid_at
      OR v_existing.reversal_of_transaction_id IS DISTINCT FROM v_payment.reversal_of_transaction_id THEN
      RAISE EXCEPTION 'order_payment_idempotency_conflict' USING ERRCODE = '23514';
    END IF;
    RETURN pg_catalog.to_jsonb(v_existing);
  END IF;

  IF v_payment.source_type = 'sales_order' THEN
    SELECT sales_order.total, sales_order.currency, sales_order.is_deleted,
      COALESCE((pg_catalog.to_jsonb(sales_order)->>'is_locked')::boolean, false),
      sales_order.payment_method, sales_order.linked_loan_id
    INTO v_order_total, v_order_currency, v_order_is_deleted,
      v_order_is_locked, v_order_payment_method, v_order_linked_loan_id
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.id = v_payment.source_record_id
      AND sales_order.workspace_id = v_payment.workspace_id
    FOR UPDATE;
  ELSE
    SELECT purchase_order.total, purchase_order.currency, purchase_order.is_deleted,
      COALESCE((pg_catalog.to_jsonb(purchase_order)->>'is_locked')::boolean, false),
      purchase_order.payment_method, purchase_order.linked_loan_id
    INTO v_order_total, v_order_currency, v_order_is_deleted,
      v_order_is_locked, v_order_payment_method, v_order_linked_loan_id
    FROM crm.purchase_orders AS purchase_order
    WHERE purchase_order.id = v_payment.source_record_id
      AND purchase_order.workspace_id = v_payment.workspace_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND OR COALESCE(v_order_is_deleted, true) THEN
    RAISE EXCEPTION 'order_payment_source_not_found' USING ERRCODE = '23503';
  END IF;

  -- Recheck after acquiring the shared order lock. This closes the race where
  -- two retries with the same operation ID arrive before either one commits.
  SELECT payment.* INTO v_existing
  FROM public.payment_transactions AS payment
  WHERE payment.id = v_payment.id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.workspace_id IS DISTINCT FROM v_payment.workspace_id
      OR v_existing.source_type IS DISTINCT FROM v_payment.source_type
      OR v_existing.source_record_id IS DISTINCT FROM v_payment.source_record_id
      OR v_existing.source_subrecord_id IS DISTINCT FROM v_payment.source_subrecord_id
      OR v_existing.direction IS DISTINCT FROM v_payment.direction
      OR v_existing.amount IS DISTINCT FROM v_payment.amount
      OR v_existing.currency IS DISTINCT FROM v_payment.currency
      OR v_existing.payment_method IS DISTINCT FROM v_payment.payment_method
      OR v_existing.paid_at IS DISTINCT FROM v_payment.paid_at
      OR v_existing.reversal_of_transaction_id IS DISTINCT FROM v_payment.reversal_of_transaction_id THEN
      RAISE EXCEPTION 'order_payment_idempotency_conflict' USING ERRCODE = '23514';
    END IF;
    RETURN pg_catalog.to_jsonb(v_existing);
  END IF;

  IF COALESCE(v_order_is_locked, false) THEN
    RAISE EXCEPTION 'locked_order_immutable' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_order_payment_method, '') IN ('loan', 'installments')
    OR v_order_linked_loan_id IS NOT NULL THEN
    RAISE EXCEPTION 'financed_order_payments_managed_in_loan_module' USING ERRCODE = '23514';
  END IF;
  IF v_payment.currency IS DISTINCT FROM v_order_currency THEN
    RAISE EXCEPTION 'order_payment_currency_mismatch' USING ERRCODE = '23514';
  END IF;

  IF v_payment.source_subrecord_id IS NOT NULL THEN
    SELECT installment.planned_amount INTO v_installment_total
    FROM crm.order_installments AS installment
    WHERE installment.id = v_payment.source_subrecord_id
      AND installment.workspace_id = v_payment.workspace_id
      AND installment.order_id = v_payment.source_record_id
      AND installment.order_type = CASE v_payment.source_type
        WHEN 'sales_order' THEN 'sales' ELSE 'purchase' END
      AND NOT installment.is_deleted
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_payment_installment_not_found' USING ERRCODE = '23503';
    END IF;

    SELECT COALESCE(SUM(GREATEST(original.amount - COALESCE(reversals.amount, 0), 0)), 0)
    INTO v_installment_paid
    FROM public.payment_transactions AS original
    LEFT JOIN LATERAL (
      SELECT SUM(ABS(reversal.amount)) AS amount
      FROM public.payment_transactions AS reversal
      WHERE reversal.reversal_of_transaction_id = original.id
        AND reversal.workspace_id = v_payment.workspace_id
        AND NOT COALESCE(reversal.is_deleted, false)
        AND reversal.void_id IS NULL
    ) AS reversals ON true
    WHERE original.workspace_id = v_payment.workspace_id
      AND original.source_type = v_payment.source_type
      AND original.source_record_id = v_payment.source_record_id
      AND original.source_subrecord_id = v_payment.source_subrecord_id
      AND original.reversal_of_transaction_id IS NULL
      AND original.amount > 0
      AND NOT COALESCE(original.is_deleted, false)
      AND original.void_id IS NULL;

    IF v_installment_paid + v_payment.amount > COALESCE(v_installment_total, 0) + 0.0005 THEN
      RAISE EXCEPTION 'order_installment_payment_exceeds_remaining_balance' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COALESCE(SUM(GREATEST(original.amount - COALESCE(reversals.amount, 0), 0)), 0)
  INTO v_current_paid
  FROM public.payment_transactions AS original
  LEFT JOIN LATERAL (
    SELECT SUM(ABS(reversal.amount)) AS amount
    FROM public.payment_transactions AS reversal
    WHERE reversal.reversal_of_transaction_id = original.id
      AND reversal.workspace_id = v_payment.workspace_id
      AND NOT COALESCE(reversal.is_deleted, false)
      AND reversal.void_id IS NULL
  ) AS reversals ON true
  WHERE original.workspace_id = v_payment.workspace_id
    AND original.source_type = v_payment.source_type
    AND original.source_record_id = v_payment.source_record_id
    AND original.reversal_of_transaction_id IS NULL
    AND original.amount > 0
    AND NOT COALESCE(original.is_deleted, false)
    AND original.void_id IS NULL;

  IF v_current_paid + v_payment.amount > COALESCE(v_order_total, 0) + 0.0005 THEN
    RAISE EXCEPTION 'order_payment_exceeds_remaining_balance' USING ERRCODE = '23514';
  END IF;

  v_payment.created_at := COALESCE(v_payment.created_at, pg_catalog.now());
  v_payment.updated_at := COALESCE(v_payment.updated_at, pg_catalog.now());
  v_payment.version := COALESCE(v_payment.version, 1);
  v_payment.is_deleted := false;
  INSERT INTO public.payment_transactions
  SELECT (v_payment).* RETURNING * INTO v_saved;

  RETURN pg_catalog.to_jsonb(v_saved);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_order_payment(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_order_payment(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
