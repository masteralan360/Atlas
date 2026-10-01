BEGIN;
SELECT plan(8);

SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'crm' AND table_name = 'sales_orders'
      AND column_name = 'is_archived' AND is_nullable = 'NO'
      AND column_default = 'false'
  ),
  'sales orders have a non-null archive flag defaulting to false'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'crm' AND table_name = 'purchase_orders'
      AND column_name = 'is_archived' AND is_nullable = 'NO'
      AND column_default = 'false'
  ),
  'purchase orders have a non-null archive flag defaulting to false'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'crm.sales_orders'::regclass
      AND tgname = 'crm_sales_orders_archive_guard' AND NOT tgisinternal
  ),
  'sales order archive transitions are guarded by a database trigger'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'crm.purchase_orders'::regclass
      AND tgname = 'crm_purchase_orders_archive_guard' AND NOT tgisinternal
  ),
  'purchase order archive transitions are guarded by a database trigger'
);

SELECT like(
  pg_get_functiondef('crm.enforce_order_archive_rules()'::regprocedure),
  '%order_archive_not_allowed%',
  'the database rejects archiving ineligible order statuses'
);

SELECT like(
  pg_get_functiondef('crm.enforce_order_archive_rules()'::regprocedure),
  '%return_status%',
  'the database recognizes fully returned sales orders'
);

SELECT like(
  pg_get_functiondef('crm.enforce_order_archive_rules()'::regprocedure),
  '%order_archive_must_not_change_order_data%',
  'the database rejects archive transitions that also change order data'
);

SELECT like(
  pg_get_functiondef('crm.enforce_order_archive_rules()'::regprocedure),
  '%order_archive_requires_existing_order%',
  'the database does not allow archived orders to be inserted directly'
);

SELECT * FROM finish();
ROLLBACK;
