-- MANUAL, WORKSPACE-SCOPED DATA MIGRATION.
--
-- This backfills the 15 completed unpaid/partially-paid orders that were
-- completed before unpaid orders became commission-eligible. It also resets
-- every existing order-linked commission settlement in this workspace to an
-- unpaid state by recording a linked counter-settlement and a linked payment
-- counter-transaction. Original entries are never edited or deleted.
--
-- The matching rollback script is deliberately kept out of supabase/migrations
-- so `supabase db push` cannot apply it automatically:
--   supabase/manual-rollbacks/20260912031813_rollback_workspace_sales_agent_commissions_and_reset_settlements.sql
--
-- Safety guards intentionally make this fail instead of partially applying if
-- the workspace data has changed from the reviewed 12 September 2026 state.

BEGIN;

CREATE TABLE IF NOT EXISTS private.sa_commission_reset_20260912_backfill_orders (
  order_id uuid PRIMARY KEY REFERENCES crm.sales_orders(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  reconciled_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid)
);

CREATE TABLE IF NOT EXISTS private.sa_commission_reset_20260912_backfill_entries (
  entry_id uuid PRIMARY KEY,
  entry_type text NOT NULL CHECK (entry_type IN ('aggregate', 'product')),
  order_id uuid NOT NULL REFERENCES crm.sales_orders(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid)
);

CREATE TABLE IF NOT EXISTS private.sa_commission_reset_20260912_settlement_resets (
  original_commission_entry_id uuid PRIMARY KEY REFERENCES crm.agent_commission_entries(id) ON DELETE RESTRICT,
  counter_commission_entry_id uuid NOT NULL UNIQUE REFERENCES crm.agent_commission_entries(id) ON DELETE RESTRICT,
  original_payment_transaction_id uuid NOT NULL UNIQUE REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  counter_payment_transaction_id uuid NOT NULL UNIQUE REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  original_kind text NOT NULL CHECK (original_kind IN ('payout', 'recovery')),
  reset_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reset_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid)
);

ALTER TABLE private.sa_commission_reset_20260912_backfill_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.sa_commission_reset_20260912_backfill_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.sa_commission_reset_20260912_settlement_resets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.sa_commission_reset_20260912_backfill_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.sa_commission_reset_20260912_backfill_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.sa_commission_reset_20260912_settlement_resets FROM PUBLIC, anon, authenticated;

DO $backfill$
DECLARE
  v_workspace_id constant uuid := '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid;
  v_actor_id uuid;
  v_order_id uuid;
  v_target_count integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_backfill_orders
  ) OR EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_backfill_entries
  ) THEN
    RAISE EXCEPTION 'Sales-agent commission backfill reset was already recorded; use its rollback migration rather than rerunning this migration'
      USING ERRCODE = '23505';
  END IF;

  SELECT profile.id
  INTO v_actor_id
  FROM public.profiles AS profile
  JOIN auth.users AS account ON account.id = profile.id
  WHERE profile.current_workspace = v_workspace_id
    AND profile.role = 'admin'
  ORDER BY profile.updated_at DESC NULLS LAST, profile.id
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'No current workspace administrator is available to attribute the commission backfill'
      USING ERRCODE = '23514';
  END IF;

  -- The existing reconciliation RPC intentionally requires an authenticated
  -- workspace user. Scope that identity to this transaction only so the
  -- existing calculation, locking, and immutable-ledger code remains the sole
  -- writer for the backfilled commission snapshots.
  PERFORM set_config('request.jwt.claim.sub', v_actor_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  INSERT INTO private.sa_commission_reset_20260912_backfill_orders (
    order_id,
    workspace_id,
    reconciled_by
  )
  SELECT
    sales_order.id,
    sales_order.workspace_id,
    v_actor_id
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.workspace_id = v_workspace_id
    AND sales_order.status = 'completed'
    AND COALESCE(sales_order.commission_enabled, false)
    AND NOT COALESCE(sales_order.is_deleted, false)
    AND COALESCE(sales_order.return_status, 'none') <> 'full'
    AND EXISTS (
      SELECT 1
      FROM crm.sales_order_agent_assignments AS assignment
      WHERE assignment.workspace_id = sales_order.workspace_id
        AND assignment.order_id = sales_order.id
        AND NOT assignment.is_deleted
        AND assignment.unassigned_at IS NULL
    )
    -- Only orders with no prior commission snapshot are in scope. This avoids
    -- changing an order that has already been partially reconciled by a user.
    AND NOT EXISTS (
      SELECT 1
      FROM crm.agent_commission_entries AS entry
      WHERE entry.workspace_id = sales_order.workspace_id
        AND entry.order_id = sales_order.id
        AND NOT entry.is_deleted
    )
    AND NOT EXISTS (
      SELECT 1
      FROM crm.agent_product_commission_entries AS entry
      WHERE entry.workspace_id = sales_order.workspace_id
        AND entry.order_id = sales_order.id
        AND NOT entry.is_deleted
    )
  ORDER BY sales_order.order_number;

  SELECT count(*) INTO v_target_count
  FROM private.sa_commission_reset_20260912_backfill_orders;

  -- This is the reviewed set: SO-2026-00008 through SO-2026-00048, excluding
  -- orders that already had a historical commission snapshot.
  IF v_target_count <> 15 THEN
    RAISE EXCEPTION 'Expected exactly 15 unbackfilled eligible orders in workspace %, found %. Review the data and update this manual migration before deployment.', v_workspace_id, v_target_count
      USING ERRCODE = '23514';
  END IF;

  FOR v_order_id IN
    SELECT order_id
    FROM private.sa_commission_reset_20260912_backfill_orders
    ORDER BY order_id
  LOOP
    PERFORM public.reconcile_sales_agent_commission(v_order_id, NULL);
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_backfill_orders AS target
    WHERE NOT EXISTS (
      SELECT 1
      FROM crm.agent_commission_entries AS entry
      WHERE entry.workspace_id = target.workspace_id
        AND entry.order_id = target.order_id
        AND NOT entry.is_deleted
    )
  ) THEN
    RAISE EXCEPTION 'At least one selected order did not produce a payable sales-agent commission entry; no partial backfill was committed'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO private.sa_commission_reset_20260912_backfill_entries (
    entry_id,
    entry_type,
    order_id,
    workspace_id
  )
  SELECT
    entry.id,
    'aggregate',
    entry.order_id,
    entry.workspace_id
  FROM crm.agent_commission_entries AS entry
  JOIN private.sa_commission_reset_20260912_backfill_orders AS target
    ON target.workspace_id = entry.workspace_id
   AND target.order_id = entry.order_id;

  INSERT INTO private.sa_commission_reset_20260912_backfill_entries (
    entry_id,
    entry_type,
    order_id,
    workspace_id
  )
  SELECT
    entry.id,
    'product',
    entry.order_id,
    entry.workspace_id
  FROM crm.agent_product_commission_entries AS entry
  JOIN private.sa_commission_reset_20260912_backfill_orders AS target
    ON target.workspace_id = entry.workspace_id
   AND target.order_id = entry.order_id;

  IF NOT EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_backfill_entries
    WHERE entry_type = 'aggregate'
  ) THEN
    RAISE EXCEPTION 'Commission reconciliation produced no aggregate ledger entries; no partial backfill was committed'
      USING ERRCODE = '23514';
  END IF;
END;
$backfill$;

-- A counter-settlement needs to take an already settled order from a zero
-- balance back to unpaid. The normal per-order settlement guard deliberately
-- disallows that operation, so disable only that one guard for the controlled
-- counter-entries below. The general immutable-ledger trigger remains enabled.
ALTER TABLE crm.agent_commission_entries
  DISABLE TRIGGER validate_order_linked_agent_commission_payout;

DO $reset_settlements$
DECLARE
  v_workspace_id constant uuid := '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid;
  v_actor_id uuid;
  v_total_settlements integer;
  v_payout_count integer;
  v_recovery_count integer;
  v_matched_settlements integer;
  v_original record;
  v_counter_kind text;
  v_counter_entry_id uuid;
  v_counter_payment_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_settlement_resets
  ) THEN
    RAISE EXCEPTION 'Sales-agent commission settlements were already reset; use its rollback migration rather than rerunning this migration'
      USING ERRCODE = '23505';
  END IF;

  SELECT profile.id
  INTO v_actor_id
  FROM public.profiles AS profile
  JOIN auth.users AS account ON account.id = profile.id
  WHERE profile.current_workspace = v_workspace_id
    AND profile.role = 'admin'
  ORDER BY profile.updated_at DESC NULLS LAST, profile.id
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'No current workspace administrator is available to attribute the settlement reset'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_actor_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  SELECT
    count(*),
    count(*) FILTER (WHERE entry.kind = 'payout'),
    count(*) FILTER (WHERE entry.kind = 'recovery')
  INTO v_total_settlements, v_payout_count, v_recovery_count
  FROM crm.agent_commission_entries AS entry
  WHERE entry.workspace_id = v_workspace_id
    AND entry.order_id IS NOT NULL
    AND entry.kind IN ('payout', 'recovery')
    AND entry.status = 'paid'
    AND NOT entry.is_deleted;

  -- The reviewed workspace has 26 payouts and 2 recoveries. Recoveries must
  -- be reset too; otherwise an earlier overpayment would remain as a false
  -- receivable after all payouts were returned to unpaid.
  IF v_total_settlements <> 28 OR v_payout_count <> 26 OR v_recovery_count <> 2 THEN
    RAISE EXCEPTION 'Expected 26 commission payouts and 2 commission recoveries in workspace %, found % payouts and % recoveries. Review before deployment.', v_workspace_id, v_payout_count, v_recovery_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_matched_settlements
  FROM crm.agent_commission_entries AS entry
  JOIN public.payment_transactions AS payment
    ON payment.workspace_id = entry.workspace_id
   AND payment.source_subrecord_id = entry.id
   AND payment.source_record_id = entry.agent_id
   AND payment.source_type = CASE
     WHEN entry.kind = 'payout' THEN 'agent_commission_payout'
     ELSE 'agent_commission_recovery'
   END
   AND payment.direction = CASE
     WHEN entry.kind = 'payout' THEN 'outgoing'
     ELSE 'incoming'
   END
   AND abs(payment.amount - abs(entry.amount)) <= 0.000001
   AND lower(payment.currency) = lower(entry.currency)
   AND payment.reversal_of_transaction_id IS NULL
   AND payment.void_id IS NULL
   AND NOT payment.is_deleted
  WHERE entry.workspace_id = v_workspace_id
    AND entry.order_id IS NOT NULL
    AND entry.kind IN ('payout', 'recovery')
    AND entry.status = 'paid'
    AND NOT entry.is_deleted;

  IF v_matched_settlements <> v_total_settlements OR EXISTS (
    SELECT 1
    FROM crm.agent_commission_entries AS entry
    LEFT JOIN public.payment_transactions AS payment
      ON payment.workspace_id = entry.workspace_id
     AND payment.source_subrecord_id = entry.id
     AND payment.source_record_id = entry.agent_id
     AND payment.source_type = CASE
       WHEN entry.kind = 'payout' THEN 'agent_commission_payout'
       ELSE 'agent_commission_recovery'
     END
     AND payment.direction = CASE
       WHEN entry.kind = 'payout' THEN 'outgoing'
       ELSE 'incoming'
     END
     AND abs(payment.amount - abs(entry.amount)) <= 0.000001
     AND lower(payment.currency) = lower(entry.currency)
     AND payment.reversal_of_transaction_id IS NULL
     AND payment.void_id IS NULL
     AND NOT payment.is_deleted
    WHERE entry.workspace_id = v_workspace_id
      AND entry.order_id IS NOT NULL
      AND entry.kind IN ('payout', 'recovery')
      AND entry.status = 'paid'
      AND NOT entry.is_deleted
    GROUP BY entry.id
    HAVING count(payment.id) <> 1
  ) THEN
    RAISE EXCEPTION 'Every paid order-linked commission settlement must have exactly one active matching payment transaction'
      USING ERRCODE = '23514';
  END IF;

  -- Payouts are reset first. Their positive recovery counters create the
  -- balance needed to safely counter any later recovery with a payout.
  FOR v_original IN
    SELECT
      entry.*,
      payment.id AS payment_transaction_id,
      payment.source_module AS payment_source_module,
      payment.payment_method,
      payment.account_id,
      payment.account_name_snapshot,
      payment.counterparty_name,
      payment.reference_label,
      payment.note AS payment_note,
      payment.metadata AS payment_metadata
    FROM crm.agent_commission_entries AS entry
    JOIN public.payment_transactions AS payment
      ON payment.workspace_id = entry.workspace_id
     AND payment.source_subrecord_id = entry.id
     AND payment.source_record_id = entry.agent_id
     AND payment.source_type = CASE
       WHEN entry.kind = 'payout' THEN 'agent_commission_payout'
       ELSE 'agent_commission_recovery'
     END
     AND payment.direction = CASE
       WHEN entry.kind = 'payout' THEN 'outgoing'
       ELSE 'incoming'
     END
     AND abs(payment.amount - abs(entry.amount)) <= 0.000001
     AND lower(payment.currency) = lower(entry.currency)
     AND payment.reversal_of_transaction_id IS NULL
     AND payment.void_id IS NULL
     AND NOT payment.is_deleted
    WHERE entry.workspace_id = v_workspace_id
      AND entry.order_id IS NOT NULL
      AND entry.kind IN ('payout', 'recovery')
      AND entry.status = 'paid'
      AND NOT entry.is_deleted
    ORDER BY CASE entry.kind WHEN 'payout' THEN 0 ELSE 1 END,
      entry.occurred_at,
      entry.id
    FOR UPDATE OF entry, payment
  LOOP
    v_counter_kind := CASE
      WHEN v_original.kind = 'payout' THEN 'recovery'
      ELSE 'payout'
    END;

    INSERT INTO crm.agent_commission_entries (
      id, workspace_id, order_id, assignment_id, agent_id, membership_id,
      plan_id, order_return_id, related_entry_id, kind, status, currency,
      calculation_basis, include_tax, include_delivery_charge, basis_amount,
      revenue_amount, cost_amount, tax_amount, delivery_charge_amount,
      rate_percent, plan_commission_amount, product_commission_amount, amount,
      occurred_at, payout_reference, settlement_source, notes, created_by,
      created_at, updated_at, sync_status, version, is_deleted
    ) VALUES (
      gen_random_uuid(), v_original.workspace_id, v_original.order_id,
      v_original.assignment_id, v_original.agent_id, v_original.membership_id,
      v_original.plan_id, NULL, v_original.id, v_counter_kind, 'paid',
      v_original.currency, v_original.calculation_basis,
      v_original.include_tax, v_original.include_delivery_charge,
      v_original.basis_amount, v_original.revenue_amount, v_original.cost_amount,
      v_original.tax_amount, v_original.delivery_charge_amount,
      v_original.rate_percent, v_original.plan_commission_amount,
      v_original.product_commission_amount,
      CASE WHEN v_counter_kind = 'payout' THEN -abs(v_original.amount) ELSE abs(v_original.amount) END,
      now(), v_original.payout_reference, 'manual',
      'Manual migration 20260912031812: counter-settlement resetting paid commission ' || v_original.id::text || ' to unpaid.',
      v_actor_id, now(), now(), 'synced', 1, false
    )
    RETURNING id INTO v_counter_entry_id;

    INSERT INTO public.payment_transactions (
      id, workspace_id, source_module, source_type, source_record_id,
      source_subrecord_id, direction, amount, currency, payment_method, paid_at,
      account_id, account_name_snapshot, counterparty_name, reference_label,
      note, created_by, reversal_of_transaction_id, metadata, created_at,
      updated_at, version, is_deleted
    ) VALUES (
      gen_random_uuid(), v_original.workspace_id, v_original.payment_source_module,
      CASE WHEN v_counter_kind = 'payout' THEN 'agent_commission_payout' ELSE 'agent_commission_recovery' END,
      v_original.agent_id, v_counter_entry_id,
      CASE WHEN v_counter_kind = 'payout' THEN 'outgoing' ELSE 'incoming' END,
      abs(v_original.amount), v_original.currency, v_original.payment_method,
      now(), v_original.account_id, v_original.account_name_snapshot,
      v_original.counterparty_name, v_original.reference_label,
      'Manual migration 20260912031812: counter-payment resetting paid commission to unpaid. ' || COALESCE(v_original.payment_note, ''),
      v_actor_id, v_original.payment_transaction_id,
      COALESCE(v_original.payment_metadata, '{}'::jsonb) || jsonb_build_object(
        'salesAgentCommissionSettlementResetMigration', '20260912031812',
        'reversesCommissionEntryId', v_original.id,
        'reversesPaymentTransactionId', v_original.payment_transaction_id
      ),
      now(), now(), 1, false
    )
    RETURNING id INTO v_counter_payment_id;

    INSERT INTO private.sa_commission_reset_20260912_settlement_resets (
      original_commission_entry_id,
      counter_commission_entry_id,
      original_payment_transaction_id,
      counter_payment_transaction_id,
      workspace_id,
      original_kind,
      reset_by
    ) VALUES (
      v_original.id,
      v_counter_entry_id,
      v_original.payment_transaction_id,
      v_counter_payment_id,
      v_original.workspace_id,
      v_original.kind,
      v_actor_id
    );
  END LOOP;

  IF (SELECT count(*) FROM private.sa_commission_reset_20260912_settlement_resets) <> v_total_settlements THEN
    RAISE EXCEPTION 'The settlement reset did not create one counter-entry per original settlement'
      USING ERRCODE = '23514';
  END IF;
END;
$reset_settlements$;

ALTER TABLE crm.agent_commission_entries
  ENABLE TRIGGER validate_order_linked_agent_commission_payout;

DO $verify$
DECLARE
  v_backfill_count integer;
  v_counter_count integer;
BEGIN
  SELECT count(*) INTO v_backfill_count
  FROM private.sa_commission_reset_20260912_backfill_orders;

  SELECT count(*) INTO v_counter_count
  FROM private.sa_commission_reset_20260912_settlement_resets;

  IF v_backfill_count <> 15 OR v_counter_count <> 28 THEN
    RAISE EXCEPTION 'Commission reset verification failed: expected 15 backfilled orders and 28 settlement counters, found % and %', v_backfill_count, v_counter_count
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_settlement_resets AS reset
    JOIN crm.agent_commission_entries AS original
      ON original.id = reset.original_commission_entry_id
    JOIN crm.agent_commission_entries AS counter
      ON counter.id = reset.counter_commission_entry_id
    JOIN public.payment_transactions AS original_payment
      ON original_payment.id = reset.original_payment_transaction_id
    JOIN public.payment_transactions AS counter_payment
      ON counter_payment.id = reset.counter_payment_transaction_id
    WHERE abs(original.amount + counter.amount) > 0.000001
      OR counter_payment.reversal_of_transaction_id IS DISTINCT FROM original_payment.id
      OR counter_payment.void_id IS NOT NULL
      OR counter_payment.is_deleted
  ) THEN
    RAISE EXCEPTION 'Commission reset verification failed: a settlement counter does not exactly offset its original payment'
      USING ERRCODE = '23514';
  END IF;

  -- After all settlement counters, settled cash must have no remaining effect
  -- on commission balances: net balance equals earned/reversed/adjusted value.
  IF EXISTS (
    SELECT 1
    FROM crm.agent_commission_entries AS entry
    WHERE entry.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND NOT entry.is_deleted
    GROUP BY entry.agent_id, lower(entry.currency)
    HAVING abs(
      COALESCE(sum(entry.amount) FILTER (
        WHERE entry.kind NOT IN ('estimate', 'approval')
      ), 0)
      - COALESCE(sum(entry.amount) FILTER (
        WHERE entry.kind IN ('accrual', 'reversal', 'adjustment')
      ), 0)
    ) > 0.000001
  ) THEN
    RAISE EXCEPTION 'Commission reset verification failed: a paid settlement still affects a commission balance'
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE 'Backfilled % eligible order(s) and reset % commission settlement(s) to unpaid.', v_backfill_count, v_counter_count;
END;
$verify$;

COMMIT;
