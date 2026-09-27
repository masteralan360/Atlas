-- Keep the original transfer migration stable and apply the required-reason
-- change as a follow-up schema migration.
-- Fail quickly under concurrent schema inspection so the migration can be retried
-- without forming a deadlock with Supabase Dashboard's catalog queries.
SET LOCAL lock_timeout = '500ms';

DROP TRIGGER IF EXISTS payment_account_transfers_validate ON payment_accounts.transfers;

ALTER TABLE payment_accounts.transfers
  RENAME COLUMN note TO reason;

-- Older transfers may not have included a note. Preserve those audit records
-- while clearly marking that their reason predates this requirement.
UPDATE payment_accounts.transfers
SET reason = 'Not recorded before required transfer reasons were introduced'
WHERE reason IS NULL OR length(btrim(reason)) = 0;

ALTER TABLE payment_accounts.transfers
  ALTER COLUMN reason SET NOT NULL,
  ADD CONSTRAINT payment_account_transfer_reason_nonempty
    CHECK (length(btrim(reason)) > 0);

-- The existing immutable-record trigger compares the note field. Rewrite the
-- same function to compare the renamed reason field before restoring the trigger.
DO $migration$
DECLARE
  v_function_definition text;
BEGIN
  v_function_definition := pg_get_functiondef(
    'payment_accounts.validate_payment_account_transfer()'::regprocedure
  );

  IF position('NEW.note' IN v_function_definition) = 0
    OR position('OLD.note' IN v_function_definition) = 0
  THEN
    RAISE EXCEPTION 'Payment account transfer validator does not match the expected note-based definition';
  END IF;

  v_function_definition := replace(v_function_definition, 'NEW.note', 'NEW.reason');
  v_function_definition := replace(v_function_definition, 'OLD.note', 'OLD.reason');
  EXECUTE v_function_definition;
END;
$migration$;

CREATE TRIGGER payment_account_transfers_validate
  BEFORE INSERT OR UPDATE OR DELETE ON payment_accounts.transfers
  FOR EACH ROW EXECUTE FUNCTION payment_accounts.validate_payment_account_transfer();

NOTIFY pgrst, 'reload schema';
