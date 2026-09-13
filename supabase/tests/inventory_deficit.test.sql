BEGIN;
SELECT plan(21);

CREATE TEMP TABLE inventory_quantity_guard_test (
  quantity numeric NOT NULL
);

CREATE TRIGGER inventory_quantity_guard_test_trigger
BEFORE INSERT OR UPDATE OF quantity ON inventory_quantity_guard_test
FOR EACH ROW
EXECUTE FUNCTION private.guard_nonnegative_quantity_transition();

SELECT lives_ok(
  $$INSERT INTO inventory_quantity_guard_test(quantity) VALUES (0)$$,
  'zero stock is valid'
);
SELECT lives_ok(
  $$INSERT INTO inventory_quantity_guard_test(quantity) VALUES (12.345678)$$,
  'fractional stock is valid'
);
SELECT throws_ok(
  $$INSERT INTO inventory_quantity_guard_test(quantity) VALUES (-1)$$,
  '23514',
  'Inventory quantity cannot be negative',
  'new negative stock is rejected'
);
SELECT throws_ok(
  $$INSERT INTO inventory_quantity_guard_test(quantity) VALUES (-0.0000001)$$,
  '23514',
  'Inventory quantity cannot be negative',
  'sub-epsilon negative stock is rejected'
);
SELECT throws_ok(
  $$INSERT INTO inventory_quantity_guard_test(quantity) VALUES ('NaN')$$,
  '23514',
  'Inventory quantity must be a finite number',
  'NaN stock is rejected'
);

CREATE TEMP TABLE service_product_quantity_guard_test (
  quantity numeric NULL,
  is_service boolean NOT NULL
);

CREATE TRIGGER service_product_quantity_guard_test_trigger
BEFORE INSERT OR UPDATE OF quantity ON service_product_quantity_guard_test
FOR EACH ROW
EXECUTE FUNCTION private.guard_nonnegative_quantity_transition();

SELECT lives_ok(
  $$INSERT INTO service_product_quantity_guard_test(quantity, is_service) VALUES (NULL, true)$$,
  'a service may retain its intentionally empty inventory snapshot'
);
SELECT throws_ok(
  $$INSERT INTO service_product_quantity_guard_test(quantity, is_service) VALUES (NULL, false)$$,
  '23514',
  'Inventory quantity must be a finite number',
  'a non-service product still requires a finite inventory snapshot'
);

ALTER TABLE inventory_quantity_guard_test DISABLE TRIGGER USER;
INSERT INTO inventory_quantity_guard_test(quantity) VALUES (-21);
ALTER TABLE inventory_quantity_guard_test ENABLE TRIGGER USER;

SELECT lives_ok(
  $$UPDATE inventory_quantity_guard_test SET quantity = -21 WHERE quantity = -21$$,
  'an unchanged legacy deficit remains usable during manual cleanup'
);
SELECT lives_ok(
  $$UPDATE inventory_quantity_guard_test SET quantity = -10 WHERE quantity = -21$$,
  'a legacy deficit may improve toward zero'
);
SELECT throws_ok(
  $$UPDATE inventory_quantity_guard_test SET quantity = -22 WHERE quantity = -10$$,
  '23514',
  'A legacy inventory deficit cannot be increased',
  'a legacy deficit cannot worsen'
);

CREATE TEMP TABLE marketplace_delivery_existing_stock_test (
  quantity numeric NOT NULL
);

CREATE TRIGGER marketplace_delivery_existing_stock_test_trigger
BEFORE INSERT OR UPDATE OF quantity ON marketplace_delivery_existing_stock_test
FOR EACH ROW
EXECUTE FUNCTION private.guard_nonnegative_quantity_transition();

INSERT INTO marketplace_delivery_existing_stock_test(quantity) VALUES (110);

SELECT lives_ok(
  $$UPDATE marketplace_delivery_existing_stock_test SET quantity = quantity - 1$$,
  'an existing inventory position can be deducted without proposing a negative insert'
);
SELECT is(
  (SELECT quantity FROM marketplace_delivery_existing_stock_test),
  109::numeric,
  'deducting one marketplace item from 110 leaves 109 units'
);

SELECT ok(
  (
    SELECT relrowsecurity
    FROM pg_class
    WHERE oid = 'private.inventory_snapshot_receipts'::regclass
  ),
  'the private idempotency receipt table has RLS enabled'
);
SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    'private.inventory_snapshot_receipts',
    'SELECT'
  ),
  'authenticated clients cannot read private idempotency receipts'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.apply_inventory_snapshot_changes(uuid,uuid,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated clients can call the authoritative inventory RPC'
);

SET LOCAL request.jwt.claim.role = 'service_role';

SELECT throws_ok(
  $$
    SELECT private.apply_inventory_snapshot_changes(
      '30000000-0000-4000-8000-000000000001'::uuid,
      '30000000-0000-4000-8000-000000000002'::uuid,
      'client_snapshot_cas',
      '[
        {"product_id":"30000000-0000-4000-8000-000000000003","storage_id":"30000000-0000-4000-8000-000000000004","quantity":1,"expected_version":0},
        {"product_id":"30000000-0000-4000-8000-000000000003","storage_id":"30000000-0000-4000-8000-000000000004","quantity":2,"expected_version":0}
      ]'::jsonb
    )
  $$,
  '22023',
  'Inventory changes contain duplicate product and storage positions',
  'the RPC rejects duplicate positions before acquiring inventory row locks'
);

SELECT throws_ok(
  $$
    SELECT private.apply_inventory_snapshot_changes(
      '30000000-0000-4000-8000-000000000005'::uuid,
      '30000000-0000-4000-8000-000000000002'::uuid,
      'client_snapshot_cas',
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'product_id', '30000000-0000-4000-8000-000000000003',
            'storage_id', '30000000-0000-4000-8000-000000000004',
            'quantity', 1,
            'expected_version', 0
          )
        )
        FROM pg_catalog.generate_series(1, 1001)
      )
    )
  $$,
  '22023',
  'Inventory changes exceed the maximum batch size',
  'the RPC rejects oversized batches before taking row locks'
);

INSERT INTO private.inventory_snapshot_receipts (
  operation_id,
  workspace_id,
  operation_kind,
  payload_hash,
  result,
  actor_id
)
VALUES (
  '30000000-0000-4000-8000-000000000006'::uuid,
  '30000000-0000-4000-8000-000000000002'::uuid,
  'sales_order_completion',
  'original-payload',
  '{"inventory":[],"already_applied":false}'::jsonb,
  NULL
);

SELECT is(
  (
    private.apply_inventory_snapshot_changes(
      '30000000-0000-4000-8000-000000000006'::uuid,
      '30000000-0000-4000-8000-000000000002'::uuid,
      'sales_order_completion',
      '[{"product_id":"30000000-0000-4000-8000-000000000007","storage_id":"30000000-0000-4000-8000-000000000008","quantity":9,"expected_version":3}]'::jsonb
    )->>'already_applied'
  )::boolean,
  true,
  'a stable sales-order completion id replays the first committed inventory result'
);

INSERT INTO private.inventory_snapshot_receipts (
  operation_id,
  workspace_id,
  operation_kind,
  payload_hash,
  result,
  actor_id
)
VALUES (
  '30000000-0000-4000-8000-000000000009'::uuid,
  '30000000-0000-4000-8000-000000000002'::uuid,
  'client_snapshot_cas',
  'different-payload',
  '{"inventory":[],"already_applied":false}'::jsonb,
  NULL
);

SELECT throws_ok(
  $$
    SELECT private.apply_inventory_snapshot_changes(
      '30000000-0000-4000-8000-000000000009'::uuid,
      '30000000-0000-4000-8000-000000000002'::uuid,
      'client_snapshot_cas',
      '[{"product_id":"30000000-0000-4000-8000-000000000007","storage_id":"30000000-0000-4000-8000-000000000008","quantity":9,"expected_version":3}]'::jsonb
    )
  $$,
  '23505',
  'Inventory operation id is already used by another payload',
  'generic snapshot operations still reject operation-id reuse with another payload'
);

SELECT is(
  (
    SELECT external_language
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name = 'apply_inventory_snapshot_changes'
  ),
  'PLPGSQL',
  'the public inventory RPC can catch and translate strict CAS conflicts'
);

SELECT ok(
  pg_get_functiondef('public.apply_inventory_snapshot_changes(uuid,uuid,text,jsonb)'::regprocedure)
    LIKE '%WHEN serialization_failure THEN%',
  'the public inventory RPC catches only serialization failures'
);

SELECT * FROM finish();
ROLLBACK;
