-- Historical direct transactions retain their transaction ID as the document reference.
-- Only rows inserted after this migration receive a workspace-wide voucher number.
ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS voucher_number bigint;

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_direct_voucher_unique
  ON public.payment_transactions (workspace_id, voucher_number)
  WHERE source_type = 'direct_transaction' AND voucher_number IS NOT NULL;

CREATE SCHEMA IF NOT EXISTS atlas_private;

CREATE TABLE IF NOT EXISTS atlas_private.direct_transaction_voucher_counters (
  workspace_id uuid PRIMARY KEY,
  last_number bigint NOT NULL CHECK (last_number > 0)
);

ALTER TABLE atlas_private.direct_transaction_voucher_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON atlas_private.direct_transaction_voucher_counters FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION atlas_private.assign_direct_transaction_voucher_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A client replay or edit cannot change an already posted reference.
    NEW.voucher_number := OLD.voucher_number;
    RETURN NEW;
  END IF;

  IF NEW.source_type <> 'direct_transaction' THEN
    NEW.voucher_number := NULL;
    RETURN NEW;
  END IF;

  -- Serialize retries for the same transaction ID before incrementing the
  -- workspace counter, so concurrent idempotent upserts do not consume gaps.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.id::text, 0));

  -- A replayed upsert must keep its prior number without consuming another.
  IF EXISTS (SELECT 1 FROM public.payment_transactions WHERE id = NEW.id) THEN
    NEW.voucher_number := NULL;
    RETURN NEW;
  END IF;

  INSERT INTO atlas_private.direct_transaction_voucher_counters (workspace_id, last_number)
  VALUES (NEW.workspace_id, 1)
  ON CONFLICT (workspace_id) DO UPDATE
    SET last_number = atlas_private.direct_transaction_voucher_counters.last_number + 1
  RETURNING last_number INTO NEW.voucher_number;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION atlas_private.assign_direct_transaction_voucher_number() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS assign_direct_transaction_voucher_number ON public.payment_transactions;
CREATE TRIGGER assign_direct_transaction_voucher_number
  BEFORE INSERT OR UPDATE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION atlas_private.assign_direct_transaction_voucher_number();
