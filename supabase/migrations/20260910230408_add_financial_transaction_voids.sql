-- Administrator-only correction workflow for financial records entered in error.
-- Posted rows remain immutable and discoverable in this audit table, while
-- void_id removes their effect from operational reporting and account balances.

CREATE TABLE public.financial_transaction_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  root_payment_transaction_id uuid NOT NULL REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  requested_payment_transaction_id uuid NOT NULL REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  source_module text NOT NULL,
  source_type text NOT NULL,
  source_record_id uuid NOT NULL,
  source_subrecord_id uuid,
  source_unavailable boolean NOT NULL DEFAULT false,
  affected_transaction_ids uuid[] NOT NULL,
  reason text NOT NULL,
  cash_movement_declaration text NOT NULL,
  voided_by uuid NOT NULL,
  voided_by_name_snapshot text NOT NULL,
  voided_at timestamptz NOT NULL DEFAULT now(),
  source_snapshot jsonb NOT NULL,
  transaction_snapshots jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT financial_transaction_voids_root_unique UNIQUE (root_payment_transaction_id),
  CONSTRAINT financial_transaction_voids_supported_source_check CHECK (
    source_module = 'budget' AND source_type = 'expense_item'
  ),
  CONSTRAINT financial_transaction_voids_reason_check CHECK (
    char_length(btrim(reason)) BETWEEN 10 AND 1000
  ),
  CONSTRAINT financial_transaction_voids_cash_declaration_check CHECK (
    cash_movement_declaration = 'no_money_moved'
  ),
  CONSTRAINT financial_transaction_voids_affected_check CHECK (
    cardinality(affected_transaction_ids) > 0
  ),
  CONSTRAINT financial_transaction_voids_snapshot_check CHECK (
    jsonb_typeof(source_snapshot) = 'object'
    AND jsonb_typeof(transaction_snapshots) = 'array'
  ),
  CONSTRAINT financial_transaction_voids_immutable_metadata_check CHECK (
    updated_at = created_at AND version = 1 AND NOT is_deleted
  )
);

CREATE INDEX financial_transaction_voids_workspace_time_idx
  ON public.financial_transaction_voids (workspace_id, voided_at DESC);

CREATE INDEX financial_transaction_voids_workspace_source_idx
  ON public.financial_transaction_voids (workspace_id, source_type, source_record_id);

CREATE INDEX financial_transaction_voids_requested_payment_idx
  ON public.financial_transaction_voids (requested_payment_transaction_id);

ALTER TABLE public.payment_transactions
  ADD COLUMN void_id uuid REFERENCES public.financial_transaction_voids(id) ON DELETE RESTRICT;

ALTER TABLE budget.expense_items
  ADD COLUMN void_id uuid REFERENCES public.financial_transaction_voids(id) ON DELETE RESTRICT;

ALTER TABLE budget.expense_series
  ADD COLUMN void_id uuid REFERENCES public.financial_transaction_voids(id) ON DELETE RESTRICT;

ALTER TABLE payment_accounts.account_movements
  ADD COLUMN void_id uuid REFERENCES public.financial_transaction_voids(id) ON DELETE RESTRICT;

CREATE INDEX payment_transactions_workspace_void_idx
  ON public.payment_transactions (workspace_id, void_id)
  WHERE void_id IS NOT NULL;

CREATE INDEX expense_items_workspace_void_idx
  ON budget.expense_items (workspace_id, void_id)
  WHERE void_id IS NOT NULL;

CREATE INDEX expense_series_workspace_void_idx
  ON budget.expense_series (workspace_id, void_id)
  WHERE void_id IS NOT NULL;

CREATE INDEX account_movements_workspace_void_idx
  ON payment_accounts.account_movements (workspace_id, void_id)
  WHERE void_id IS NOT NULL;

ALTER TABLE public.financial_transaction_voids ENABLE ROW LEVEL SECURITY;

CREATE POLICY financial_transaction_voids_admin_select
  ON public.financial_transaction_voids
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = (SELECT public.current_workspace_id())
    AND (SELECT public.current_user_role()) = 'admin'
  );

REVOKE ALL ON TABLE public.financial_transaction_voids FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.financial_transaction_voids TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reject_financial_void_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Financial transaction void audits are immutable'
    USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER financial_transaction_voids_immutable
  BEFORE UPDATE OR DELETE ON public.financial_transaction_voids
  FOR EACH ROW EXECUTE FUNCTION public.reject_financial_void_audit_mutation();

CREATE OR REPLACE FUNCTION public.protect_financial_void_reference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF (to_jsonb(OLD) ->> 'void_id') IS DISTINCT FROM (to_jsonb(NEW) ->> 'void_id')
    AND NOT coalesce(
      current_setting('atlas.allow_financial_void', true) = 'on'
      AND current_user = (
        SELECT pg_catalog.pg_get_userbyid(procedure.proowner)
        FROM pg_catalog.pg_proc AS procedure
        WHERE procedure.oid = pg_catalog.to_regprocedure(
          'private.void_financial_transaction(uuid,uuid,text,text,uuid)'
        )
      ),
      false
    ) THEN
    RAISE EXCEPTION 'Financial void references can only be changed by the administrator void workflow'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER payment_transactions_protect_void_id
  BEFORE UPDATE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.protect_financial_void_reference();

CREATE TRIGGER expense_items_protect_void_id
  BEFORE UPDATE ON budget.expense_items
  FOR EACH ROW EXECUTE FUNCTION public.protect_financial_void_reference();

CREATE TRIGGER expense_series_protect_void_id
  BEFORE UPDATE ON budget.expense_series
  FOR EACH ROW EXECUTE FUNCTION public.protect_financial_void_reference();

CREATE TRIGGER account_movements_protect_void_id
  BEFORE UPDATE ON payment_accounts.account_movements
  FOR EACH ROW EXECUTE FUNCTION public.protect_financial_void_reference();

CREATE OR REPLACE FUNCTION public.prevent_voided_payment_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.void_id IS NOT NULL THEN
    RAISE EXCEPTION 'Voided payment transactions cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE TRIGGER payment_transactions_protect_voided_history
  BEFORE DELETE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_voided_payment_delete();

CREATE OR REPLACE FUNCTION public.reject_reversal_of_voided_payment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_original_void_id uuid;
BEGIN
  IF NEW.reversal_of_transaction_id IS NOT NULL THEN
    SELECT original.void_id
    INTO v_original_void_id
    FROM public.payment_transactions AS original
    WHERE original.id = NEW.reversal_of_transaction_id
    FOR KEY SHARE;

    IF v_original_void_id IS NOT NULL THEN
      RAISE EXCEPTION 'Voided payment transactions cannot be reversed'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER payment_transactions_reject_voided_reversal
  BEFORE INSERT OR UPDATE OF reversal_of_transaction_id ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.reject_reversal_of_voided_payment();

CREATE OR REPLACE FUNCTION payment_accounts.payment_transaction_effective_delta(
  p_direction text,
  p_amount numeric,
  p_is_deleted boolean,
  p_void_id uuid
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN coalesce(p_is_deleted, false) OR p_void_id IS NOT NULL THEN 0::numeric
    WHEN p_direction = 'incoming' THEN coalesce(p_amount, 0)
    ELSE -coalesce(p_amount, 0)
  END;
$function$;

CREATE OR REPLACE FUNCTION payment_accounts.validate_payment_transaction_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_account payment_accounts.accounts%ROWTYPE;
  v_current_balance numeric := 0;
  v_new_delta numeric := 0;
  v_old_delta numeric := 0;
  v_balance_change numeric := 0;
  v_allow_initial_assignment boolean := false;
  v_formatted_balance text;
  v_currency_symbol text;
BEGIN
  v_allow_initial_assignment := TG_OP = 'UPDATE'
    AND current_setting('payment_accounts.allow_initial_assignment', true) = 'on'
    AND OLD.account_id IS NULL
    AND NEW.account_id IS NOT NULL;

  IF TG_OP = 'UPDATE'
    AND (OLD.account_id IS NOT NULL OR NEW.account_id IS NOT NULL)
    AND NOT v_allow_initial_assignment
    AND (
      NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.direction IS DISTINCT FROM OLD.direction
      OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
      OR NEW.account_name_snapshot IS DISTINCT FROM OLD.account_name_snapshot
    ) THEN
    RAISE EXCEPTION 'A posted payment account link cannot be changed; reverse and record a replacement payment instead'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT payment_accounts.module_allowed(NEW.workspace_id, 'payment_accounts') THEN
    RAISE EXCEPTION 'Payment Accounts is not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_account
  FROM payment_accounts.accounts
  WHERE id = NEW.account_id
    AND workspace_id = NEW.workspace_id
    AND NOT is_deleted
  FOR UPDATE;

  IF NOT FOUND OR NOT v_account.is_active THEN
    RAISE EXCEPTION 'The selected payment account is unavailable'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    NEW.account_name_snapshot := coalesce(nullif(NEW.account_name_snapshot, ''), v_account.name);
  END IF;

  v_new_delta := payment_accounts.payment_transaction_effective_delta(
    NEW.direction, NEW.amount, NEW.is_deleted, NEW.void_id
  );
  v_old_delta := CASE
    WHEN TG_OP = 'UPDATE'
      AND OLD.account_id IS NOT NULL
      AND OLD.account_id = NEW.account_id
      AND OLD.currency = NEW.currency
    THEN payment_accounts.payment_transaction_effective_delta(
      OLD.direction, OLD.amount, OLD.is_deleted, OLD.void_id
    )
    ELSE 0
  END;
  v_balance_change := v_new_delta - v_old_delta;

  IF v_balance_change < 0 THEN
    SELECT balance_amount INTO v_current_balance
    FROM payment_accounts.account_balances
    WHERE account_id = NEW.account_id
      AND currency = NEW.currency
      AND NOT is_deleted
    FOR UPDATE;

    v_current_balance := coalesce(v_current_balance, 0);
    IF v_current_balance + v_balance_change < 0 THEN
      v_formatted_balance := trim(trailing '.' FROM trim(trailing '0' FROM to_char(v_current_balance, 'FM999G999G999G999G990D0000')));
      v_currency_symbol := CASE lower(NEW.currency)
        WHEN 'iqd' THEN 'د.ع'
        WHEN 'usd' THEN '$'
        WHEN 'eur' THEN '€'
        WHEN 'try' THEN '₺'
        ELSE upper(NEW.currency)
      END;
      RAISE EXCEPTION 'You do not have enough balance in % to proceed with this transaction. Current balance: % %.', v_account.name, v_formatted_balance, v_currency_symbol
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION payment_accounts.post_payment_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_new_delta numeric := 0;
  v_old_delta numeric := 0;
  v_balance_change numeric := 0;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.account_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.account_id IS NULL AND NEW.account_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'A posted payment account link cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;

  v_new_delta := payment_accounts.payment_transaction_effective_delta(
    NEW.direction, NEW.amount, NEW.is_deleted, NEW.void_id
  );

  IF TG_OP = 'INSERT' OR OLD.account_id IS NULL THEN
    INSERT INTO payment_accounts.account_movements (
      id, workspace_id, account_id, payment_transaction_id,
      account_name_snapshot, direction, amount, delta_amount, currency, occurred_at, void_id
    ) VALUES (
      NEW.id, NEW.workspace_id, NEW.account_id, NEW.id,
      NEW.account_name_snapshot, NEW.direction, NEW.amount, v_new_delta, NEW.currency, NEW.paid_at, NEW.void_id
    );
    v_balance_change := v_new_delta;
  ELSE
    v_old_delta := payment_accounts.payment_transaction_effective_delta(
      OLD.direction, OLD.amount, OLD.is_deleted, OLD.void_id
    );
    v_balance_change := v_new_delta - v_old_delta;

    IF OLD.is_deleted IS DISTINCT FROM NEW.is_deleted OR OLD.void_id IS DISTINCT FROM NEW.void_id THEN
      UPDATE payment_accounts.account_movements
      SET delta_amount = v_new_delta,
          amount = NEW.amount,
          occurred_at = NEW.paid_at,
          is_deleted = NEW.is_deleted,
          void_id = NEW.void_id,
          updated_at = now(),
          version = version + 1
      WHERE payment_transaction_id = NEW.id;
    END IF;
  END IF;

  IF v_balance_change <> 0 THEN
    INSERT INTO payment_accounts.account_balances (
      workspace_id, account_id, currency, balance_amount, updated_at
    ) VALUES (
      NEW.workspace_id, NEW.account_id, NEW.currency, v_balance_change, now()
    ) ON CONFLICT (account_id, currency) DO UPDATE
      SET balance_amount = payment_accounts.account_balances.balance_amount + EXCLUDED.balance_amount,
          updated_at = now(),
          version = payment_accounts.account_balances.version + 1,
          is_deleted = false;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.financial_void_result(p_void_id uuid)
RETURNS jsonb
LANGUAGE sql
SET search_path = ''
AS $function$
  SELECT jsonb_build_object(
    'void', to_jsonb(audit),
    'transactions', COALESCE((
      SELECT jsonb_agg(to_jsonb(payment) ORDER BY payment.paid_at, payment.id)
      FROM public.payment_transactions AS payment
      WHERE payment.id = ANY(audit.affected_transaction_ids)
    ), '[]'::jsonb),
    'expenseItems', COALESCE((
      SELECT jsonb_agg(to_jsonb(item))
      FROM budget.expense_items AS item
      WHERE item.id = audit.source_record_id
        AND item.void_id = audit.id
    ), '[]'::jsonb),
    'expenseSeries', COALESCE((
      SELECT jsonb_agg(to_jsonb(series))
      FROM budget.expense_series AS series
      WHERE series.id = audit.source_subrecord_id
        AND series.void_id = audit.id
    ), '[]'::jsonb),
    'movements', COALESCE((
      SELECT jsonb_agg(to_jsonb(movement))
      FROM payment_accounts.account_movements AS movement
      WHERE movement.payment_transaction_id = ANY(audit.affected_transaction_ids)
    ), '[]'::jsonb),
    'balances', COALESCE((
      SELECT jsonb_agg(to_jsonb(balance))
      FROM payment_accounts.account_balances AS balance
      WHERE EXISTS (
        SELECT 1
        FROM public.payment_transactions AS payment
        WHERE payment.id = ANY(audit.affected_transaction_ids)
          AND payment.account_id = balance.account_id
          AND payment.currency = balance.currency
      )
    ), '[]'::jsonb)
  )
  FROM public.financial_transaction_voids AS audit
  WHERE audit.id = p_void_id;
$function$;

CREATE OR REPLACE FUNCTION private.void_financial_transaction(
  p_workspace_id uuid,
  p_payment_transaction_id uuid,
  p_reason text,
  p_cash_movement_declaration text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_requested public.payment_transactions%ROWTYPE;
  v_item budget.expense_items%ROWTYPE;
  v_series budget.expense_series%ROWTYPE;
  v_void public.financial_transaction_voids%ROWTYPE;
  v_root_id uuid;
  v_transaction_ids uuid[];
  v_series_id uuid;
  v_item_found boolean := false;
  v_series_found boolean := false;
  v_source_unavailable boolean := false;
  v_void_source_records boolean := false;
  v_source_snapshot jsonb;
  v_transaction public.payment_transactions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF v_actor_id IS NULL
    OR (SELECT public.current_workspace_id()) IS DISTINCT FROM p_workspace_id
    OR (SELECT public.current_user_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only a workspace administrator can void a financial transaction'
      USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'An idempotency key is required' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'The void reason must contain between 10 and 1000 characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_cash_movement_declaration IS DISTINCT FROM 'no_money_moved' THEN
    RAISE EXCEPTION 'Confirm that no real money moved before using the void workflow'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_void
  FROM public.financial_transaction_voids
  WHERE id = p_idempotency_key;

  IF FOUND THEN
    IF v_void.workspace_id IS DISTINCT FROM p_workspace_id
      OR v_void.requested_payment_transaction_id IS DISTINCT FROM p_payment_transaction_id THEN
      RAISE EXCEPTION 'The idempotency key was already used for a different transaction'
        USING ERRCODE = '23505';
    END IF;
    RETURN private.financial_void_result(v_void.id);
  END IF;

  SELECT * INTO v_requested
  FROM public.payment_transactions
  WHERE id = p_payment_transaction_id
    AND workspace_id = p_workspace_id
    AND NOT is_deleted
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment transaction not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_requested.void_id IS NOT NULL THEN
    RETURN private.financial_void_result(v_requested.void_id);
  END IF;
  IF v_requested.source_module <> 'budget' OR v_requested.source_type <> 'expense_item' THEN
    RAISE EXCEPTION 'This transaction source does not support voiding yet'
      USING ERRCODE = '0A000';
  END IF;

  WITH RECURSIVE ancestors AS (
    SELECT payment.id, payment.reversal_of_transaction_id, ARRAY[payment.id] AS path
    FROM public.payment_transactions AS payment
    WHERE payment.id = v_requested.id
    UNION ALL
    SELECT parent.id, parent.reversal_of_transaction_id, child.path || parent.id
    FROM public.payment_transactions AS parent
    JOIN ancestors AS child ON parent.id = child.reversal_of_transaction_id
    WHERE parent.workspace_id = p_workspace_id
      AND parent.source_module = v_requested.source_module
      AND parent.source_type = v_requested.source_type
      AND parent.source_record_id = v_requested.source_record_id
      AND NOT parent.is_deleted
      AND NOT parent.id = ANY(child.path)
  )
  SELECT ancestor.id
  INTO v_root_id
  FROM ancestors AS ancestor
  WHERE ancestor.reversal_of_transaction_id IS NULL
  LIMIT 1;

  IF v_root_id IS NULL THEN
    RAISE EXCEPTION 'The payment transaction chain is missing its original entry'
      USING ERRCODE = '23514';
  END IF;

  -- Every operation on one source takes locks in the same order. This keeps the
  -- recursive chain stable and avoids deadlocks with account-balance updates.
  PERFORM payment.id
  FROM public.payment_transactions AS payment
  WHERE payment.workspace_id = p_workspace_id
    AND payment.source_module = v_requested.source_module
    AND payment.source_type = v_requested.source_type
    AND payment.source_record_id = v_requested.source_record_id
    AND NOT payment.is_deleted
  ORDER BY payment.id
  FOR UPDATE;

  WITH RECURSIVE connected AS (
    SELECT payment.id, ARRAY[payment.id] AS path
    FROM public.payment_transactions AS payment
    WHERE payment.id = v_root_id
    UNION ALL
    SELECT child.id, parent.path || child.id
    FROM public.payment_transactions AS child
    JOIN connected AS parent ON child.reversal_of_transaction_id = parent.id
    WHERE child.workspace_id = p_workspace_id
      AND child.source_module = v_requested.source_module
      AND child.source_type = v_requested.source_type
      AND child.source_record_id = v_requested.source_record_id
      AND NOT child.is_deleted
      AND NOT child.id = ANY(parent.path)
  )
  SELECT array_agg(connected.id ORDER BY connected.id)
  INTO v_transaction_ids
  FROM connected;

  IF v_transaction_ids IS NULL OR NOT v_requested.id = ANY(v_transaction_ids) THEN
    RAISE EXCEPTION 'The selected payment is not connected to its original entry'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.payment_transactions AS payment
    WHERE payment.id = ANY(v_transaction_ids)
      AND payment.void_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'The payment transaction chain is already voided or inconsistent'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_void
  FROM public.financial_transaction_voids
  WHERE root_payment_transaction_id = v_root_id;
  IF FOUND THEN
    RETURN private.financial_void_result(v_void.id);
  END IF;

  v_void_source_records := NOT EXISTS (
    SELECT 1
    FROM public.payment_transactions AS payment
    WHERE payment.workspace_id = p_workspace_id
      AND payment.source_module = v_requested.source_module
      AND payment.source_type = v_requested.source_type
      AND payment.source_record_id = v_requested.source_record_id
      AND NOT payment.is_deleted
      AND payment.void_id IS NULL
      AND NOT payment.id = ANY(v_transaction_ids)
  );

  -- Explicit allowlist branch: adding another source requires a matching
  -- source adapter here and in the local registry, never a dynamic table name.
  SELECT * INTO v_item
  FROM budget.expense_items
  WHERE id = v_requested.source_record_id
    AND workspace_id = p_workspace_id
  FOR UPDATE;
  v_item_found := FOUND;

  IF v_item_found AND v_item.is_locked THEN
    RAISE EXCEPTION 'Locked expenses cannot be voided' USING ERRCODE = '23514';
  END IF;
  IF v_item_found AND v_item.void_id IS NOT NULL THEN
    RAISE EXCEPTION 'The expense has an invalid void reference' USING ERRCODE = '23514';
  END IF;

  v_series_id := coalesce(
    CASE WHEN v_item_found THEN v_item.series_id ELSE NULL END,
    v_requested.source_subrecord_id
  );
  IF v_series_id IS NOT NULL THEN
    SELECT * INTO v_series
    FROM budget.expense_series
    WHERE id = v_series_id
      AND workspace_id = p_workspace_id
    FOR UPDATE;
    v_series_found := FOUND;
  END IF;
  IF v_series_found AND v_series.void_id IS NOT NULL THEN
    RAISE EXCEPTION 'The expense series has an invalid void reference' USING ERRCODE = '23514';
  END IF;

  v_source_unavailable := NOT v_item_found;
  IF v_source_unavailable THEN
    v_source_snapshot := jsonb_build_object(
      'sourceUnavailable', true,
      'sourceRecordsVoided', false,
      'referenceLabel', v_requested.reference_label,
      'counterpartyName', v_requested.counterparty_name,
      'metadata', v_requested.metadata
    );
  ELSE
    v_source_snapshot := jsonb_build_object(
      'sourceUnavailable', false,
      'sourceRecordsVoided', v_void_source_records,
      'expenseItem', to_jsonb(v_item),
      'expenseSeries', CASE WHEN v_series_found THEN to_jsonb(v_series) ELSE 'null'::jsonb END
    );
  END IF;

  PERFORM account.id
  FROM payment_accounts.accounts AS account
  WHERE account.id IN (
    SELECT payment.account_id
    FROM public.payment_transactions AS payment
    WHERE payment.id = ANY(v_transaction_ids)
      AND payment.account_id IS NOT NULL
  )
  ORDER BY account.id
  FOR UPDATE;

  PERFORM balance.id
  FROM payment_accounts.account_balances AS balance
  WHERE EXISTS (
    SELECT 1
    FROM public.payment_transactions AS payment
    WHERE payment.id = ANY(v_transaction_ids)
      AND payment.account_id = balance.account_id
      AND payment.currency = balance.currency
  )
  ORDER BY balance.account_id, balance.currency
  FOR UPDATE;

  SELECT coalesce(nullif(btrim(profile.name), ''), v_actor_id::text)
  INTO v_actor_name
  FROM public.profiles AS profile
  WHERE profile.id = v_actor_id;
  v_actor_name := coalesce(v_actor_name, v_actor_id::text);

  INSERT INTO public.financial_transaction_voids (
    id, workspace_id, root_payment_transaction_id, requested_payment_transaction_id,
    source_module, source_type, source_record_id, source_subrecord_id, source_unavailable,
    affected_transaction_ids, reason, cash_movement_declaration,
    voided_by, voided_by_name_snapshot, voided_at,
    source_snapshot, transaction_snapshots,
    created_at, updated_at
  ) VALUES (
    p_idempotency_key, p_workspace_id, v_root_id, v_requested.id,
    v_requested.source_module, v_requested.source_type,
    v_requested.source_record_id, v_series_id, v_source_unavailable,
    v_transaction_ids, btrim(p_reason), p_cash_movement_declaration,
    v_actor_id, v_actor_name, v_now,
    v_source_snapshot,
    (
      SELECT jsonb_agg(to_jsonb(payment) ORDER BY payment.paid_at, payment.id)
      FROM public.payment_transactions AS payment
      WHERE payment.id = ANY(v_transaction_ids)
    ),
    v_now, v_now
  )
  RETURNING * INTO v_void;

  PERFORM set_config('atlas.allow_financial_void', 'on', true);

  -- Negative deltas are neutralized first so balance validation remains valid
  -- while a chain that spans several dates is updated.
  FOR v_transaction IN
    SELECT payment.*
    FROM public.payment_transactions AS payment
    WHERE payment.id = ANY(v_transaction_ids)
    ORDER BY payment_accounts.payment_transaction_effective_delta(
      payment.direction, payment.amount, payment.is_deleted, payment.void_id
    ) ASC, payment.id
  LOOP
    UPDATE public.payment_transactions
    SET void_id = v_void.id,
        updated_at = v_now,
        version = version + 1
    WHERE id = v_transaction.id;
  END LOOP;

  IF v_void_source_records AND v_item_found THEN
    UPDATE budget.expense_items
    SET void_id = v_void.id,
        updated_at = v_now,
        version = version + 1
    WHERE id = v_item.id;

    IF v_series_found AND v_series.recurrence = 'one_time' THEN
      UPDATE budget.expense_series
      SET void_id = v_void.id,
          updated_at = v_now,
          version = version + 1
      WHERE id = v_series.id;
    END IF;
  END IF;

  RETURN private.financial_void_result(v_void.id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_financial_transaction(
  p_workspace_id uuid,
  p_payment_transaction_id uuid,
  p_reason text,
  p_cash_movement_declaration text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.void_financial_transaction(
    p_workspace_id,
    p_payment_transaction_id,
    p_reason,
    p_cash_movement_declaration,
    p_idempotency_key
  );
$function$;

REVOKE ALL ON FUNCTION private.financial_void_result(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.void_financial_transaction(uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.void_financial_transaction(uuid, uuid, text, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.void_financial_transaction(uuid, uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_financial_transaction(uuid, uuid, text, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.reject_financial_void_audit_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_financial_void_reference() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_voided_payment_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_reversal_of_voided_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payment_accounts.payment_transaction_effective_delta(text, numeric, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payment_accounts.validate_payment_transaction_account() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payment_accounts.post_payment_transaction() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
