BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions, private;
SELECT no_plan();

SELECT ok(
  (
    SELECT relrowsecurity
    FROM pg_catalog.pg_class
    WHERE oid = 'private.inventory_transaction_integrity_mismatches'::regclass
  ),
  'the inventory transaction mismatch table has RLS enabled'
);
SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    'private.inventory_transaction_integrity_mismatches',
    'SELECT'
  ),
  'workspace users cannot read private inventory transaction mismatches'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.admin_list_inventory_transaction_integrity_mismatches(uuid,text,integer)',
    'EXECUTE'
  ),
  'the Admin service role can read mismatch records through its restricted RPC'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.admin_list_inventory_transaction_integrity_mismatches(uuid,text,integer)',
    'EXECUTE'
  ),
  'workspace users cannot call the Admin mismatch reader'
);

INSERT INTO public.workspaces (id, name, subscription_expires_at, data_mode)
VALUES (
  'a7000000-0000-4000-8000-000000000001',
  'Inventory transaction integrity test',
  now() + interval '10 days',
  'cloud'
);

INSERT INTO public.products (
  id, workspace_id, sku, name, price, cost_price, quantity,
  min_stock_level, unit, currency
)
VALUES (
  'a7000000-0000-4000-8000-000000000002',
  'a7000000-0000-4000-8000-000000000001',
  'INVENTORY-INTEGRITY-TEST',
  'Inventory Transaction Integrity Test',
  10, 5, 0, 0, 'pcs', 'usd'
);

INSERT INTO public.storages (id, workspace_id, name, is_primary)
VALUES (
  'a7000000-0000-4000-8000-000000000003',
  'a7000000-0000-4000-8000-000000000001',
  'Inventory Integrity Test Storage',
  true
);

-- A direct stock write with no submitted transaction still receives the
-- existing canonical audit row. This is not a historical backfill.
INSERT INTO public.inventory (
  id, workspace_id, product_id, storage_id, quantity
)
VALUES (
  'a7000000-0000-4000-8000-000000000004',
  'a7000000-0000-4000-8000-000000000001',
  'a7000000-0000-4000-8000-000000000002',
  'a7000000-0000-4000-8000-000000000003',
  5
);

SET CONSTRAINTS inventory_movement_audit_flush,
  inventory_transaction_integrity_check IMMEDIATE;

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.inventory_transactions
    WHERE workspace_id = 'a7000000-0000-4000-8000-000000000001'
      AND product_id = 'a7000000-0000-4000-8000-000000000002'
      AND storage_id = 'a7000000-0000-4000-8000-000000000003'
      AND transaction_type = 'initial_stock'
  ),
  1,
  'a new inventory movement without a submitted transaction gets one canonical audit row'
);
SELECT is(
  (
    SELECT count(*)::integer
    FROM private.inventory_transaction_integrity_mismatches
    WHERE workspace_id = 'a7000000-0000-4000-8000-000000000001'
  ),
  0,
  'an automatically recorded canonical movement does not create a submission mismatch'
);

SET CONSTRAINTS inventory_movement_audit_flush,
  inventory_transaction_integrity_check DEFERRED;

-- Exact transaction snapshots pass silently.
UPDATE public.inventory
SET quantity = 8, version = version + 1
WHERE id = 'a7000000-0000-4000-8000-000000000004';

INSERT INTO public.inventory_transactions (
  id, workspace_id, product_id, storage_id, transaction_type,
  quantity_delta, previous_quantity, new_quantity
)
VALUES (
  'a7000000-0000-4000-8000-000000000005',
  'a7000000-0000-4000-8000-000000000001',
  'a7000000-0000-4000-8000-000000000002',
  'a7000000-0000-4000-8000-000000000003',
  'stock_adjustment', 3, 5, 8
);

SET CONSTRAINTS inventory_movement_audit_flush,
  inventory_transaction_integrity_check IMMEDIATE;

SELECT is(
  (
    SELECT count(*)::integer
    FROM private.inventory_transaction_integrity_mismatches
    WHERE workspace_id = 'a7000000-0000-4000-8000-000000000001'
  ),
  0,
  'a submitted transaction matching its server-side inventory movement passes silently'
);

SET CONSTRAINTS inventory_movement_audit_flush,
  inventory_transaction_integrity_check DEFERRED;

-- A transaction can be arithmetically plausible and still disagree with the
-- actual inventory movement; the submitted and expected snapshots are kept.
UPDATE public.inventory
SET quantity = 11, version = version + 1
WHERE id = 'a7000000-0000-4000-8000-000000000004';

INSERT INTO public.inventory_transactions (
  id, workspace_id, product_id, storage_id, transaction_type,
  quantity_delta, previous_quantity, new_quantity
)
VALUES (
  'a7000000-0000-4000-8000-000000000006',
  'a7000000-0000-4000-8000-000000000001',
  'a7000000-0000-4000-8000-000000000002',
  'a7000000-0000-4000-8000-000000000003',
  'stock_adjustment', 2, 8, 10
);

SET CONSTRAINTS inventory_movement_audit_flush,
  inventory_transaction_integrity_check IMMEDIATE;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM private.inventory_transaction_integrity_mismatches AS mismatch
    WHERE mismatch.inventory_event_id IS NOT NULL
      AND mismatch.inventory_transaction_id = 'a7000000-0000-4000-8000-000000000006'
      AND mismatch.mismatch_kind = 'movement_snapshot_mismatch'
      AND mismatch.expected_snapshot->>'quantity_delta' = '3'
      AND mismatch.expected_snapshot->>'new_quantity' = '11'
      AND mismatch.actual_snapshot->>'quantity_delta' = '2'
      AND mismatch.actual_snapshot->>'new_quantity' = '10'
  ),
  'a mismatched submission stores expected inventory and actual transaction snapshots'
);
SELECT is(
  (
    SELECT count(*)::integer
    FROM public.inventory_transactions
    WHERE id = 'a7000000-0000-4000-8000-000000000006'
  ),
  1,
  'the integrity check preserves the submitted transaction for administrator review'
);

SET CONSTRAINTS inventory_movement_audit_flush,
  inventory_transaction_integrity_check DEFERRED;

-- An inserted inventory ledger transaction with no actual stock transition is
-- also recorded for review.
INSERT INTO public.inventory_transactions (
  id, workspace_id, product_id, storage_id, transaction_type,
  quantity_delta, previous_quantity, new_quantity
)
VALUES (
  'a7000000-0000-4000-8000-000000000007',
  'a7000000-0000-4000-8000-000000000001',
  'a7000000-0000-4000-8000-000000000002',
  'a7000000-0000-4000-8000-000000000003',
  'stock_adjustment', 1, 11, 12
);

SET CONSTRAINTS inventory_movement_audit_flush,
  inventory_transaction_integrity_check IMMEDIATE;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM private.inventory_transaction_integrity_mismatches AS mismatch
    WHERE mismatch.inventory_transaction_id = 'a7000000-0000-4000-8000-000000000007'
      AND mismatch.inventory_event_id IS NULL
      AND mismatch.mismatch_kind = 'transaction_without_inventory_change'
  ),
  'a submitted transaction without an inventory change is retained as a mismatch'
);

SELECT * FROM finish();
ROLLBACK;
