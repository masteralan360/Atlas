CREATE TABLE IF NOT EXISTS payment_accounts.transfers (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  from_account_id uuid NOT NULL REFERENCES payment_accounts.accounts(id) ON DELETE RESTRICT,
  from_account_name_snapshot text NOT NULL,
  to_account_id uuid NOT NULL REFERENCES payment_accounts.accounts(id) ON DELETE RESTRICT,
  to_account_name_snapshot text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency IN ('usd', 'eur', 'iqd', 'try')),
  occurred_at timestamptz NOT NULL,
  note text,
  created_by uuid REFERENCES auth.users(id),
  outgoing_movement_id uuid NOT NULL UNIQUE,
  incoming_movement_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT payment_account_transfer_distinct_accounts CHECK (from_account_id <> to_account_id),
  CONSTRAINT payment_account_transfer_distinct_movements CHECK (outgoing_movement_id <> incoming_movement_id),
  CONSTRAINT payment_account_transfer_not_deleted CHECK (NOT is_deleted)
);

CREATE INDEX IF NOT EXISTS payment_account_transfers_workspace_time
  ON payment_accounts.transfers (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS payment_account_transfers_from_account_time
  ON payment_accounts.transfers (workspace_id, from_account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS payment_account_transfers_to_account_time
  ON payment_accounts.transfers (workspace_id, to_account_id, occurred_at DESC);

ALTER TABLE payment_accounts.account_movements
  ALTER COLUMN payment_transaction_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS transfer_id uuid REFERENCES payment_accounts.transfers(id) ON DELETE RESTRICT;

ALTER TABLE payment_accounts.account_movements
  ADD CONSTRAINT payment_account_movements_exactly_one_source
  CHECK ((payment_transaction_id IS NOT NULL) <> (transfer_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS payment_account_movements_transfer_account_unique
  ON payment_accounts.account_movements (transfer_id, account_id)
  WHERE transfer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION payment_accounts.validate_payment_account_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, payment_accounts
AS $function$
DECLARE
  v_role text;
  v_from_account_name text;
  v_to_account_name text;
  v_current_balance numeric := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment account transfers are immutable audit records'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.id, NEW.workspace_id, NEW.from_account_id, NEW.to_account_id, NEW.amount, NEW.currency,
      NEW.occurred_at, NEW.note, NEW.outgoing_movement_id, NEW.incoming_movement_id,
      NEW.created_by, NEW.created_at, NEW.is_deleted
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.workspace_id, OLD.from_account_id, OLD.to_account_id, OLD.amount, OLD.currency,
      OLD.occurred_at, OLD.note, OLD.outgoing_movement_id, OLD.incoming_movement_id,
      OLD.created_by, OLD.created_at, OLD.is_deleted
    ) THEN
      RAISE EXCEPTION 'Payment account transfers are immutable audit records'
        USING ERRCODE = '23514';
    END IF;
    NEW.from_account_name_snapshot := OLD.from_account_name_snapshot;
    NEW.to_account_name_snapshot := OLD.to_account_name_snapshot;
    NEW.updated_at := OLD.updated_at;
    NEW.version := OLD.version;
    RETURN NEW;
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR NOT payment_accounts.module_allowed(NEW.workspace_id, 'payment_accounts')
  THEN
    RAISE EXCEPTION 'You are not allowed to transfer funds in this workspace'
      USING ERRCODE = '42501';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_role := public.current_user_role();
    IF v_role IS NULL OR v_role NOT IN ('admin', 'staff') THEN
      RAISE EXCEPTION 'Only authorized payment-account operators can transfer funds'
        USING ERRCODE = '42501';
    END IF;
    NEW.created_by := auth.uid();
  END IF;

  IF NEW.from_account_id = NEW.to_account_id OR NEW.amount <= 0
    OR NEW.currency NOT IN ('usd', 'eur', 'iqd', 'try')
    OR NEW.is_deleted
  THEN
    RAISE EXCEPTION 'Invalid payment account transfer'
      USING ERRCODE = '23514';
  END IF;

  -- Lock both accounts in a stable order to serialize concurrent transfers.
  PERFORM account.id
  FROM payment_accounts.accounts AS account
  WHERE account.id IN (NEW.from_account_id, NEW.to_account_id)
    AND account.workspace_id = NEW.workspace_id
    AND account.is_active
    AND NOT account.is_deleted
  ORDER BY account.id
  FOR UPDATE;

  SELECT name
    INTO v_from_account_name
  FROM payment_accounts.accounts
  WHERE id = NEW.from_account_id
    AND workspace_id = NEW.workspace_id
    AND is_active AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The source payment account is unavailable'
      USING ERRCODE = '23503';
  END IF;

  IF auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM payment_accounts.account_member_restrictions AS restriction
    WHERE restriction.workspace_id = NEW.workspace_id
      AND restriction.account_id = NEW.from_account_id
      AND restriction.user_id = auth.uid()
      AND NOT restriction.is_deleted
  ) THEN
    RAISE EXCEPTION 'You do not have access to the source payment account'
      USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_to_account_name
  FROM payment_accounts.accounts
  WHERE id = NEW.to_account_id
    AND workspace_id = NEW.workspace_id
    AND is_active AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The destination payment account is unavailable'
      USING ERRCODE = '23503';
  END IF;

  SELECT balance_amount INTO v_current_balance
  FROM payment_accounts.account_balances
  WHERE account_id = NEW.from_account_id
    AND workspace_id = NEW.workspace_id
    AND currency = NEW.currency
    AND NOT is_deleted
  FOR UPDATE;
  v_current_balance := coalesce(v_current_balance, 0);

  -- Match the existing withdrawal workflow: payment accounts cannot overdraw.
  IF v_current_balance - NEW.amount < 0 THEN
    RAISE EXCEPTION 'payment_account_transfer_insufficient_funds'
      USING ERRCODE = '23514';
  END IF;

  NEW.from_account_name_snapshot := v_from_account_name;
  NEW.to_account_name_snapshot := v_to_account_name;
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.updated_at := coalesce(NEW.updated_at, NEW.created_at);
  NEW.version := greatest(coalesce(NEW.version, 1), 1);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION payment_accounts.post_payment_account_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, payment_accounts
AS $function$
DECLARE
  v_now timestamptz := now();
BEGIN
  INSERT INTO payment_accounts.account_movements (
    id, workspace_id, account_id, payment_transaction_id, transfer_id,
    account_name_snapshot, direction, amount, delta_amount, currency,
    occurred_at, created_at, updated_at, version, is_deleted
  ) VALUES
    (
      NEW.outgoing_movement_id, NEW.workspace_id, NEW.from_account_id, NULL, NEW.id,
      NEW.from_account_name_snapshot, 'outgoing', NEW.amount, -NEW.amount, NEW.currency,
      NEW.occurred_at, NEW.created_at, v_now, 1, false
    ),
    (
      NEW.incoming_movement_id, NEW.workspace_id, NEW.to_account_id, NULL, NEW.id,
      NEW.to_account_name_snapshot, 'incoming', NEW.amount, NEW.amount, NEW.currency,
      NEW.occurred_at, NEW.created_at, v_now, 1, false
    );

  INSERT INTO payment_accounts.account_balances (
    workspace_id, account_id, currency, balance_amount, created_at, updated_at, version, is_deleted
  ) VALUES
    (NEW.workspace_id, NEW.from_account_id, NEW.currency, -NEW.amount, v_now, v_now, 1, false),
    (NEW.workspace_id, NEW.to_account_id, NEW.currency, NEW.amount, v_now, v_now, 1, false)
  ON CONFLICT (account_id, currency) DO UPDATE
    SET balance_amount = payment_accounts.account_balances.balance_amount + EXCLUDED.balance_amount,
        updated_at = EXCLUDED.updated_at,
        version = payment_accounts.account_balances.version + 1,
        is_deleted = false;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS payment_account_transfers_validate ON payment_accounts.transfers;
CREATE TRIGGER payment_account_transfers_validate
  BEFORE INSERT OR UPDATE OR DELETE ON payment_accounts.transfers
  FOR EACH ROW EXECUTE FUNCTION payment_accounts.validate_payment_account_transfer();

DROP TRIGGER IF EXISTS payment_account_transfers_post ON payment_accounts.transfers;
CREATE TRIGGER payment_account_transfers_post
  AFTER INSERT ON payment_accounts.transfers
  FOR EACH ROW EXECUTE FUNCTION payment_accounts.post_payment_account_transfer();

ALTER TABLE payment_accounts.transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_account_transfers_access ON payment_accounts.transfers
  FOR ALL TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND payment_accounts.module_allowed(workspace_id, 'payment_accounts')
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND payment_accounts.module_allowed(workspace_id, 'payment_accounts')
  );

GRANT SELECT, INSERT, UPDATE ON payment_accounts.transfers TO authenticated, service_role;
GRANT ALL ON payment_accounts.transfers TO service_role;

REVOKE ALL ON FUNCTION payment_accounts.validate_payment_account_transfer() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payment_accounts.post_payment_account_transfer() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
