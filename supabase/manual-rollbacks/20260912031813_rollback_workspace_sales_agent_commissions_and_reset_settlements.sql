-- MANUAL ROLLBACK for:
--   supabase/migrations/20260912031812_backfill_workspace_sales_agent_commissions_and_reset_settlements.sql
--
-- This preserves the immutable accounting trail. It does not edit or delete a
-- backfill, payout, recovery, or payment transaction. Instead it adds exact
-- counter-entries, restores the net paid commission position, and offsets the
-- backfilled aggregate and product snapshots.
--
-- Do not apply this after separately settling or reconciling any of the
-- backfilled orders. It deliberately aborts if the migration's own counter
-- payments have already been voided or reversed.

BEGIN;

CREATE TABLE IF NOT EXISTS private.sa_commission_reset_20260912_rollback_entries (
  original_backfill_entry_id uuid PRIMARY KEY,
  counter_entry_id uuid NOT NULL UNIQUE,
  entry_type text NOT NULL CHECK (entry_type IN ('aggregate', 'product')),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rolled_back_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  rolled_back_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid)
);

CREATE TABLE IF NOT EXISTS private.sa_commission_reset_20260912_rollback_settlements (
  reset_original_commission_entry_id uuid PRIMARY KEY REFERENCES crm.agent_commission_entries(id) ON DELETE RESTRICT,
  rollback_commission_entry_id uuid NOT NULL UNIQUE REFERENCES crm.agent_commission_entries(id) ON DELETE RESTRICT,
  rollback_payment_transaction_id uuid NOT NULL UNIQUE REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rolled_back_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  rolled_back_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid)
);

ALTER TABLE private.sa_commission_reset_20260912_rollback_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.sa_commission_reset_20260912_rollback_settlements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.sa_commission_reset_20260912_rollback_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.sa_commission_reset_20260912_rollback_settlements FROM PUBLIC, anon, authenticated;

DO $preflight$
DECLARE
  v_backfill_orders integer;
  v_settlement_resets integer;
BEGIN
  SELECT count(*) INTO v_backfill_orders
  FROM private.sa_commission_reset_20260912_backfill_orders;

  SELECT count(*) INTO v_settlement_resets
  FROM private.sa_commission_reset_20260912_settlement_resets;

  IF v_backfill_orders <> 15 OR v_settlement_resets <> 28 THEN
    RAISE EXCEPTION 'The matching forward migration is not in its expected state: found % backfilled orders and % settlement resets', v_backfill_orders, v_settlement_resets
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_settlement_resets AS reset
    JOIN public.payment_transactions AS counter_payment
      ON counter_payment.id = reset.counter_payment_transaction_id
    WHERE counter_payment.is_deleted
      OR counter_payment.void_id IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM public.payment_transactions AS later_payment
        WHERE later_payment.reversal_of_transaction_id = counter_payment.id
          AND NOT later_payment.is_deleted
      )
  ) THEN
    RAISE EXCEPTION 'A migration counter-payment has already been voided or reversed; this rollback cannot safely replay the original settlements'
      USING ERRCODE = '23514';
  END IF;

  -- Every commission row on a backfilled order must still be one that the
  -- forward migration recorded. A later reconciliation, payout, recovery, or
  -- return changes the business state and makes a historical data rollback
  -- unsafe; stop rather than mixing two different timelines.
  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_backfill_orders AS target
    JOIN crm.agent_commission_entries AS entry
      ON entry.workspace_id = target.workspace_id
     AND entry.order_id = target.order_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM private.sa_commission_reset_20260912_backfill_entries AS tracked
      WHERE tracked.entry_type = 'aggregate'
        AND tracked.entry_id = entry.id
    )
  ) OR EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_backfill_orders AS target
    JOIN crm.agent_product_commission_entries AS entry
      ON entry.workspace_id = target.workspace_id
     AND entry.order_id = target.order_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM private.sa_commission_reset_20260912_backfill_entries AS tracked
      WHERE tracked.entry_type = 'product'
        AND tracked.entry_id = entry.id
    )
  ) THEN
    RAISE EXCEPTION 'One or more backfilled orders changed after the forward migration; do not apply this rollback to a changed commission timeline'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_rollback_entries
  ) OR EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_rollback_settlements
  ) THEN
    RAISE EXCEPTION 'The commission reset rollback was already recorded; do not rerun it'
      USING ERRCODE = '23505';
  END IF;
END;
$preflight$;

-- Replaying a historical payout/recovery after its current earned balance has
-- changed is intentionally blocked by the regular settlement guards. This
-- rollback inserts only exact, recorded counter-entries and only while both
-- guards are disabled inside this transaction. They are re-enabled before the
-- migration commits; all normal application writes remain guarded.
ALTER TABLE crm.agent_commission_entries
  DISABLE TRIGGER enforce_agent_commission_entry_row;
ALTER TABLE crm.agent_commission_entries
  DISABLE TRIGGER validate_order_linked_agent_commission_payout;

DO $rollback_settlements$
DECLARE
  v_workspace_id constant uuid := '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid;
  v_actor_id uuid;
  v_reset record;
  v_rollback_kind text;
  v_rollback_entry_id uuid;
  v_rollback_payment_id uuid;
BEGIN
  SELECT profile.id
  INTO v_actor_id
  FROM public.profiles AS profile
  JOIN auth.users AS account ON account.id = profile.id
  WHERE profile.current_workspace = v_workspace_id
    AND profile.role = 'admin'
  ORDER BY profile.updated_at DESC NULLS LAST, profile.id
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'No current workspace administrator is available to attribute the commission reset rollback'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_actor_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  FOR v_reset IN
    SELECT
      reset.*,
      original.amount AS original_amount,
      counter.id AS counter_entry_id,
      counter.workspace_id AS counter_workspace_id,
      counter.order_id,
      counter.assignment_id,
      counter.agent_id,
      counter.membership_id,
      counter.plan_id,
      counter.calculation_basis,
      counter.include_tax,
      counter.include_delivery_charge,
      counter.basis_amount,
      counter.revenue_amount,
      counter.cost_amount,
      counter.tax_amount,
      counter.delivery_charge_amount,
      counter.rate_percent,
      counter.plan_commission_amount,
      counter.product_commission_amount,
      counter.amount AS counter_amount,
      counter.currency,
      counter.payout_reference,
      payment.source_module,
      payment.payment_method,
      payment.account_id,
      payment.account_name_snapshot,
      payment.counterparty_name,
      payment.reference_label,
      payment.note AS payment_note,
      payment.metadata AS payment_metadata
    FROM private.sa_commission_reset_20260912_settlement_resets AS reset
    JOIN crm.agent_commission_entries AS original
      ON original.id = reset.original_commission_entry_id
    JOIN crm.agent_commission_entries AS counter
      ON counter.id = reset.counter_commission_entry_id
    JOIN public.payment_transactions AS payment
      ON payment.id = reset.counter_payment_transaction_id
    WHERE reset.workspace_id = v_workspace_id
      AND NOT payment.is_deleted
      AND payment.void_id IS NULL
    ORDER BY CASE reset.original_kind WHEN 'recovery' THEN 0 ELSE 1 END,
      reset.original_commission_entry_id
    FOR UPDATE OF counter, payment
  LOOP
    v_rollback_kind := CASE
      WHEN v_reset.counter_amount > 0 THEN 'payout'
      ELSE 'recovery'
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
      gen_random_uuid(), v_reset.counter_workspace_id, v_reset.order_id,
      v_reset.assignment_id, v_reset.agent_id, v_reset.membership_id,
      v_reset.plan_id, NULL, v_reset.counter_entry_id, v_rollback_kind, 'paid',
      v_reset.currency, v_reset.calculation_basis,
      v_reset.include_tax, v_reset.include_delivery_charge,
      v_reset.basis_amount, v_reset.revenue_amount, v_reset.cost_amount,
      v_reset.tax_amount, v_reset.delivery_charge_amount, v_reset.rate_percent,
      v_reset.plan_commission_amount, v_reset.product_commission_amount,
      CASE WHEN v_rollback_kind = 'payout' THEN -abs(v_reset.counter_amount) ELSE abs(v_reset.counter_amount) END,
      now(), v_reset.payout_reference, 'manual',
      'Manual migration 20260912031813: rollback of settlement reset for original commission ' || v_reset.reset_original_commission_entry_id::text || '.',
      v_actor_id, now(), now(), 'synced', 1, false
    )
    RETURNING id INTO v_rollback_entry_id;

    INSERT INTO public.payment_transactions (
      id, workspace_id, source_module, source_type, source_record_id,
      source_subrecord_id, direction, amount, currency, payment_method, paid_at,
      account_id, account_name_snapshot, counterparty_name, reference_label,
      note, created_by, reversal_of_transaction_id, metadata, created_at,
      updated_at, version, is_deleted
    ) VALUES (
      gen_random_uuid(), v_reset.counter_workspace_id, v_reset.source_module,
      CASE WHEN v_rollback_kind = 'payout' THEN 'agent_commission_payout' ELSE 'agent_commission_recovery' END,
      v_reset.agent_id, v_rollback_entry_id,
      CASE WHEN v_rollback_kind = 'payout' THEN 'outgoing' ELSE 'incoming' END,
      abs(v_reset.counter_amount), v_reset.currency, v_reset.payment_method,
      now(), v_reset.account_id, v_reset.account_name_snapshot,
      v_reset.counterparty_name, v_reset.reference_label,
      'Manual migration 20260912031813: rollback counter-payment restoring the original commission settlement. ' || COALESCE(v_reset.payment_note, ''),
      v_actor_id, v_reset.counter_payment_transaction_id,
      COALESCE(v_reset.payment_metadata, '{}'::jsonb) || jsonb_build_object(
        'salesAgentCommissionSettlementResetRollbackMigration', '20260912031813',
        'reversesCommissionEntryId', v_reset.counter_entry_id,
        'reversesPaymentTransactionId', v_reset.counter_payment_transaction_id
      ),
      now(), now(), 1, false
    )
    RETURNING id INTO v_rollback_payment_id;

    INSERT INTO private.sa_commission_reset_20260912_rollback_settlements (
      reset_original_commission_entry_id,
      rollback_commission_entry_id,
      rollback_payment_transaction_id,
      workspace_id,
      rolled_back_by
    ) VALUES (
      v_reset.reset_original_commission_entry_id,
      v_rollback_entry_id,
      v_rollback_payment_id,
      v_reset.workspace_id,
      v_actor_id
    );
  END LOOP;

  IF (SELECT count(*) FROM private.sa_commission_reset_20260912_rollback_settlements) <> 28 THEN
    RAISE EXCEPTION 'The settlement-reset rollback did not create 28 replayed commission settlements'
      USING ERRCODE = '23514';
  END IF;
END;
$rollback_settlements$;

-- Reverse every product commission snapshot that the forward reconciliation
-- created. Product rows stay immutable and visible; the linked reversal nets
-- their quantity and value to zero.
DO $rollback_product_backfills$
DECLARE
  v_workspace_id constant uuid := '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid;
  v_actor_id uuid;
BEGIN
  SELECT profile.id
  INTO v_actor_id
  FROM public.profiles AS profile
  JOIN auth.users AS account ON account.id = profile.id
  WHERE profile.current_workspace = v_workspace_id
    AND profile.role = 'admin'
  ORDER BY profile.updated_at DESC NULLS LAST, profile.id
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'No current workspace administrator is available to attribute the backfill rollback'
      USING ERRCODE = '23514';
  END IF;

  WITH inserted AS (
    INSERT INTO crm.agent_product_commission_entries (
      id, workspace_id, order_id, assignment_id, agent_id, order_item_id,
      product_id, product_name_snapshot, product_sku_snapshot, unit_snapshot,
      rule_id, order_return_id, related_entry_id, kind, status, currency,
      commission_type, rate_percent, fixed_source_amount, fixed_source_currency,
      fixed_conversion_rate, fixed_exchange_rate_source,
      fixed_exchange_rate_timestamp, fixed_exchange_rates, quantity,
      basis_amount_per_unit, commission_per_unit, amount, occurred_at, notes,
      created_by, created_at, updated_at, sync_status, version, is_deleted
    )
    SELECT
      gen_random_uuid(), entry.workspace_id, entry.order_id, entry.assignment_id,
      entry.agent_id, entry.order_item_id, entry.product_id,
      entry.product_name_snapshot, entry.product_sku_snapshot, entry.unit_snapshot,
      entry.rule_id, NULL, entry.id, 'reversal', 'reversed', entry.currency,
      entry.commission_type, entry.rate_percent, entry.fixed_source_amount,
      entry.fixed_source_currency, entry.fixed_conversion_rate,
      entry.fixed_exchange_rate_source, entry.fixed_exchange_rate_timestamp,
      entry.fixed_exchange_rates, -entry.quantity, entry.basis_amount_per_unit,
      entry.commission_per_unit, -entry.amount, now(),
      'Manual migration 20260912031813: rollback of product commission backfill ' || entry.id::text || '.',
      v_actor_id, now(), now(), 'synced', 1, false
    FROM private.sa_commission_reset_20260912_backfill_entries AS tracked
    JOIN crm.agent_product_commission_entries AS entry
      ON entry.id = tracked.entry_id
    WHERE tracked.workspace_id = v_workspace_id
      AND tracked.entry_type = 'product'
    RETURNING id, related_entry_id, workspace_id
  )
  INSERT INTO private.sa_commission_reset_20260912_rollback_entries (
    original_backfill_entry_id,
    counter_entry_id,
    entry_type,
    workspace_id,
    rolled_back_by
  )
  SELECT related_entry_id, id, 'product', workspace_id, v_actor_id
  FROM inserted;
END;
$rollback_product_backfills$;

-- Offset every aggregate payable ledger row created by the backfill. The
-- commission-entry guards remain disabled only until the next statement below
-- re-enables them; this lets the rollback restore the former zero ledger state
-- even though the current policy would otherwise calculate a positive target.
DO $rollback_aggregate_backfills$
DECLARE
  v_workspace_id constant uuid := '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid;
  v_actor_id uuid;
BEGIN
  SELECT profile.id
  INTO v_actor_id
  FROM public.profiles AS profile
  JOIN auth.users AS account ON account.id = profile.id
  WHERE profile.current_workspace = v_workspace_id
    AND profile.role = 'admin'
  ORDER BY profile.updated_at DESC NULLS LAST, profile.id
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'No current workspace administrator is available to attribute the aggregate backfill rollback'
      USING ERRCODE = '23514';
  END IF;

  WITH inserted AS (
    INSERT INTO crm.agent_commission_entries (
      id, workspace_id, order_id, assignment_id, agent_id, membership_id,
      plan_id, order_return_id, related_entry_id, kind, status, currency,
      calculation_basis, include_tax, include_delivery_charge, basis_amount,
      revenue_amount, cost_amount, tax_amount, delivery_charge_amount,
      rate_percent, plan_commission_amount, product_commission_amount, amount,
      occurred_at, payout_reference, settlement_source, notes, created_by,
      created_at, updated_at, sync_status, version, is_deleted
    )
    SELECT
      gen_random_uuid(), entry.workspace_id, entry.order_id, entry.assignment_id,
      entry.agent_id, entry.membership_id, entry.plan_id, NULL, entry.id,
      'adjustment', 'reversed', entry.currency, entry.calculation_basis,
      entry.include_tax, entry.include_delivery_charge, entry.basis_amount,
      entry.revenue_amount, entry.cost_amount, entry.tax_amount,
      entry.delivery_charge_amount, entry.rate_percent,
      CASE WHEN entry.plan_commission_amount IS NULL THEN NULL ELSE -entry.plan_commission_amount END,
      CASE WHEN entry.product_commission_amount IS NULL THEN NULL ELSE -entry.product_commission_amount END,
      -entry.amount, now(), NULL, 'automatic',
      'Manual migration 20260912031813: rollback of sales-agent commission backfill ' || entry.id::text || '.',
      v_actor_id, now(), now(), 'synced', 1, false
    FROM private.sa_commission_reset_20260912_backfill_entries AS tracked
    JOIN crm.agent_commission_entries AS entry
      ON entry.id = tracked.entry_id
    WHERE tracked.workspace_id = v_workspace_id
      AND tracked.entry_type = 'aggregate'
    RETURNING id, related_entry_id, workspace_id
  )
  INSERT INTO private.sa_commission_reset_20260912_rollback_entries (
    original_backfill_entry_id,
    counter_entry_id,
    entry_type,
    workspace_id,
    rolled_back_by
  )
  SELECT related_entry_id, id, 'aggregate', workspace_id, v_actor_id
  FROM inserted;
END;
$rollback_aggregate_backfills$;

ALTER TABLE crm.agent_commission_entries
  ENABLE TRIGGER enforce_agent_commission_entry_row;
ALTER TABLE crm.agent_commission_entries
  ENABLE TRIGGER validate_order_linked_agent_commission_payout;

DO $verify$
DECLARE
  v_backfill_entry_count integer;
  v_rollback_entry_count integer;
  v_settlement_rollback_count integer;
BEGIN
  SELECT count(*) INTO v_backfill_entry_count
  FROM private.sa_commission_reset_20260912_backfill_entries;

  SELECT count(*) INTO v_rollback_entry_count
  FROM private.sa_commission_reset_20260912_rollback_entries;

  SELECT count(*) INTO v_settlement_rollback_count
  FROM private.sa_commission_reset_20260912_rollback_settlements;

  IF v_rollback_entry_count <> v_backfill_entry_count
    OR v_settlement_rollback_count <> 28 THEN
    RAISE EXCEPTION 'Commission reset rollback verification failed: expected % backfill counters and 28 settlement counters, found % and %', v_backfill_entry_count, v_rollback_entry_count, v_settlement_rollback_count
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_rollback_entries AS rollback
    JOIN private.sa_commission_reset_20260912_backfill_entries AS tracked
      ON tracked.entry_id = rollback.original_backfill_entry_id
    LEFT JOIN crm.agent_commission_entries AS original_aggregate
      ON tracked.entry_type = 'aggregate'
     AND original_aggregate.id = tracked.entry_id
    LEFT JOIN crm.agent_commission_entries AS counter_aggregate
      ON tracked.entry_type = 'aggregate'
     AND counter_aggregate.id = rollback.counter_entry_id
    LEFT JOIN crm.agent_product_commission_entries AS original_product
      ON tracked.entry_type = 'product'
     AND original_product.id = tracked.entry_id
    LEFT JOIN crm.agent_product_commission_entries AS counter_product
      ON tracked.entry_type = 'product'
     AND counter_product.id = rollback.counter_entry_id
    WHERE (tracked.entry_type = 'aggregate' AND abs(original_aggregate.amount + counter_aggregate.amount) > 0.000001)
       OR (tracked.entry_type = 'product' AND (
         abs(original_product.amount + counter_product.amount) > 0.000001
         OR abs(original_product.quantity + counter_product.quantity) > 0.000001
       ))
  ) THEN
    RAISE EXCEPTION 'Commission reset rollback verification failed: a backfilled ledger entry was not exactly offset'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.sa_commission_reset_20260912_settlement_resets AS reset
    JOIN crm.agent_commission_entries AS migration_counter
      ON migration_counter.id = reset.counter_commission_entry_id
    JOIN private.sa_commission_reset_20260912_rollback_settlements AS rollback
      ON rollback.reset_original_commission_entry_id = reset.original_commission_entry_id
    JOIN crm.agent_commission_entries AS rollback_counter
      ON rollback_counter.id = rollback.rollback_commission_entry_id
    JOIN public.payment_transactions AS migration_counter_payment
      ON migration_counter_payment.id = reset.counter_payment_transaction_id
    JOIN public.payment_transactions AS rollback_payment
      ON rollback_payment.id = rollback.rollback_payment_transaction_id
    WHERE abs(migration_counter.amount + rollback_counter.amount) > 0.000001
      OR rollback_payment.reversal_of_transaction_id IS DISTINCT FROM migration_counter_payment.id
      OR rollback_payment.void_id IS NOT NULL
      OR rollback_payment.is_deleted
  ) THEN
    RAISE EXCEPTION 'Commission reset rollback verification failed: a settlement reset was not exactly replayed'
      USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE 'Rolled back % backfilled commission entry(s) and restored % commission settlement(s).', v_backfill_entry_count, v_settlement_rollback_count;
END;
$verify$;

COMMIT;
