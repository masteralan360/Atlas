-- Correct two specifically requested historical snapshots. The change is
-- deliberately limited to these order numbers and workspace, and runs in one
-- transaction so the guards cannot be left disabled if the correction fails.
BEGIN;

DO $repair$
DECLARE
  matching_order_count integer;
BEGIN
  SELECT count(*)
  INTO matching_order_count
  FROM crm.sales_orders
  WHERE workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
    AND order_number IN ('SO-2026-00053', 'SO-2026-00054');

  IF matching_order_count <> 2 THEN
    RAISE EXCEPTION
      'Expected exactly two requested sales orders in workspace %, found %',
      '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9',
      matching_order_count;
  END IF;
END;
$repair$;

-- These triggers protect application writes. The transaction holds the table
-- lock while they are disabled, and restores both before committing.
ALTER TABLE crm.sales_orders
  DISABLE TRIGGER enforce_visible_partner_link_on_sales_orders;

ALTER TABLE crm.sales_orders
  DISABLE TRIGGER sales_orders_partner_balance_snapshot_immutable;

UPDATE crm.sales_orders
SET partner_balance_snapshot = NULL,
    updated_at = timezone('utc', now()),
    version = COALESCE(version, 0) + 1
WHERE workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
  AND order_number IN ('SO-2026-00053', 'SO-2026-00054')
  AND partner_balance_snapshot IS NOT NULL;

ALTER TABLE crm.sales_orders
  ENABLE TRIGGER sales_orders_partner_balance_snapshot_immutable;

ALTER TABLE crm.sales_orders
  ENABLE TRIGGER enforce_visible_partner_link_on_sales_orders;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM crm.sales_orders
    WHERE workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND order_number IN ('SO-2026-00053', 'SO-2026-00054')
      AND partner_balance_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Requested sales-order partner balance snapshots were not cleared';
  END IF;
END;
$verify$;

COMMIT;
