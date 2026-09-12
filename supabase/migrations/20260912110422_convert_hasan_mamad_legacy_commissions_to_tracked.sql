-- One-time conversion for the Hasan Mamad workspace. The workspace is resolved
-- by its operator-visible name so this migration does not persist a generated
-- workspace identifier. If that workspace is absent (for example, in a fresh
-- development database), the migration is intentionally a no-op.
--
-- This migration permanently removes the legacy payout/recovery bookkeeping
-- that was explicitly confirmed to represent no real cash movement, then moves
-- every historical sales-order commission snapshot into the nonfinancial
-- tracked lane. Exact preconditions make the operation fail closed if the live
-- data has changed since the audited backup.

DO $convert_hasan_mamad_commissions$
DECLARE
  v_workspace_id uuid;
  v_workspace_count bigint;
  v_now timestamptz := clock_timestamp();
  v_count bigint;
  v_amount numeric;
  v_mode text;
  v_data_mode text;
BEGIN
  SELECT count(*)
  INTO v_workspace_count
  FROM public.workspaces AS workspace
  WHERE workspace.name = 'کۆگای حەسەن مامەد';

  IF v_workspace_count = 0 THEN
    RAISE NOTICE 'Hasan Mamad workspace is absent; tracked-commission conversion skipped';
    RETURN;
  END IF;

  IF v_workspace_count <> 1 THEN
    RAISE EXCEPTION 'Expected one Hasan Mamad workspace, found %', v_workspace_count;
  END IF;

  SELECT workspace.id, workspace.sales_agent_commission_mode, workspace.data_mode
  INTO v_workspace_id, v_mode, v_data_mode
  FROM public.workspaces AS workspace
  WHERE workspace.name = 'کۆگای حەسەن مامەد'
  FOR UPDATE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'convert-legacy-commissions-to-tracked:' || v_workspace_id::text,
      0
    )
  );

  -- The operation is short, and these locks prevent a settlement or order sync
  -- from racing between the fingerprint checks and the final mode switch.
  LOCK TABLE
    crm.sales_orders,
    crm.agent_commission_entries,
    crm.agent_product_commission_entries,
    public.payment_transactions
  IN SHARE ROW EXCLUSIVE MODE;

  -- A previously completed migration is accepted only when the complete final
  -- fingerprint is present. This makes a manual replay safe.
  IF v_mode = 'tracked' THEN
    SELECT count(*)
    INTO v_count
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.workspace_id = v_workspace_id
      AND sales_order.commission_mode = 'tracked';
    IF v_count <> 56 OR EXISTS (
      SELECT 1
      FROM crm.sales_orders AS sales_order
      WHERE sales_order.workspace_id = v_workspace_id
        AND sales_order.commission_mode <> 'tracked'
    ) THEN
      RAISE EXCEPTION 'Tracked replay check failed for sales orders';
    END IF;

    SELECT count(*), COALESCE(sum(entry.amount), 0)
    INTO v_count, v_amount
    FROM crm.agent_commission_entries AS entry
    WHERE entry.workspace_id = v_workspace_id
      AND entry.commission_mode = 'tracked';
    IF v_count <> 56 OR abs(v_amount - 243150) > 0.000001 OR EXISTS (
      SELECT 1
      FROM crm.agent_commission_entries AS entry
      WHERE entry.workspace_id = v_workspace_id
        AND (entry.commission_mode <> 'tracked' OR entry.kind IN ('payout', 'recovery'))
    ) THEN
      RAISE EXCEPTION 'Tracked replay check failed for aggregate commission entries';
    END IF;

    SELECT count(*)
    INTO v_count
    FROM crm.agent_product_commission_entries AS entry
    WHERE entry.workspace_id = v_workspace_id
      AND entry.commission_mode = 'tracked';
    IF v_count <> 510 OR EXISTS (
      SELECT 1
      FROM crm.agent_product_commission_entries AS entry
      WHERE entry.workspace_id = v_workspace_id
        AND entry.commission_mode <> 'tracked'
    ) THEN
      RAISE EXCEPTION 'Tracked replay check failed for product commission entries';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.payment_transactions AS payment
      WHERE payment.workspace_id = v_workspace_id
        AND payment.source_type IN ('agent_commission_payout', 'agent_commission_recovery')
    ) THEN
      RAISE EXCEPTION 'Tracked replay check found commission payment transactions';
    END IF;

    RAISE NOTICE 'Hasan Mamad commissions were already converted to tracked mode';
    RETURN;
  END IF;

  IF v_mode <> 'payable' THEN
    RAISE EXCEPTION 'Unexpected workspace commission mode: %', v_mode;
  END IF;
  IF v_data_mode <> 'hybrid' THEN
    RAISE EXCEPTION 'Unexpected workspace data mode: %', v_data_mode;
  END IF;

  CREATE TEMP TABLE atlas_hasan_mamad_settlement_entries
  ON COMMIT DROP
  AS
  SELECT entry.id
  FROM crm.agent_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id
    AND entry.kind IN ('payout', 'recovery');

  CREATE UNIQUE INDEX ON atlas_hasan_mamad_settlement_entries (id);

  CREATE TEMP TABLE atlas_hasan_mamad_payment_transactions
  ON COMMIT DROP
  AS
  SELECT payment.id
  FROM public.payment_transactions AS payment
  JOIN atlas_hasan_mamad_settlement_entries AS settlement
    ON settlement.id = payment.source_subrecord_id
  WHERE payment.workspace_id = v_workspace_id
    AND payment.source_type IN ('agent_commission_payout', 'agent_commission_recovery');

  CREATE UNIQUE INDEX ON atlas_hasan_mamad_payment_transactions (id);

  -- Exact pre-conversion fingerprint from the audited production export.
  SELECT count(*)
  INTO v_count
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.workspace_id = v_workspace_id;
  IF v_count <> 56 OR EXISTS (
    SELECT 1
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.workspace_id = v_workspace_id
      AND sales_order.commission_mode <> 'payable'
  ) THEN
    RAISE EXCEPTION 'Sales-order fingerprint changed; expected 56 payable rows';
  END IF;

  SELECT count(*), COALESCE(sum(entry.amount), 0)
  INTO v_count, v_amount
  FROM crm.agent_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id;
  IF v_count <> 84 OR abs(v_amount - 58050) > 0.000001 OR EXISTS (
    SELECT 1
    FROM crm.agent_commission_entries AS entry
    WHERE entry.workspace_id = v_workspace_id
      AND entry.commission_mode <> 'payable'
  ) THEN
    RAISE EXCEPTION 'Aggregate commission fingerprint changed; expected 84 payable rows with 58,050 net';
  END IF;

  SELECT count(*)
  INTO v_count
  FROM atlas_hasan_mamad_settlement_entries;
  IF v_count <> 28 THEN
    RAISE EXCEPTION 'Settlement fingerprint changed; expected 28 rows, found %', v_count;
  END IF;

  SELECT count(*)
  INTO v_count
  FROM crm.agent_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id
    AND entry.kind NOT IN ('payout', 'recovery');
  IF v_count <> 56 THEN
    RAISE EXCEPTION 'Recognized commission fingerprint changed; expected 56 rows, found %', v_count;
  END IF;

  SELECT COALESCE(sum(entry.amount), 0)
  INTO v_amount
  FROM crm.agent_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id
    AND entry.kind NOT IN ('payout', 'recovery');
  IF abs(v_amount - 243150) > 0.000001 THEN
    RAISE EXCEPTION 'Recognized commission amount changed; expected 243,150, found %', v_amount;
  END IF;

  SELECT count(*)
  INTO v_count
  FROM crm.agent_product_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id;
  IF v_count <> 510 OR EXISTS (
    SELECT 1
    FROM crm.agent_product_commission_entries AS entry
    WHERE entry.workspace_id = v_workspace_id
      AND entry.commission_mode <> 'payable'
  ) THEN
    RAISE EXCEPTION 'Product commission fingerprint changed; expected 510 payable rows';
  END IF;

  SELECT count(*), COALESCE(sum(abs(payment.amount)), 0)
  INTO v_count, v_amount
  FROM public.payment_transactions AS payment
  WHERE payment.workspace_id = v_workspace_id
    AND payment.source_type IN ('agent_commission_payout', 'agent_commission_recovery');
  IF v_count <> 28 OR abs(v_amount - 231700) > 0.000001 THEN
    RAISE EXCEPTION 'Payment fingerprint changed; expected 28 rows totaling 231,700, found % rows totaling %', v_count, v_amount;
  END IF;

  SELECT count(*)
  INTO v_count
  FROM atlas_hasan_mamad_payment_transactions;
  IF v_count <> 28 THEN
    RAISE EXCEPTION 'Payment-to-settlement links changed; expected 28 exact links, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.payment_transactions AS payment
    JOIN atlas_hasan_mamad_payment_transactions AS target ON target.id = payment.id
    WHERE payment.account_id IS NOT NULL
      OR payment.void_id IS NOT NULL
      OR payment.reversal_of_transaction_id IS NOT NULL
      OR payment.is_deleted
  ) THEN
    RAISE EXCEPTION 'A target commission payment is account-linked, voided, reversed, or deleted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.payment_transactions AS child
    JOIN atlas_hasan_mamad_payment_transactions AS target
      ON target.id = child.reversal_of_transaction_id
  ) THEN
    RAISE EXCEPTION 'A target commission payment has a reversal child';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM payment_accounts.account_movements AS movement
    JOIN atlas_hasan_mamad_payment_transactions AS target
      ON target.id = movement.payment_transaction_id
  ) THEN
    RAISE EXCEPTION 'A target commission payment has a payment-account movement';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.financial_transaction_voids AS audit
    WHERE audit.root_payment_transaction_id IN (
      SELECT target.id FROM atlas_hasan_mamad_payment_transactions AS target
    )
       OR audit.requested_payment_transaction_id IN (
      SELECT target.id FROM atlas_hasan_mamad_payment_transactions AS target
    )
  ) THEN
    RAISE EXCEPTION 'A target commission payment is referenced by a financial void audit';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM crm.agent_commission_entries AS child
    JOIN atlas_hasan_mamad_settlement_entries AS target
      ON target.id = child.related_entry_id
  ) THEN
    RAISE EXCEPTION 'A target settlement entry has dependent commission entries';
  END IF;

  -- Remove only the exact audited payment rows. These payments have no payment
  -- account movement and no real cash effect, so no counter-entry is required.
  DELETE FROM public.payment_transactions AS payment
  USING atlas_hasan_mamad_payment_transactions AS target
  WHERE payment.id = target.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 28 THEN
    RAISE EXCEPTION 'Expected to delete 28 commission payments, deleted %', v_count;
  END IF;

  -- The private context is the existing transaction-local escape hatch for the
  -- immutable aggregate commission ledger. It authorizes exactly these rows in
  -- this transaction and nothing outside it.
  INSERT INTO private.agent_commission_entry_compaction_context (entry_id, transaction_id)
  SELECT entry.id, pg_catalog.txid_current()
  FROM crm.agent_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id
  ON CONFLICT (entry_id) DO UPDATE
    SET transaction_id = EXCLUDED.transaction_id;

  DELETE FROM crm.agent_commission_entries AS entry
  USING atlas_hasan_mamad_settlement_entries AS target
  WHERE entry.id = target.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 28 THEN
    RAISE EXCEPTION 'Expected to delete 28 settlement entries, deleted %', v_count;
  END IF;

  -- The mode snapshot and partner-visibility triggers reject any historical
  -- order rewrite. Disable only those two triggers for this guarded transaction;
  -- all other sales-order validation remains active.
  EXECUTE 'ALTER TABLE crm.sales_orders DISABLE TRIGGER snapshot_sales_order_commission_mode';
  EXECUTE 'ALTER TABLE crm.sales_orders DISABLE TRIGGER enforce_visible_partner_link_on_sales_orders';

  UPDATE crm.sales_orders AS sales_order
  SET commission_mode = 'tracked',
      commission_mode_captured_at = v_now,
      updated_at = v_now,
      version = sales_order.version + 1
  WHERE sales_order.workspace_id = v_workspace_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  EXECUTE 'ALTER TABLE crm.sales_orders ENABLE TRIGGER enforce_visible_partner_link_on_sales_orders';
  EXECUTE 'ALTER TABLE crm.sales_orders ENABLE TRIGGER snapshot_sales_order_commission_mode';

  IF v_count <> 56 THEN
    RAISE EXCEPTION 'Expected to convert 56 sales orders, converted %', v_count;
  END IF;

  UPDATE crm.agent_commission_entries AS entry
  SET commission_mode = 'tracked',
      updated_at = v_now
  WHERE entry.workspace_id = v_workspace_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 56 THEN
    RAISE EXCEPTION 'Expected to convert 56 aggregate commission entries, converted %', v_count;
  END IF;

  DELETE FROM private.agent_commission_entry_compaction_context AS context
  WHERE context.transaction_id = pg_catalog.txid_current();

  -- Product commission snapshots are also immutable. Keep their mode-assignment
  -- trigger enabled so it independently confirms every linked order is tracked,
  -- while disabling only the generic immutability trigger for this conversion.
  EXECUTE 'ALTER TABLE crm.agent_product_commission_entries DISABLE TRIGGER enforce_agent_product_commission_entry_row';

  UPDATE crm.agent_product_commission_entries AS entry
  SET commission_mode = 'tracked',
      updated_at = v_now,
      version = entry.version + 1
  WHERE entry.workspace_id = v_workspace_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  EXECUTE 'ALTER TABLE crm.agent_product_commission_entries ENABLE TRIGGER enforce_agent_product_commission_entry_row';

  IF v_count <> 510 THEN
    RAISE EXCEPTION 'Expected to convert 510 product commission entries, converted %', v_count;
  END IF;

  UPDATE public.workspaces AS workspace
  SET sales_agent_commission_mode = 'tracked',
      sales_agent_commission_mode_changed_at = v_now,
      sales_agent_commission_mode_changed_by = NULL
  WHERE workspace.id = v_workspace_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected to convert one workspace setting, converted %', v_count;
  END IF;

  -- Final checks are part of the same transaction. Any mismatch rolls back the
  -- payment purge, settlement deletion, and all mode changes together.
  SELECT count(*)
  INTO v_count
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.workspace_id = v_workspace_id
    AND sales_order.commission_mode = 'tracked';
  IF v_count <> 56 OR EXISTS (
    SELECT 1
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.workspace_id = v_workspace_id
      AND sales_order.commission_mode <> 'tracked'
  ) THEN
    RAISE EXCEPTION 'Postcondition failed for sales orders';
  END IF;

  SELECT count(*), COALESCE(sum(entry.amount), 0)
  INTO v_count, v_amount
  FROM crm.agent_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id
    AND entry.commission_mode = 'tracked';
  IF v_count <> 56 OR abs(v_amount - 243150) > 0.000001 OR EXISTS (
    SELECT 1
    FROM crm.agent_commission_entries AS entry
    WHERE entry.workspace_id = v_workspace_id
      AND (entry.commission_mode <> 'tracked' OR entry.kind IN ('payout', 'recovery'))
  ) THEN
    RAISE EXCEPTION 'Postcondition failed for aggregate commission entries';
  END IF;

  SELECT count(*)
  INTO v_count
  FROM crm.agent_product_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id
    AND entry.commission_mode = 'tracked';
  IF v_count <> 510 OR EXISTS (
    SELECT 1
    FROM crm.agent_product_commission_entries AS entry
    WHERE entry.workspace_id = v_workspace_id
      AND entry.commission_mode <> 'tracked'
  ) THEN
    RAISE EXCEPTION 'Postcondition failed for product commission entries';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.payment_transactions AS payment
    WHERE payment.workspace_id = v_workspace_id
      AND payment.source_type IN ('agent_commission_payout', 'agent_commission_recovery')
  ) THEN
    RAISE EXCEPTION 'Postcondition failed: commission payments remain';
  END IF;

  SELECT workspace.sales_agent_commission_mode
  INTO v_mode
  FROM public.workspaces AS workspace
  WHERE workspace.id = v_workspace_id;
  IF v_mode <> 'tracked' THEN
    RAISE EXCEPTION 'Postcondition failed for workspace commission mode';
  END IF;
END;
$convert_hasan_mamad_commissions$;
