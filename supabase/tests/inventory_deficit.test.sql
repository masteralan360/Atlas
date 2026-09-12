BEGIN;
SELECT plan(11);

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

SELECT * FROM finish();
ROLLBACK;
