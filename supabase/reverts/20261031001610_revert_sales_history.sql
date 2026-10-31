-- MANUAL REVERT for the Sales History migrations:
--   supabase/migrations/20261030230936_sales_history_server_pagination.sql
--   supabase/migrations/20261031000740_revoke_anon_sales_history_rpc_execute.sql
--   supabase/migrations/20261031001211_sales_history_customer_link_privacy.sql
--
-- This records the remote rollback performed on 2026-10-31. Apply manually
-- only when reverting these exact Sales History changes.

BEGIN;

DROP FUNCTION IF EXISTS public.get_sales_history_page_optimized(
  uuid, timestamptz, timestamptz, jsonb, integer, integer
);

DROP INDEX IF EXISTS activities.idx_activity_transactions_workspace_history;
DROP INDEX IF EXISTS car_rental.idx_rental_contracts_workspace_history;
DROP INDEX IF EXISTS clinics.idx_clinical_appointments_workspace_history;
DROP INDEX IF EXISTS crm.idx_sales_orders_workspace_history;
DROP INDEX IF EXISTS fx.idx_exchange_transactions_workspace_history;
DROP INDEX IF EXISTS public.idx_payment_transactions_sales_history;
DROP INDEX IF EXISTS public.idx_sale_items_sale_history;
DROP INDEX IF EXISTS public.idx_sales_workspace_created_history;

DELETE FROM supabase_migrations.schema_migrations
WHERE (version, name) IN (
  ('20261030230936', 'sales_history_server_pagination'),
  ('20261031000740', 'revoke_anon_sales_history_rpc_execute'),
  ('20261031001211', 'sales_history_customer_link_privacy'),
  ('20261031001610', 'revert_sales_history')
);

DO $verify$
BEGIN
  IF to_regprocedure(
    'public.get_sales_history_page_optimized(uuid,timestamptz,timestamptz,jsonb,integer,integer)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Sales History RPC still exists after rollback';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE indexname IN (
      'idx_activity_transactions_workspace_history',
      'idx_rental_contracts_workspace_history',
      'idx_clinical_appointments_workspace_history',
      'idx_sales_orders_workspace_history',
      'idx_exchange_transactions_workspace_history',
      'idx_payment_transactions_sales_history',
      'idx_sale_items_sale_history',
      'idx_sales_workspace_created_history'
    )
  ) THEN
    RAISE EXCEPTION 'Sales History indexes still exist after rollback';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations
    WHERE version IN ('20261030230936', '20261031000740', '20261031001211', '20261031001610')
  ) THEN
    RAISE EXCEPTION 'Sales History migration records still exist after rollback';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
