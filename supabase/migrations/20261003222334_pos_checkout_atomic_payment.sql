-- Commit a POS sale and its incoming payment in one database transaction.
-- The payment triggers remain the authority for account movements and other
-- payment projections; callers only provide the optional account snapshot.
CREATE OR REPLACE FUNCTION public.complete_pos_checkout(
  payload jsonb,
  p_account_id uuid,
  p_account_name_snapshot text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_sale_id uuid;
  v_workspace_id uuid;
  v_total_amount numeric;
  v_currency text;
  v_payment_method text;
  v_origin text;
  v_paid_at timestamptz;
  v_sequence_id bigint;
  v_sale_result jsonb;
  v_sale public.sales%ROWTYPE;
  v_payment public.payment_transactions%ROWTYPE;
  v_account_name_snapshot text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_sale_id := NULLIF(pg_catalog.btrim(payload->>'id'), '')::uuid;
    v_workspace_id := NULLIF(pg_catalog.btrim(payload->>'workspace_id'), '')::uuid;
    v_total_amount := NULLIF(pg_catalog.btrim(payload->>'total_amount'), '')::numeric;
    v_currency := NULLIF(pg_catalog.btrim(payload->>'settlement_currency'), '');
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'POS checkout payload is invalid' USING ERRCODE = '22023';
  END;

  v_payment_method := NULLIF(pg_catalog.btrim(payload->>'payment_method'), '');
  v_origin := NULLIF(pg_catalog.btrim(payload->>'origin'), '');
  v_account_name_snapshot := NULLIF(pg_catalog.btrim(p_account_name_snapshot), '');

  IF v_sale_id IS NULL
    OR v_workspace_id IS NULL
    OR v_total_amount IS NULL
    OR v_total_amount < 0
    OR v_total_amount::text IN ('NaN', 'Infinity', '-Infinity')
    OR v_currency IS NULL OR v_currency NOT IN ('usd', 'iqd', 'eur', 'try')
    OR v_origin IS NULL OR v_origin NOT IN ('pos', 'instant_pos')
    OR v_payment_method IS NULL
    OR v_payment_method NOT IN ('cash', 'fib', 'qicard', 'zaincash', 'fastpay')
    OR (p_account_id IS NULL AND v_account_name_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'POS checkout payload is invalid' USING ERRCODE = '22023';
  END IF;

  -- Every item carries the same client-captured checkout time. Using it keeps
  -- payment retries stable while the sale ID remains the idempotency key.
  BEGIN
    v_paid_at := COALESCE(
      NULLIF(payload->'items'->0->>'created_at', '')::timestamptz,
      pg_catalog.transaction_timestamp()
    );
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'POS checkout timestamp is invalid' USING ERRCODE = '22023';
  END;

  -- complete_sale enforces workspace access, product rules, stock, currency,
  -- and minimum selling prices. This function's transaction also includes the
  -- payment insert, so either both records commit or neither does.
  v_sale_result := public.complete_sale(payload);
  v_sequence_id := NULLIF(v_sale_result->>'sequence_id', '')::bigint;
  IF v_sequence_id IS NULL OR v_sequence_id < 1 THEN
    RAISE EXCEPTION 'POS sale could not be confirmed' USING ERRCODE = '23514';
  END IF;

  -- complete_sale is intentionally idempotent by sale ID. Re-read its row so
  -- an idempotent replay cannot attach a different amount, currency, method,
  -- workspace, or origin as the sale's payment.
  SELECT * INTO v_sale
  FROM public.sales
  WHERE id = v_sale_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_sale.workspace_id IS DISTINCT FROM v_workspace_id
    OR v_sale.total_amount IS DISTINCT FROM v_total_amount
    OR pg_catalog.lower(v_sale.settlement_currency::text) IS DISTINCT FROM v_currency
    OR v_sale.payment_method::text IS DISTINCT FROM v_payment_method
    OR v_sale.origin::text IS DISTINCT FROM v_origin THEN
    RAISE EXCEPTION 'POS sale does not match its checkout payload' USING ERRCODE = '23514';
  END IF;

  IF v_total_amount > 0 THEN
    -- Serialize retries and older clients that still post the payment
    -- separately. The insert remains the single source of account movements.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('pos-payment:' || v_sale_id::text, 0)
    );

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
      reversal_of_transaction_id,
      metadata,
      account_id,
      account_name_snapshot
    ) VALUES (
      v_sale_id,
      v_workspace_id,
      'sales',
      'pos_sale',
      v_sale_id,
      NULL,
      'incoming',
      v_total_amount,
      v_currency,
      v_payment_method,
      v_paid_at,
      NULL,
      '#' || pg_catalog.lpad(v_sequence_id::text, 5, '0'),
      NULL,
      auth.uid(),
      NULL,
      pg_catalog.jsonb_build_object('saleId', v_sale_id, 'origin', v_origin),
      p_account_id,
      v_account_name_snapshot
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING * INTO v_payment;

    IF NOT FOUND THEN
      SELECT * INTO v_payment
      FROM public.payment_transactions
      WHERE id = v_sale_id;

      IF NOT FOUND
        OR v_payment.workspace_id IS DISTINCT FROM v_workspace_id
        OR v_payment.source_module IS DISTINCT FROM 'sales'
        OR v_payment.source_type IS DISTINCT FROM 'pos_sale'
        OR v_payment.source_record_id IS DISTINCT FROM v_sale_id
        OR v_payment.source_subrecord_id IS NOT NULL
        OR v_payment.direction IS DISTINCT FROM 'incoming'
        OR v_payment.amount IS DISTINCT FROM v_total_amount
        OR v_payment.currency IS DISTINCT FROM v_currency
        OR v_payment.payment_method IS DISTINCT FROM v_payment_method
        OR v_payment.paid_at IS DISTINCT FROM v_paid_at
        OR v_payment.account_id IS DISTINCT FROM p_account_id
        OR (v_account_name_snapshot IS NOT NULL
          AND v_payment.account_name_snapshot IS DISTINCT FROM v_account_name_snapshot)
        OR v_payment.reversal_of_transaction_id IS NOT NULL
        OR COALESCE(v_payment.is_deleted, false) THEN
        RAISE EXCEPTION 'POS payment idempotency conflict' USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN v_sale_result || pg_catalog.jsonb_build_object(
      'payment_transaction', pg_catalog.to_jsonb(v_payment)
    );
  END IF;

  RETURN v_sale_result || pg_catalog.jsonb_build_object('payment_transaction', NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_pos_checkout(jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_pos_checkout(jsonb, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_pos_checkout(jsonb, uuid, text) IS
  'Atomically completes a POS or Instant POS sale and posts its idempotent incoming payment.';
