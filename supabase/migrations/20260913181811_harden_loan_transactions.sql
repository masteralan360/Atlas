-- Loan hardening is deliberately additive. Existing rows keep integrity_version = 0
-- and are not rewritten; every row created by the new RPCs is version 1 and is
-- protected by the stricter constraints below.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;

ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS origination_transaction_id uuid NULL,
  ADD COLUMN IF NOT EXISTS terms_locked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS integrity_version smallint NOT NULL DEFAULT 0;

ALTER TABLE public.loan_installments
  ADD COLUMN IF NOT EXISTS integrity_version smallint NOT NULL DEFAULT 0;

ALTER TABLE public.loan_payments
  ADD COLUMN IF NOT EXISTS sequence_no integer NULL,
  ADD COLUMN IF NOT EXISTS payment_transaction_id uuid NULL,
  ADD COLUMN IF NOT EXISTS reversed_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reversal_transaction_id uuid NULL,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reversed_by uuid NULL,
  ADD COLUMN IF NOT EXISTS integrity_version smallint NOT NULL DEFAULT 0;

ALTER TABLE public.loan_payments
  DROP CONSTRAINT IF EXISTS loan_payments_payment_method_check;
ALTER TABLE public.loan_payments
  ADD CONSTRAINT loan_payments_payment_method_check
  CHECK (payment_method IN (
    'cash', 'fib', 'qicard', 'zaincash', 'fastpay',
    'bank_transfer', 'loan_adjustment'
  ));

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loans_origination_transaction_id_fkey'
      AND conrelid = 'public.loans'::regclass
  ) THEN
    ALTER TABLE public.loans
      ADD CONSTRAINT loans_origination_transaction_id_fkey
      FOREIGN KEY (origination_transaction_id)
      REFERENCES public.payment_transactions(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loan_payments_payment_transaction_id_fkey'
      AND conrelid = 'public.loan_payments'::regclass
  ) THEN
    ALTER TABLE public.loan_payments
      ADD CONSTRAINT loan_payments_payment_transaction_id_fkey
      FOREIGN KEY (payment_transaction_id)
      REFERENCES public.payment_transactions(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loan_payments_reversal_transaction_id_fkey'
      AND conrelid = 'public.loan_payments'::regclass
  ) THEN
    ALTER TABLE public.loan_payments
      ADD CONSTRAINT loan_payments_reversal_transaction_id_fkey
      FOREIGN KEY (reversal_transaction_id)
      REFERENCES public.payment_transactions(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loan_payments_reversed_by_fkey'
      AND conrelid = 'public.loan_payments'::regclass
  ) THEN
    ALTER TABLE public.loan_payments
      ADD CONSTRAINT loan_payments_reversed_by_fkey
      FOREIGN KEY (reversed_by)
      REFERENCES auth.users(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END;
$block$;

ALTER TABLE public.loans VALIDATE CONSTRAINT loans_origination_transaction_id_fkey;
ALTER TABLE public.loan_payments VALIDATE CONSTRAINT loan_payments_payment_transaction_id_fkey;
ALTER TABLE public.loan_payments VALIDATE CONSTRAINT loan_payments_reversal_transaction_id_fkey;
ALTER TABLE public.loan_payments VALIDATE CONSTRAINT loan_payments_reversed_by_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS loans_active_pos_sale_unique
  ON public.loans (workspace_id, sale_id)
  WHERE source = 'pos' AND sale_id IS NOT NULL AND is_deleted = false;

DROP INDEX IF EXISTS public.idx_loan_installments_loan_no_unique;
CREATE UNIQUE INDEX IF NOT EXISTS loan_installments_active_number_unique
  ON public.loan_installments (loan_id, installment_no)
  WHERE is_deleted = false;

CREATE UNIQUE INDEX IF NOT EXISTS loans_origination_transaction_unique
  ON public.loans (origination_transaction_id)
  WHERE origination_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS loan_payments_payment_transaction_unique
  ON public.loan_payments (payment_transaction_id)
  WHERE payment_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS loan_payments_reversal_transaction_unique
  ON public.loan_payments (reversal_transaction_id)
  WHERE reversal_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS loan_payments_sequence_unique
  ON public.loan_payments (loan_id, sequence_no)
  WHERE sequence_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_transactions_active_loan_origination_idx
  ON public.payment_transactions (workspace_id, source_record_id, created_at)
  WHERE source_module = 'loans'
    AND source_type = 'loan_origination'
    AND reversal_of_transaction_id IS NULL
    AND is_deleted = false;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loans_v1_amounts_check'
      AND conrelid = 'public.loans'::regclass
  ) THEN
    ALTER TABLE public.loans ADD CONSTRAINT loans_v1_amounts_check CHECK (
      integrity_version = 0 OR (
        principal_amount >= 0
        AND total_paid_amount >= 0
        AND balance_amount >= 0
        AND (
          status = 'cancelled'
          OR abs(principal_amount - total_paid_amount - balance_amount) <= 0.0005
        )
        AND (
          status = 'cancelled'
          OR (balance_amount = 0 AND status = 'completed')
          OR (balance_amount > 0 AND status IN ('active', 'overdue'))
        )
      )
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loan_installments_v1_amounts_check'
      AND conrelid = 'public.loan_installments'::regclass
  ) THEN
    ALTER TABLE public.loan_installments ADD CONSTRAINT loan_installments_v1_amounts_check CHECK (
      integrity_version = 0 OR (
        installment_no > 0
        AND planned_amount >= 0
        AND paid_amount >= 0
        AND balance_amount >= 0
        AND (
          status = 'cancelled'
          OR abs(planned_amount - paid_amount - balance_amount) <= 0.0005
        )
        AND (
          status = 'cancelled'
          OR (balance_amount = 0 AND status = 'paid')
          OR (balance_amount > 0 AND paid_amount > 0 AND status = 'partial')
          OR (balance_amount > 0 AND paid_amount = 0 AND status IN ('unpaid', 'overdue'))
        )
      )
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'loan_payments_v1_integrity_check'
      AND conrelid = 'public.loan_payments'::regclass
  ) THEN
    ALTER TABLE public.loan_payments ADD CONSTRAINT loan_payments_v1_integrity_check CHECK (
      integrity_version = 0 OR (
        sequence_no > 0
        AND amount > 0
        AND payment_transaction_id IS NOT NULL
        AND reversed_amount >= 0
        AND reversed_amount <= amount
        AND (
          (reversed_amount = 0 AND reversal_transaction_id IS NULL AND reversed_at IS NULL)
          OR
          (reversed_amount = amount AND reversal_transaction_id IS NOT NULL AND reversed_at IS NOT NULL)
        )
      )
    ) NOT VALID;
  END IF;
END;
$block$;

ALTER TABLE public.loans VALIDATE CONSTRAINT loans_v1_amounts_check;
ALTER TABLE public.loan_installments VALIDATE CONSTRAINT loan_installments_v1_amounts_check;
ALTER TABLE public.loan_payments VALIDATE CONSTRAINT loan_payments_v1_integrity_check;

CREATE OR REPLACE FUNCTION private.validate_loan_amount_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_old_mismatch numeric := 0;
  v_new_mismatch numeric := 0;
BEGIN
  IF NEW.principal_amount < 0 OR NEW.total_paid_amount < 0 OR NEW.balance_amount < 0 THEN
    RAISE EXCEPTION 'Loan amounts cannot be negative' USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> 'cancelled' THEN
    v_new_mismatch := abs(NEW.principal_amount - NEW.total_paid_amount - NEW.balance_amount);
    IF TG_OP = 'INSERT' AND v_new_mismatch > 0.0005 THEN
      RAISE EXCEPTION 'Loan principal must equal paid amount plus balance' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' THEN
      v_old_mismatch := abs(OLD.principal_amount - OLD.total_paid_amount - OLD.balance_amount);
      IF v_new_mismatch > 0.0005 AND v_new_mismatch > v_old_mismatch + 0.0005 THEN
        RAISE EXCEPTION 'A loan arithmetic mismatch cannot be introduced or worsened' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.validate_loan_installment_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_old_mismatch numeric := 0;
  v_new_mismatch numeric := 0;
BEGIN
  IF NEW.installment_no <= 0
    OR NEW.planned_amount < 0
    OR NEW.paid_amount < 0
    OR NEW.balance_amount < 0
  THEN
    RAISE EXCEPTION 'Loan installment amounts cannot be negative' USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> 'cancelled' THEN
    v_new_mismatch := abs(NEW.planned_amount - NEW.paid_amount - NEW.balance_amount);
    IF TG_OP = 'INSERT' AND v_new_mismatch > 0.0005 THEN
      RAISE EXCEPTION 'Installment planned amount must equal paid amount plus balance' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' THEN
      v_old_mismatch := abs(OLD.planned_amount - OLD.paid_amount - OLD.balance_amount);
      IF v_new_mismatch > 0.0005 AND v_new_mismatch > v_old_mismatch + 0.0005 THEN
        RAISE EXCEPTION 'An installment arithmetic mismatch cannot be introduced or worsened' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.protect_locked_loan_terms()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.terms_locked_at IS NOT NULL AND (
    NEW.source IS DISTINCT FROM OLD.source
    OR NEW.loan_category IS DISTINCT FROM OLD.loan_category
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.settlement_currency IS DISTINCT FROM OLD.settlement_currency
    OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.order_type IS DISTINCT FROM OLD.order_type
  ) THEN
    RAISE EXCEPTION 'Posted loan identity and currency are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_loan_amount_transition ON public.loans;
CREATE TRIGGER validate_loan_amount_transition
BEFORE INSERT OR UPDATE OF principal_amount, total_paid_amount, balance_amount, status
ON public.loans FOR EACH ROW
EXECUTE FUNCTION private.validate_loan_amount_transition();

DROP TRIGGER IF EXISTS validate_loan_installment_transition ON public.loan_installments;
CREATE TRIGGER validate_loan_installment_transition
BEFORE INSERT OR UPDATE OF installment_no, planned_amount, paid_amount, balance_amount, status
ON public.loan_installments FOR EACH ROW
EXECUTE FUNCTION private.validate_loan_installment_transition();

DROP TRIGGER IF EXISTS protect_locked_loan_terms ON public.loans;
CREATE TRIGGER protect_locked_loan_terms
BEFORE UPDATE ON public.loans FOR EACH ROW
EXECUTE FUNCTION private.protect_locked_loan_terms();

CREATE OR REPLACE FUNCTION private.assert_loan_write_access(
  p_workspace_id uuid,
  p_module text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_jwt_role text := COALESCE(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  );
  v_plan text;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Workspace is required' USING ERRCODE = '22023';
  END IF;

  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
    END IF;
    IF p_workspace_id IS DISTINCT FROM public.current_workspace_id()
      OR public.current_user_role() NOT IN ('admin', 'staff')
    THEN
      RAISE EXCEPTION 'You are not allowed to change loans in this workspace'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT workspace.plan::text
  INTO v_plan
  FROM public.workspaces AS workspace
  WHERE workspace.id = p_workspace_id;

  IF v_plan IS NULL OR NOT COALESCE(
    public.workspace_module_allowed(p_workspace_id, v_plan, p_module),
    false
  ) THEN
    RAISE EXCEPTION 'The requested loan module is not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION private.loan_aggregate_result(p_loan_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'loan', pg_catalog.to_jsonb(loan),
    'installments', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(installment) ORDER BY installment.installment_no)
      FROM public.loan_installments AS installment
      WHERE installment.loan_id = loan.id
    ), '[]'::jsonb),
    'payments', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(payment) ORDER BY payment.paid_at, payment.created_at, payment.id)
      FROM public.loan_payments AS payment
      WHERE payment.loan_id = loan.id
    ), '[]'::jsonb),
    'transactions', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(transaction) ORDER BY transaction.paid_at, transaction.created_at, transaction.id)
      FROM public.payment_transactions AS transaction
      WHERE transaction.workspace_id = loan.workspace_id
        AND transaction.source_module = 'loans'
        AND transaction.source_record_id = loan.id
    ), '[]'::jsonb),
    'linked_order', CASE
      WHEN loan.source = 'order' AND loan.order_type = 'sales' THEN (
        SELECT pg_catalog.to_jsonb(sales_order)
        FROM crm.sales_orders AS sales_order
        WHERE sales_order.id = loan.order_id
      )
      WHEN loan.source = 'order' AND loan.order_type = 'purchase' THEN (
        SELECT pg_catalog.to_jsonb(purchase_order)
        FROM crm.purchase_orders AS purchase_order
        WHERE purchase_order.id = loan.order_id
      )
      ELSE NULL
    END
  )
  FROM public.loans AS loan
  WHERE loan.id = p_loan_id;
$function$;

CREATE OR REPLACE FUNCTION private.create_loan_aggregate(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid;
  v_loan_id uuid;
  v_sale_id uuid;
  v_source text;
  v_category text;
  v_direction text;
  v_linked_party_id uuid;
  v_linked_party_name text;
  v_borrower_name text;
  v_borrower_phone text;
  v_borrower_address text;
  v_borrower_national_id text;
  v_principal numeric;
  v_currency text;
  v_exchange_rates jsonb;
  v_installment_count integer;
  v_frequency text;
  v_first_due_date date;
  v_created_at timestamptz;
  v_created_by uuid;
  v_notes text;
  v_account_id uuid;
  v_account_name text;
  v_cashier_shift_occurrence_id uuid;
  v_origination_transaction_id uuid;
  v_loan_no text;
  v_module text;
  v_base numeric;
  v_planned numeric;
  v_due_date date;
  v_installment_id uuid;
  v_index integer;
  v_partner crm.business_partners%ROWTYPE;
  v_credit_limit numeric;
  v_credit_usage numeric := 0;
  v_converted_principal numeric;
BEGIN
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Loan payload must be an object' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_workspace_id := NULLIF(pg_catalog.btrim(p_payload->>'workspace_id'), '')::uuid;
    v_loan_id := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'id'), '')::uuid, gen_random_uuid());
    v_sale_id := NULLIF(pg_catalog.btrim(p_payload->>'sale_id'), '')::uuid;
    v_linked_party_id := NULLIF(pg_catalog.btrim(p_payload->>'linked_party_id'), '')::uuid;
    v_account_id := NULLIF(pg_catalog.btrim(p_payload->>'account_id'), '')::uuid;
    v_cashier_shift_occurrence_id := NULLIF(pg_catalog.btrim(p_payload->>'cashier_shift_occurrence_id'), '')::uuid;
    v_created_by := NULLIF(pg_catalog.btrim(p_payload->>'created_by'), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Loan payload contains an invalid identifier' USING ERRCODE = '22023';
  END;

  v_source := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'source'), ''), 'manual');
  v_category := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'loan_category'), ''), 'standard');
  v_direction := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'direction'), ''), 'lent');
  v_linked_party_name := NULLIF(pg_catalog.btrim(p_payload->>'linked_party_name'), '');
  v_borrower_name := NULLIF(pg_catalog.btrim(p_payload->>'borrower_name'), '');
  v_borrower_phone := COALESCE(pg_catalog.btrim(p_payload->>'borrower_phone'), '');
  v_borrower_address := COALESCE(pg_catalog.btrim(p_payload->>'borrower_address'), '');
  v_borrower_national_id := COALESCE(pg_catalog.btrim(p_payload->>'borrower_national_id'), '');
  v_principal := round(COALESCE((p_payload->>'principal_amount')::numeric, 0), 3);
  v_currency := lower(COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'settlement_currency'), ''), 'usd'));
  v_exchange_rates := CASE WHEN pg_catalog.jsonb_typeof(p_payload->'exchange_rate_snapshot') = 'array'
    THEN p_payload->'exchange_rate_snapshot' ELSE NULL END;
  v_installment_count := GREATEST(COALESCE((p_payload->>'installment_count')::integer, 1), 1);
  v_frequency := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'installment_frequency'), ''), 'monthly');
  v_first_due_date := NULLIF(pg_catalog.btrim(p_payload->>'first_due_date'), '')::date;
  v_created_at := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'created_at'), '')::timestamptz, now());
  v_notes := NULLIF(pg_catalog.btrim(p_payload->>'notes'), '');
  v_account_name := NULLIF(pg_catalog.btrim(p_payload->>'account_name_snapshot'), '');

  IF v_source NOT IN ('manual', 'pos') THEN
    RAISE EXCEPTION 'This endpoint only creates manual and POS loans' USING ERRCODE = '22023';
  END IF;
  IF v_source = 'pos' AND v_sale_id IS NULL THEN
    RAISE EXCEPTION 'A POS loan requires its sale' USING ERRCODE = '22023';
  END IF;
  IF v_source = 'manual' AND v_sale_id IS NOT NULL THEN
    RAISE EXCEPTION 'A manual loan cannot be linked to a sale' USING ERRCODE = '22023';
  END IF;
  IF v_category NOT IN ('simple', 'standard') OR v_direction NOT IN ('lent', 'borrowed') THEN
    RAISE EXCEPTION 'Loan category or direction is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_frequency NOT IN ('daily', 'weekly', 'biweekly', 'monthly') THEN
    RAISE EXCEPTION 'Installment frequency is invalid' USING ERRCODE = '22023';
  END IF;
  IF v_principal <= 0 OR v_borrower_name IS NULL THEN
    RAISE EXCEPTION 'Loan principal and counterparty are required' USING ERRCODE = '22023';
  END IF;
  IF v_category = 'standard' AND v_source = 'manual'
    AND (v_borrower_phone = '' OR v_borrower_address = '')
  THEN
    RAISE EXCEPTION 'Standard manual loans require phone and address' USING ERRCODE = '22023';
  END IF;
  IF v_category = 'simple' THEN
    v_installment_count := 1;
  END IF;

  v_module := CASE WHEN v_category = 'simple' THEN 'loans' ELSE 'installments' END;
  PERFORM private.assert_loan_write_access(v_workspace_id, v_module);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('loan-create:' || v_loan_id::text, 0)
  );

  IF EXISTS (SELECT 1 FROM public.loans WHERE id = v_loan_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.loans
      WHERE id = v_loan_id
        AND workspace_id = v_workspace_id
        AND source = v_source
        AND sale_id IS NOT DISTINCT FROM v_sale_id
        AND principal_amount = v_principal
        AND settlement_currency = v_currency
    ) THEN
      RAISE EXCEPTION 'Loan operation id is already used by another payload'
        USING ERRCODE = '23505';
    END IF;
    RETURN private.loan_aggregate_result(v_loan_id);
  END IF;

  IF v_source = 'pos' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.sales AS sale
      WHERE sale.id = v_sale_id
        AND sale.workspace_id = v_workspace_id
        AND sale.payment_method = 'loan'
        AND round(COALESCE(sale.original_total_amount, sale.total_amount, 0), 3) = v_principal
    ) THEN
      RAISE EXCEPTION 'The linked POS loan does not match its sale' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_linked_party_id IS NOT NULL THEN
    SELECT * INTO v_partner
    FROM crm.business_partners AS partner
    WHERE partner.id = v_linked_party_id
      AND partner.workspace_id = v_workspace_id
      AND NOT partner.is_deleted
    FOR UPDATE;

    IF NOT FOUND OR NOT crm.can_access_business_partner(v_workspace_id, v_linked_party_id, 'customer') THEN
      RAISE EXCEPTION 'The selected business partner is unavailable' USING ERRCODE = '42501';
    END IF;

    v_linked_party_name := COALESCE(v_linked_party_name, v_partner.partner_name);
    v_credit_limit := CASE WHEN v_direction = 'lent'
      THEN v_partner.receivable_credit_limit ELSE v_partner.payable_credit_limit END;

    IF v_credit_limit IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.loans AS loan
        WHERE loan.workspace_id = v_workspace_id
          AND loan.linked_party_id = v_linked_party_id
          AND loan.direction = v_direction
          AND loan.status NOT IN ('completed', 'cancelled')
          AND loan.balance_amount > 0
          AND NOT loan.is_deleted
          AND public.convert_financed_amount(
            loan.balance_amount,
            loan.settlement_currency,
            v_partner.default_currency,
            loan.exchange_rate_snapshot
          ) IS NULL
      ) THEN
        RAISE EXCEPTION 'missing_credit_limit_exchange_rate';
      END IF;

      SELECT COALESCE(sum(public.convert_financed_amount(
        loan.balance_amount,
        loan.settlement_currency,
        v_partner.default_currency,
        loan.exchange_rate_snapshot
      )), 0)
      INTO v_credit_usage
      FROM public.loans AS loan
      WHERE loan.workspace_id = v_workspace_id
        AND loan.linked_party_id = v_linked_party_id
        AND loan.direction = v_direction
        AND loan.status NOT IN ('completed', 'cancelled')
        AND loan.balance_amount > 0
        AND NOT loan.is_deleted;

      v_converted_principal := public.convert_financed_amount(
        v_principal, v_currency, v_partner.default_currency, v_exchange_rates
      );
      IF v_converted_principal IS NULL THEN
        RAISE EXCEPTION 'missing_credit_limit_exchange_rate';
      END IF;
      IF v_credit_usage + v_converted_principal > v_credit_limit THEN
        RAISE EXCEPTION 'credit_limit_exceeded';
      END IF;
    END IF;
  ELSE
    v_linked_party_name := NULL;
  END IF;

  v_loan_no := (CASE WHEN v_category = 'simple' THEN 'SL-' ELSE 'LN-' END)
    || pg_catalog.to_char(v_created_at, 'YYYYMMDD') || '-'
    || upper(substr(replace(v_loan_id::text, '-', ''), 1, 6));

  INSERT INTO public.loans (
    id, workspace_id, sale_id, order_id, order_type, loan_no, source,
    loan_category, direction, linked_party_type, linked_party_id, linked_party_name,
    borrower_name, borrower_phone, borrower_address, borrower_national_id,
    principal_amount, total_paid_amount, balance_amount, settlement_currency,
    exchange_rate_snapshot, installment_count, installment_frequency,
    first_due_date, next_due_date, status, notes, created_by,
    created_at, updated_at, version, is_deleted, terms_locked_at, integrity_version
  ) VALUES (
    v_loan_id, v_workspace_id, v_sale_id, NULL, NULL, v_loan_no, v_source,
    v_category, v_direction,
    CASE WHEN v_linked_party_id IS NULL THEN NULL ELSE 'business_partner' END,
    v_linked_party_id, v_linked_party_name,
    v_borrower_name, v_borrower_phone, v_borrower_address, v_borrower_national_id,
    v_principal, 0, v_principal, v_currency,
    v_exchange_rates, v_installment_count, v_frequency,
    v_first_due_date, v_first_due_date,
    CASE WHEN v_first_due_date < CURRENT_DATE THEN 'overdue' ELSE 'active' END,
    v_notes, COALESCE(v_created_by, auth.uid()),
    v_created_at, now(), 1, false, now(), 1
  );

  v_base := round(v_principal / v_installment_count, 3);
  FOR v_index IN 1..v_installment_count LOOP
    v_planned := CASE WHEN v_index = v_installment_count
      THEN round(v_principal - (v_base * (v_installment_count - 1)), 3)
      ELSE v_base END;
    v_due_date := CASE v_frequency
      WHEN 'daily' THEN v_first_due_date + (v_index - 1)
      WHEN 'weekly' THEN v_first_due_date + ((v_index - 1) * 7)
      WHEN 'biweekly' THEN v_first_due_date + ((v_index - 1) * 14)
      ELSE (v_first_due_date + pg_catalog.make_interval(months => v_index - 1))::date
    END;
    BEGIN
      v_installment_id := COALESCE(
        NULLIF(pg_catalog.btrim(p_payload->'installments'->(v_index - 1)->>'id'), '')::uuid,
        gen_random_uuid()
      );
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Loan payload contains an invalid installment identifier'
        USING ERRCODE = '22023';
    END;

    INSERT INTO public.loan_installments (
      id, loan_id, workspace_id, installment_no, due_date, planned_amount,
      paid_amount, balance_amount, status, paid_at, created_at, updated_at,
      version, is_deleted, integrity_version
    ) VALUES (
      v_installment_id, v_loan_id, v_workspace_id, v_index, v_due_date, v_planned,
      0, v_planned,
      CASE WHEN v_due_date < CURRENT_DATE THEN 'overdue' ELSE 'unpaid' END,
      NULL, v_created_at, now(), 1, false, 1
    );
  END LOOP;

  IF v_source = 'manual' THEN
    v_origination_transaction_id := COALESCE(
      NULLIF(pg_catalog.btrim(p_payload->>'origination_transaction_id'), '')::uuid,
      gen_random_uuid()
    );

    INSERT INTO public.payment_transactions (
      id, workspace_id, source_module, source_type, source_record_id, source_subrecord_id,
      direction, amount, currency, payment_method, paid_at, counterparty_name,
      reference_label, note, created_by, account_id, account_name_snapshot,
      cashier_shift_occurrence_id, reversal_of_transaction_id, metadata,
      created_at, updated_at, version, is_deleted
    ) VALUES (
      v_origination_transaction_id, v_workspace_id, 'loans', 'loan_origination',
      v_loan_id, NULL,
      CASE WHEN v_direction = 'borrowed' THEN 'incoming' ELSE 'outgoing' END,
      v_principal, v_currency, 'unknown', v_created_at, v_borrower_name,
      v_loan_no, v_notes, COALESCE(v_created_by, auth.uid()),
      v_account_id, v_account_name, v_cashier_shift_occurrence_id, NULL,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'loanCategory', v_category,
        'loanDirection', v_direction,
        'origination', true,
        'businessPartnerId', v_linked_party_id
      )),
      v_created_at, now(), 1, false
    );

    UPDATE public.loans
    SET origination_transaction_id = v_origination_transaction_id,
        updated_at = now(),
        version = version + 1
    WHERE id = v_loan_id;
  END IF;

  RETURN private.loan_aggregate_result(v_loan_id);
END;
$function$;

CREATE OR REPLACE FUNCTION private.sync_linked_order_from_loan(p_loan_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_loan public.loans%ROWTYPE;
  v_initial numeric := 0;
  v_initial_is_repayment boolean := false;
  v_paid numeric := 0;
  v_paid_at timestamptz;
BEGIN
  SELECT * INTO v_loan FROM public.loans WHERE id = p_loan_id;
  IF NOT FOUND OR v_loan.source <> 'order' OR v_loan.order_id IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.payment_transactions AS transaction
    WHERE transaction.workspace_id = v_loan.workspace_id
      AND transaction.source_module = 'loans'
      AND transaction.source_record_id = v_loan.id
      AND transaction.metadata->>'isOrderLoanInitialRepayment' = 'true'
      AND NOT transaction.is_deleted
  ) INTO v_initial_is_repayment;

  SELECT payment.paid_at INTO v_paid_at
  FROM public.loan_payments AS payment
  WHERE payment.loan_id = v_loan.id AND NOT payment.is_deleted
  ORDER BY payment.paid_at DESC, payment.created_at DESC, payment.id DESC
  LIMIT 1;

  IF v_loan.order_type = 'sales' THEN
    SELECT GREATEST(COALESCE(sales_order.initial_payment_amount, 0), 0)
    INTO v_initial
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.id = v_loan.order_id
    FOR UPDATE;

    v_paid := LEAST(
      (SELECT sales_order.total FROM crm.sales_orders AS sales_order WHERE sales_order.id = v_loan.order_id),
      CASE WHEN v_initial_is_repayment THEN 0 ELSE v_initial END + v_loan.total_paid_amount
    );

    UPDATE crm.sales_orders AS sales_order
    SET linked_loan_id = v_loan.id,
        is_paid = v_loan.balance_amount <= 0.0005,
        payment_status = CASE WHEN v_loan.balance_amount <= 0.0005 THEN 'paid'
          WHEN v_paid > 0 THEN 'partial' ELSE 'unpaid' END,
        paid_amount = v_paid,
        balance_amount = v_loan.balance_amount,
        paid_at = CASE WHEN v_loan.balance_amount <= 0.0005 THEN COALESCE(v_paid_at, now()) ELSE NULL END,
        next_due_date = v_loan.next_due_date,
        updated_at = now(),
        version = COALESCE(sales_order.version, 0) + 1
    WHERE sales_order.id = v_loan.order_id;
  ELSIF v_loan.order_type = 'purchase' THEN
    SELECT GREATEST(COALESCE(purchase_order.initial_payment_amount, 0), 0)
    INTO v_initial
    FROM crm.purchase_orders AS purchase_order
    WHERE purchase_order.id = v_loan.order_id
    FOR UPDATE;

    v_paid := LEAST(
      (SELECT purchase_order.total FROM crm.purchase_orders AS purchase_order WHERE purchase_order.id = v_loan.order_id),
      CASE WHEN v_initial_is_repayment THEN 0 ELSE v_initial END + v_loan.total_paid_amount
    );

    UPDATE crm.purchase_orders AS purchase_order
    SET linked_loan_id = v_loan.id,
        is_paid = v_loan.balance_amount <= 0.0005,
        payment_status = CASE WHEN v_loan.balance_amount <= 0.0005 THEN 'paid'
          WHEN v_paid > 0 THEN 'partial' ELSE 'unpaid' END,
        paid_amount = v_paid,
        balance_amount = v_loan.balance_amount,
        paid_at = CASE WHEN v_loan.balance_amount <= 0.0005 THEN COALESCE(v_paid_at, now()) ELSE NULL END,
        next_due_date = v_loan.next_due_date,
        updated_at = now(),
        version = COALESCE(purchase_order.version, 0) + 1
    WHERE purchase_order.id = v_loan.order_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION private.record_loan_payment(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid;
  v_loan_id uuid;
  v_payment_id uuid;
  v_transaction_id uuid;
  v_installment_id uuid;
  v_account_id uuid;
  v_cashier_shift_occurrence_id uuid;
  v_created_by uuid;
  v_loan public.loans%ROWTYPE;
  v_payment_amount numeric;
  v_remaining numeric;
  v_applied numeric;
  v_paid_at timestamptz;
  v_method text;
  v_note text;
  v_account_name text;
  v_sequence integer;
  v_source_type text;
  v_installment public.loan_installments%ROWTYPE;
  v_touched_ids jsonb := '[]'::jsonb;
  v_next_due_date date;
  v_status text;
BEGIN
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Loan payment payload must be an object' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_workspace_id := NULLIF(pg_catalog.btrim(p_payload->>'workspace_id'), '')::uuid;
    v_loan_id := NULLIF(pg_catalog.btrim(p_payload->>'loan_id'), '')::uuid;
    v_payment_id := NULLIF(pg_catalog.btrim(p_payload->>'id'), '')::uuid;
    v_transaction_id := NULLIF(pg_catalog.btrim(p_payload->>'payment_transaction_id'), '')::uuid;
    v_installment_id := NULLIF(pg_catalog.btrim(p_payload->>'installment_id'), '')::uuid;
    v_account_id := NULLIF(pg_catalog.btrim(p_payload->>'account_id'), '')::uuid;
    v_cashier_shift_occurrence_id := NULLIF(pg_catalog.btrim(p_payload->>'cashier_shift_occurrence_id'), '')::uuid;
    v_created_by := NULLIF(pg_catalog.btrim(p_payload->>'created_by'), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Loan payment payload contains an invalid identifier' USING ERRCODE = '22023';
  END;

  IF v_workspace_id IS NULL OR v_loan_id IS NULL OR v_payment_id IS NULL OR v_transaction_id IS NULL THEN
    RAISE EXCEPTION 'Loan, payment, transaction, and workspace identifiers are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('loan-payment:' || v_payment_id::text, 0)
  );

  IF EXISTS (SELECT 1 FROM public.loan_payments WHERE id = v_payment_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.loan_payments
      WHERE id = v_payment_id
        AND loan_id = v_loan_id
        AND workspace_id = v_workspace_id
        AND payment_transaction_id = v_transaction_id
    ) THEN
      RAISE EXCEPTION 'Loan payment id is already used by another operation'
        USING ERRCODE = '23505';
    END IF;
    RETURN private.loan_aggregate_result(v_loan_id);
  END IF;

  -- Read only enough to establish the same lock order used by financed-order
  -- activation: linked order first, then loan, then installments/accounts.
  SELECT * INTO v_loan
  FROM public.loans
  WHERE id = v_loan_id AND workspace_id = v_workspace_id AND NOT is_deleted;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found' USING ERRCODE = 'P0002'; END IF;

  IF v_loan.source = 'order' AND v_loan.order_id IS NOT NULL THEN
    IF v_loan.order_type = 'sales' THEN
      PERFORM sales_order.id FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = v_loan.order_id FOR UPDATE;
    ELSE
      PERFORM purchase_order.id FROM crm.purchase_orders AS purchase_order
      WHERE purchase_order.id = v_loan.order_id FOR UPDATE;
    END IF;
  END IF;

  SELECT * INTO v_loan
  FROM public.loans
  WHERE id = v_loan_id AND workspace_id = v_workspace_id AND NOT is_deleted
  FOR UPDATE;

  PERFORM private.assert_loan_write_access(
    v_workspace_id,
    CASE WHEN v_loan.loan_category = 'simple' THEN 'loans' ELSE 'installments' END
  );

  IF v_loan.status = 'cancelled' OR v_loan.balance_amount <= 0.0005 THEN
    RAISE EXCEPTION 'This loan has no payable balance' USING ERRCODE = '23514';
  END IF;

  v_payment_amount := round(COALESCE((p_payload->>'amount')::numeric, 0), 3);
  IF v_payment_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF v_payment_amount - v_loan.balance_amount > 0.0005 THEN
    RAISE EXCEPTION 'Loan payment exceeds the remaining balance' USING ERRCODE = '23514';
  END IF;

  v_method := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'payment_method'), ''), 'cash');
  IF v_method NOT IN ('cash', 'fib', 'qicard', 'zaincash', 'fastpay', 'bank_transfer', 'loan_adjustment') THEN
    RAISE EXCEPTION 'Loan payment method is invalid' USING ERRCODE = '22023';
  END IF;
  v_paid_at := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'paid_at'), '')::timestamptz, now());
  v_note := NULLIF(pg_catalog.btrim(p_payload->>'note'), '');
  v_account_name := NULLIF(pg_catalog.btrim(p_payload->>'account_name_snapshot'), '');

  IF v_installment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.loan_installments AS installment
    WHERE installment.id = v_installment_id
      AND installment.loan_id = v_loan.id
      AND installment.workspace_id = v_workspace_id
      AND NOT installment.is_deleted
  ) THEN
    RAISE EXCEPTION 'Selected installment does not belong to the loan' USING ERRCODE = '23503';
  END IF;

  PERFORM installment.id
  FROM public.loan_installments AS installment
  WHERE installment.loan_id = v_loan.id AND NOT installment.is_deleted
  ORDER BY installment.installment_no, installment.id
  FOR UPDATE;

  SELECT count(*) + 1 INTO v_sequence
  FROM public.loan_payments AS payment
  WHERE payment.loan_id = v_loan.id;

  v_source_type := CASE
    WHEN v_loan.loan_category = 'simple' THEN 'simple_loan'
    WHEN v_loan.installment_count > 1 OR v_installment_id IS NOT NULL THEN 'loan_installment'
    ELSE 'loan_payment'
  END;

  INSERT INTO public.payment_transactions (
    id, workspace_id, source_module, source_type, source_record_id, source_subrecord_id,
    direction, amount, currency, payment_method, paid_at, counterparty_name,
    reference_label, note, created_by, account_id, account_name_snapshot,
    cashier_shift_occurrence_id, reversal_of_transaction_id, metadata,
    created_at, updated_at, version, is_deleted
  ) VALUES (
    v_transaction_id, v_workspace_id, 'loans', v_source_type, v_loan.id,
    CASE WHEN v_source_type = 'loan_installment' THEN v_installment_id ELSE v_payment_id END,
    CASE WHEN v_loan.direction = 'borrowed' THEN 'outgoing' ELSE 'incoming' END,
    v_payment_amount, v_loan.settlement_currency, v_method, v_paid_at,
    v_loan.borrower_name, v_loan.loan_no, v_note, COALESCE(v_created_by, auth.uid()),
    v_account_id, v_account_name, v_cashier_shift_occurrence_id, NULL,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'loanPaymentId', v_payment_id,
      'loanCategory', v_loan.loan_category,
      'loanDirection', v_loan.direction,
      'businessPartnerId', v_loan.linked_party_id,
      'displaySourceLabel', CASE WHEN v_loan.source = 'order' THEN 'order_loan' ELSE NULL END,
      'orderId', v_loan.order_id,
      'orderType', v_loan.order_type,
      'isOrderLoanInitialRepayment', CASE
        WHEN p_payload->>'is_order_loan_initial_repayment' = 'true' THEN true ELSE NULL END
    )),
    now(), now(), 1, false
  );

  INSERT INTO public.loan_payments (
    id, loan_id, workspace_id, sequence_no, amount, payment_method, paid_at,
    note, created_by, payment_transaction_id, reversed_amount,
    created_at, updated_at, version, is_deleted, integrity_version
  ) VALUES (
    v_payment_id, v_loan.id, v_workspace_id, v_sequence, v_payment_amount,
    v_method, v_paid_at, v_note, COALESCE(v_created_by, auth.uid()),
    v_transaction_id, 0, now(), now(), 1, false, 1
  );

  v_remaining := v_payment_amount;
  FOR v_installment IN
    SELECT installment.*
    FROM public.loan_installments AS installment
    WHERE installment.loan_id = v_loan.id
      AND NOT installment.is_deleted
    ORDER BY
      CASE WHEN installment.id = v_installment_id THEN 0 ELSE 1 END,
      installment.installment_no,
      installment.id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0.0005;
    CONTINUE WHEN v_installment.balance_amount <= 0.0005;

    v_applied := round(LEAST(v_installment.balance_amount, v_remaining), 3);
    UPDATE public.loan_installments AS installment
    SET paid_amount = round(installment.paid_amount + v_applied, 3),
        balance_amount = round(GREATEST(installment.balance_amount - v_applied, 0), 3),
        status = CASE
          WHEN installment.balance_amount - v_applied <= 0.0005 THEN 'paid'
          ELSE 'partial' END,
        paid_at = CASE
          WHEN installment.balance_amount - v_applied <= 0.0005 THEN v_paid_at
          ELSE installment.paid_at END,
        updated_at = now(),
        version = installment.version + 1,
        integrity_version = GREATEST(installment.integrity_version, 1)
    WHERE installment.id = v_installment.id;

    v_touched_ids := v_touched_ids || pg_catalog.jsonb_build_array(v_installment.id);
    v_remaining := round(GREATEST(v_remaining - v_applied, 0), 3);
  END LOOP;

  SELECT installment.due_date INTO v_next_due_date
  FROM public.loan_installments AS installment
  WHERE installment.loan_id = v_loan.id
    AND NOT installment.is_deleted
    AND installment.balance_amount > 0.0005
  ORDER BY installment.installment_no, installment.id
  LIMIT 1;

  v_status := CASE
    WHEN v_loan.balance_amount - v_payment_amount <= 0.0005 THEN 'completed'
    WHEN EXISTS (
      SELECT 1 FROM public.loan_installments AS installment
      WHERE installment.loan_id = v_loan.id
        AND NOT installment.is_deleted
        AND installment.balance_amount > 0.0005
        AND installment.due_date < CURRENT_DATE
    ) THEN 'overdue'
    ELSE 'active'
  END;

  UPDATE public.loans AS loan
  SET total_paid_amount = round(loan.total_paid_amount + v_payment_amount, 3),
      balance_amount = round(GREATEST(loan.balance_amount - v_payment_amount, 0), 3),
      next_due_date = v_next_due_date,
      status = v_status,
      updated_at = now(),
      version = loan.version + 1,
      integrity_version = GREATEST(loan.integrity_version, 1)
  WHERE loan.id = v_loan.id;

  UPDATE public.payment_transactions
  SET metadata = COALESCE(metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object('touchedInstallmentIds', v_touched_ids),
      updated_at = now()
  WHERE id = v_transaction_id;

  PERFORM private.sync_linked_order_from_loan(v_loan.id);
  RETURN private.loan_aggregate_result(v_loan.id);
END;
$function$;

CREATE OR REPLACE FUNCTION private.rebuild_loan_from_payments(
  p_loan_id uuid,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_loan public.loans%ROWTYPE;
  v_payment record;
  v_installment public.loan_installments%ROWTYPE;
  v_remaining numeric;
  v_applied numeric;
  v_total_paid numeric;
  v_balance numeric;
  v_next_due date;
  v_status text;
BEGIN
  SELECT * INTO v_loan FROM public.loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.loan_installments AS installment
  SET paid_amount = 0,
      balance_amount = installment.planned_amount,
      status = CASE WHEN installment.due_date < CURRENT_DATE THEN 'overdue' ELSE 'unpaid' END,
      paid_at = NULL,
      updated_at = p_now,
      version = installment.version + 1,
      integrity_version = GREATEST(installment.integrity_version, 1)
  WHERE installment.loan_id = v_loan.id AND NOT installment.is_deleted;

  FOR v_payment IN
    SELECT payment.*,
      transaction.source_type AS transaction_source_type,
      transaction.source_subrecord_id AS transaction_source_subrecord_id
    FROM public.loan_payments AS payment
    LEFT JOIN LATERAL (
      SELECT candidate.source_type, candidate.source_subrecord_id
      FROM public.payment_transactions AS candidate
      WHERE candidate.id = payment.payment_transaction_id
        OR candidate.metadata->>'loanPaymentId' = payment.id::text
      ORDER BY (candidate.id = payment.payment_transaction_id) DESC,
        candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    ) AS transaction ON true
    WHERE payment.loan_id = v_loan.id AND NOT payment.is_deleted
    ORDER BY payment.paid_at, payment.created_at, payment.id
  LOOP
    v_remaining := round(v_payment.amount, 3);
    FOR v_installment IN
      SELECT installment.*
      FROM public.loan_installments AS installment
      WHERE installment.loan_id = v_loan.id AND NOT installment.is_deleted
      ORDER BY
        CASE WHEN v_payment.transaction_source_type = 'loan_installment'
          AND installment.id = v_payment.transaction_source_subrecord_id THEN 0 ELSE 1 END,
        installment.installment_no,
        installment.id
      FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0.0005;
      CONTINUE WHEN v_installment.balance_amount <= 0.0005;
      v_applied := round(LEAST(v_installment.balance_amount, v_remaining), 3);
      UPDATE public.loan_installments AS installment
      SET paid_amount = round(installment.paid_amount + v_applied, 3),
          balance_amount = round(GREATEST(installment.balance_amount - v_applied, 0), 3),
          status = CASE WHEN installment.balance_amount - v_applied <= 0.0005 THEN 'paid' ELSE 'partial' END,
          paid_at = CASE WHEN installment.balance_amount - v_applied <= 0.0005
            THEN v_payment.paid_at ELSE installment.paid_at END,
          updated_at = p_now,
          version = installment.version + 1
      WHERE installment.id = v_installment.id;
      v_remaining := round(GREATEST(v_remaining - v_applied, 0), 3);
    END LOOP;
  END LOOP;

  SELECT round(COALESCE(sum(payment.amount), 0), 3)
  INTO v_total_paid
  FROM public.loan_payments AS payment
  WHERE payment.loan_id = v_loan.id AND NOT payment.is_deleted;

  IF v_total_paid - v_loan.principal_amount > 0.0005 THEN
    RAISE EXCEPTION 'Active loan payments exceed principal' USING ERRCODE = '23514';
  END IF;
  v_balance := round(GREATEST(v_loan.principal_amount - v_total_paid, 0), 3);

  SELECT installment.due_date INTO v_next_due
  FROM public.loan_installments AS installment
  WHERE installment.loan_id = v_loan.id
    AND NOT installment.is_deleted
    AND installment.balance_amount > 0.0005
  ORDER BY installment.installment_no, installment.id
  LIMIT 1;

  v_status := CASE WHEN v_balance <= 0.0005 THEN 'completed'
    WHEN EXISTS (
      SELECT 1 FROM public.loan_installments AS installment
      WHERE installment.loan_id = v_loan.id
        AND NOT installment.is_deleted
        AND installment.balance_amount > 0.0005
        AND installment.due_date < CURRENT_DATE
    ) THEN 'overdue' ELSE 'active' END;

  UPDATE public.loans AS loan
  SET total_paid_amount = v_total_paid,
      balance_amount = v_balance,
      next_due_date = v_next_due,
      status = v_status,
      updated_at = p_now,
      version = loan.version + 1,
      integrity_version = GREATEST(loan.integrity_version, 1)
  WHERE loan.id = v_loan.id;
END;
$function$;

CREATE OR REPLACE FUNCTION private.reverse_loan_payment(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid;
  v_original_transaction_id uuid;
  v_reversal_transaction_id uuid;
  v_created_by uuid;
  v_original public.payment_transactions%ROWTYPE;
  v_payment public.loan_payments%ROWTYPE;
  v_latest_payment_id uuid;
  v_loan public.loans%ROWTYPE;
  v_paid_at timestamptz;
  v_note text;
BEGIN
  BEGIN
    v_workspace_id := NULLIF(pg_catalog.btrim(p_payload->>'workspace_id'), '')::uuid;
    v_original_transaction_id := NULLIF(pg_catalog.btrim(p_payload->>'original_transaction_id'), '')::uuid;
    v_reversal_transaction_id := NULLIF(pg_catalog.btrim(p_payload->>'reversal_transaction_id'), '')::uuid;
    v_created_by := NULLIF(pg_catalog.btrim(p_payload->>'created_by'), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Loan reversal payload contains an invalid identifier' USING ERRCODE = '22023';
  END;

  IF v_workspace_id IS NULL OR v_original_transaction_id IS NULL OR v_reversal_transaction_id IS NULL THEN
    RAISE EXCEPTION 'Workspace, original transaction, and reversal identifiers are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('loan-reversal:' || v_reversal_transaction_id::text, 0)
  );

  SELECT * INTO v_original
  FROM public.payment_transactions
  WHERE id = v_original_transaction_id
    AND workspace_id = v_workspace_id
    AND source_module = 'loans'
    AND source_type IN ('loan_payment', 'simple_loan', 'loan_installment')
    AND reversal_of_transaction_id IS NULL
    AND NOT is_deleted;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan payment transaction not found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_loan
  FROM public.loans
  WHERE id = v_original.source_record_id AND workspace_id = v_workspace_id AND NOT is_deleted;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found' USING ERRCODE = 'P0002'; END IF;

  IF v_loan.source = 'order' AND v_loan.order_id IS NOT NULL THEN
    IF v_loan.order_type = 'sales' THEN
      PERFORM sales_order.id FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = v_loan.order_id FOR UPDATE;
    ELSE
      PERFORM purchase_order.id FROM crm.purchase_orders AS purchase_order
      WHERE purchase_order.id = v_loan.order_id FOR UPDATE;
    END IF;
  END IF;

  SELECT * INTO v_loan
  FROM public.loans
  WHERE id = v_original.source_record_id AND workspace_id = v_workspace_id AND NOT is_deleted
  FOR UPDATE;

  SELECT * INTO v_original
  FROM public.payment_transactions
  WHERE id = v_original_transaction_id
    AND workspace_id = v_workspace_id
    AND source_module = 'loans'
    AND source_type IN ('loan_payment', 'simple_loan', 'loan_installment')
    AND reversal_of_transaction_id IS NULL
    AND NOT is_deleted
  FOR UPDATE;

  SELECT * INTO v_payment
  FROM public.loan_payments AS payment
  WHERE payment.workspace_id = v_workspace_id
    AND payment.loan_id = v_loan.id
    AND (
      payment.payment_transaction_id = v_original.id
      OR payment.id::text = v_original.metadata->>'loanPaymentId'
      OR (v_original.source_type <> 'loan_installment' AND payment.id = v_original.source_subrecord_id)
    )
  ORDER BY (payment.payment_transaction_id = v_original.id) DESC, payment.created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan payment record not found' USING ERRCODE = 'P0002'; END IF;

  PERFORM private.assert_loan_write_access(
    v_workspace_id,
    CASE WHEN v_loan.loan_category = 'simple' THEN 'loans' ELSE 'installments' END
  );

  IF EXISTS (SELECT 1 FROM public.payment_transactions WHERE id = v_reversal_transaction_id) THEN
    IF v_payment.reversal_transaction_id IS DISTINCT FROM v_reversal_transaction_id THEN
      RAISE EXCEPTION 'Reversal id is already used by another operation' USING ERRCODE = '23505';
    END IF;
    RETURN private.loan_aggregate_result(v_loan.id);
  END IF;

  IF v_payment.is_deleted OR v_payment.reversed_amount > 0 THEN
    RAISE EXCEPTION 'Loan payment is already reversed' USING ERRCODE = '23514';
  END IF;

  SELECT payment.id INTO v_latest_payment_id
  FROM public.loan_payments AS payment
  WHERE payment.loan_id = v_loan.id AND NOT payment.is_deleted
  ORDER BY payment.paid_at DESC, payment.created_at DESC, payment.id DESC
  LIMIT 1;
  IF v_latest_payment_id IS DISTINCT FROM v_payment.id THEN
    RAISE EXCEPTION 'Only the latest loan payment can be reversed' USING ERRCODE = '23514';
  END IF;

  v_paid_at := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'paid_at'), '')::timestamptz, now());
  v_note := COALESCE(NULLIF(pg_catalog.btrim(p_payload->>'note'), ''),
    'Reversal of ' || COALESCE(v_original.reference_label, v_original.source_type));

  INSERT INTO public.payment_transactions (
    id, workspace_id, source_module, source_type, source_record_id, source_subrecord_id,
    direction, amount, currency, payment_method, paid_at, counterparty_name,
    reference_label, note, created_by, account_id, account_name_snapshot,
    cashier_shift_occurrence_id, reversal_of_transaction_id, metadata,
    created_at, updated_at, version, is_deleted
  ) VALUES (
    v_reversal_transaction_id, v_original.workspace_id, v_original.source_module,
    v_original.source_type, v_original.source_record_id, v_original.source_subrecord_id,
    v_original.direction, -abs(v_payment.amount), v_original.currency,
    v_original.payment_method, v_paid_at, v_original.counterparty_name,
    v_loan.loan_no, v_note, COALESCE(v_created_by, auth.uid()),
    v_original.account_id, v_original.account_name_snapshot,
    v_original.cashier_shift_occurrence_id, v_original.id,
    COALESCE(v_original.metadata, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('reversal', true, 'loanPaymentId', v_payment.id),
    now(), now(), 1, false
  );

  UPDATE public.loan_payments AS payment
  SET reversed_amount = payment.amount,
      reversal_transaction_id = v_reversal_transaction_id,
      reversed_at = v_paid_at,
      reversed_by = COALESCE(v_created_by, auth.uid()),
      is_deleted = true,
      updated_at = now(),
      version = payment.version + 1
  WHERE payment.id = v_payment.id;

  PERFORM private.rebuild_loan_from_payments(v_loan.id, now());
  PERFORM private.sync_linked_order_from_loan(v_loan.id);
  RETURN private.loan_aggregate_result(v_loan.id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_loan(p_payload jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.create_loan_aggregate(p_payload);
$function$;

CREATE OR REPLACE FUNCTION public.post_loan_payment(p_payload jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.record_loan_payment(p_payload);
$function$;

CREATE OR REPLACE FUNCTION public.reverse_loan_payment(p_payload jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.reverse_loan_payment(p_payload);
$function$;

-- New clients opt into this function. Keeping complete_sale(jsonb) unchanged
-- prevents older clients from creating a second loan after checkout.
CREATE OR REPLACE FUNCTION public.complete_sale_with_loan(
  payload jsonb,
  p_loan jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_sale_result jsonb;
  v_sale public.sales%ROWTYPE;
  v_loan_result jsonb;
BEGIN
  IF p_loan IS NULL OR pg_catalog.jsonb_typeof(p_loan) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'POS loan registration is required' USING ERRCODE = '22023';
  END IF;

  v_sale_result := public.complete_sale(payload);
  SELECT * INTO v_sale
  FROM public.sales
  WHERE id = NULLIF(pg_catalog.btrim(payload->>'id'), '')::uuid
  FOR UPDATE;

  IF NOT FOUND OR v_sale.payment_method IS DISTINCT FROM 'loan' THEN
    RAISE EXCEPTION 'The completed sale is not financed as a loan' USING ERRCODE = '23514';
  END IF;

  v_loan_result := private.create_loan_aggregate(
    p_loan
    || pg_catalog.jsonb_build_object(
      'workspace_id', v_sale.workspace_id,
      'sale_id', v_sale.id,
      'source', 'pos',
      'principal_amount', round(COALESCE(v_sale.original_total_amount, v_sale.total_amount), 3),
      'settlement_currency', v_sale.settlement_currency,
      'created_at', COALESCE(v_sale.created_at, now())
    )
  );

  RETURN v_sale_result || pg_catalog.jsonb_build_object('loan_aggregate', v_loan_result);
END;
$function$;

-- New clients also opt into the return wrapper. The existing process_sale_return
-- remains available to older clients, whose historical client-side adjustment
-- would otherwise double-credit the loan.
CREATE OR REPLACE FUNCTION public.process_sale_return_with_loan(
  p_return_id uuid,
  p_sale_id uuid,
  p_items jsonb,
  p_return_reason text,
  p_refund_method text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_result jsonb;
  v_sale public.sales%ROWTYPE;
  v_loan public.loans%ROWTYPE;
  v_payment_amount numeric;
  v_payment_id uuid := p_return_id;
  v_transaction_id uuid := pg_catalog.md5('loan-return:' || p_return_id::text)::uuid;
  v_loan_result jsonb;
BEGIN
  v_result := public.process_sale_return(
    p_return_id, p_sale_id, p_items, p_return_reason, p_refund_method
  );

  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND OR v_sale.payment_method IS DISTINCT FROM 'loan' THEN
    RETURN v_result;
  END IF;

  SELECT * INTO v_loan
  FROM public.loans
  WHERE workspace_id = v_sale.workspace_id
    AND sale_id = v_sale.id
    AND source = 'pos'
    AND NOT is_deleted
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN v_result;
  END IF;
  IF v_sale.return_status = 'full' THEN
    RETURN v_result || pg_catalog.jsonb_build_object(
      'loan_aggregate', private.loan_aggregate_result(v_loan.id)
    );
  END IF;
  IF v_loan.status = 'cancelled' OR v_loan.balance_amount <= 0.0005 THEN
    RETURN v_result;
  END IF;

  v_payment_amount := round(LEAST(
    COALESCE((v_result->>'return_value')::numeric, 0),
    v_loan.balance_amount
  ), 3);
  IF v_payment_amount <= 0 THEN RETURN v_result; END IF;

  v_loan_result := private.record_loan_payment(pg_catalog.jsonb_build_object(
    'workspace_id', v_sale.workspace_id,
    'loan_id', v_loan.id,
    'id', v_payment_id,
    'payment_transaction_id', v_transaction_id,
    'amount', v_payment_amount,
    'payment_method', 'loan_adjustment',
    'paid_at', now(),
    'note', 'Return credit: ' || COALESCE(NULLIF(pg_catalog.btrim(p_return_reason), ''), 'Return'),
    'created_by', auth.uid()
  ));

  RETURN v_result || pg_catalog.jsonb_build_object('loan_aggregate', v_loan_result);
END;
$function$;

CREATE OR REPLACE FUNCTION public.loan_integrity_report(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL
    OR p_workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR public.current_user_role() <> 'admin'
  THEN
    RAISE EXCEPTION 'Only a workspace administrator can run the loan integrity report'
      USING ERRCODE = '42501';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'workspace_id', p_workspace_id,
    'loan_arithmetic_mismatches', (
      SELECT count(*) FROM public.loans AS loan
      WHERE loan.workspace_id = p_workspace_id
        AND NOT loan.is_deleted
        AND loan.status <> 'cancelled'
        AND abs(loan.principal_amount - loan.total_paid_amount - loan.balance_amount) > 0.0005
    ),
    'installment_arithmetic_mismatches', (
      SELECT count(*) FROM public.loan_installments AS installment
      WHERE installment.workspace_id = p_workspace_id
        AND NOT installment.is_deleted
        AND installment.status <> 'cancelled'
        AND abs(installment.planned_amount - installment.paid_amount - installment.balance_amount) > 0.0005
    ),
    'payment_total_mismatches', (
      SELECT count(*)
      FROM public.loans AS loan
      WHERE loan.workspace_id = p_workspace_id
        AND NOT loan.is_deleted
        AND loan.status <> 'cancelled'
        AND abs(loan.total_paid_amount - COALESCE((
          SELECT sum(payment.amount)
          FROM public.loan_payments AS payment
          WHERE payment.loan_id = loan.id AND NOT payment.is_deleted
        ), 0)) > 0.0005
    ),
    'unlinked_v1_payments', (
      SELECT count(*) FROM public.loan_payments AS payment
      WHERE payment.workspace_id = p_workspace_id
        AND payment.integrity_version > 0
        AND payment.payment_transaction_id IS NULL
    ),
    'duplicate_active_installments', (
      SELECT count(*) FROM (
        SELECT installment.loan_id, installment.installment_no
        FROM public.loan_installments AS installment
        WHERE installment.workspace_id = p_workspace_id AND NOT installment.is_deleted
        GROUP BY installment.loan_id, installment.installment_no
        HAVING count(*) > 1
      ) AS duplicates
    ),
    'generated_at', now()
  );
END;
$function$;

-- The legacy full-return trigger already owns cancellation and ledger reversal.
-- Run immediately after it (Postgres orders same-event triggers by name) to add
-- the v1 links and to restore the exact original account projection.
CREATE OR REPLACE FUNCTION private.finalize_pos_loan_full_return_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_loan public.loans%ROWTYPE;
  v_payment public.loan_payments%ROWTYPE;
  v_original public.payment_transactions%ROWTYPE;
  v_reversal public.payment_transactions%ROWTYPE;
BEGIN
  IF OLD.return_status = 'full'
    OR NEW.return_status IS DISTINCT FROM 'full'
    OR NEW.payment_method IS DISTINCT FROM 'loan'
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_loan
  FROM public.loans AS loan
  WHERE loan.sale_id = NEW.id
    AND loan.workspace_id = NEW.workspace_id
    AND loan.source = 'pos'
    AND NOT loan.is_deleted
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  FOR v_payment IN
    SELECT payment.*
    FROM public.loan_payments AS payment
    WHERE payment.loan_id = v_loan.id
      AND NOT payment.is_deleted
      AND payment.amount > 0
    ORDER BY payment.paid_at, payment.created_at, payment.id
    FOR UPDATE
  LOOP
    SELECT * INTO v_reversal
    FROM public.payment_transactions AS transaction
    WHERE transaction.workspace_id = NEW.workspace_id
      AND NOT transaction.is_deleted
      AND transaction.metadata->>'loanPaymentId' = v_payment.id::text
      AND COALESCE((transaction.metadata->>'fullSaleReturn')::boolean, false)
    ORDER BY transaction.created_at DESC, transaction.id DESC
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT * INTO v_original
    FROM public.payment_transactions AS transaction
    WHERE transaction.workspace_id = NEW.workspace_id
      AND NOT transaction.is_deleted
      AND transaction.reversal_of_transaction_id IS NULL
      AND (
        transaction.id = v_payment.payment_transaction_id
        OR transaction.metadata->>'loanPaymentId' = v_payment.id::text
        OR (
          transaction.source_subrecord_id = v_payment.id
          AND transaction.source_type IN ('loan_payment', 'simple_loan')
        )
      )
    ORDER BY (transaction.id = v_payment.payment_transaction_id) DESC,
      transaction.created_at DESC, transaction.id DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.payment_transactions AS transaction
      SET account_id = v_original.account_id,
          account_name_snapshot = v_original.account_name_snapshot,
          cashier_shift_occurrence_id = v_original.cashier_shift_occurrence_id,
          reversal_of_transaction_id = v_original.id,
          updated_at = now(),
          version = transaction.version + 1
      WHERE transaction.id = v_reversal.id;
    END IF;

    UPDATE public.loan_payments AS payment
    SET payment_transaction_id = COALESCE(payment.payment_transaction_id, v_original.id),
        reversed_amount = payment.amount,
        reversal_transaction_id = v_reversal.id,
        reversed_at = v_reversal.paid_at,
        reversed_by = NEW.returned_by,
        is_deleted = true,
        updated_at = now(),
        version = payment.version + 1
    WHERE payment.id = v_payment.id;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS z_finalize_pos_loan_full_return_integrity ON public.sales;
CREATE TRIGGER z_finalize_pos_loan_full_return_integrity
AFTER UPDATE OF return_status ON public.sales
FOR EACH ROW
EXECUTE FUNCTION private.finalize_pos_loan_full_return_integrity();

REVOKE ALL ON FUNCTION private.validate_loan_amount_transition() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.validate_loan_installment_transition() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.protect_locked_loan_terms() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.assert_loan_write_access(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.loan_aggregate_result(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.create_loan_aggregate(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_linked_order_from_loan(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.record_loan_payment(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.rebuild_loan_from_payments(uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reverse_loan_payment(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.finalize_pos_loan_full_return_integrity() FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.create_loan_aggregate(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_loan_payment(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.reverse_loan_payment(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_loan(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_loan_payment(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_loan_payment(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_sale_with_loan(jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_sale_return_with_loan(uuid, uuid, jsonb, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.loan_integrity_report(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_loan(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_loan_payment(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_loan_payment(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_sale_with_loan(jsonb, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.process_sale_return_with_loan(uuid, uuid, jsonb, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loan_integrity_report(uuid) TO authenticated;

COMMENT ON FUNCTION public.create_loan(jsonb) IS
  'Idempotent atomic manual/POS loan creation. New records use integrity contract version 1.';
COMMENT ON FUNCTION public.post_loan_payment(jsonb) IS
  'Idempotent row-locked loan repayment. Loan, installments, payment subledger, cash ledger, account and linked order commit together.';
COMMENT ON FUNCTION public.reverse_loan_payment(jsonb) IS
  'Idempotent full reversal of the latest loan repayment with an exact linked ledger counter-entry.';
COMMENT ON FUNCTION public.complete_sale_with_loan(jsonb, jsonb) IS
  'Atomic POS checkout and loan registration for upgraded clients.';
COMMENT ON FUNCTION public.process_sale_return_with_loan(uuid, uuid, jsonb, text, text) IS
  'Atomic POS return and non-cash loan credit for upgraded clients.';

NOTIFY pgrst, 'reload schema';
