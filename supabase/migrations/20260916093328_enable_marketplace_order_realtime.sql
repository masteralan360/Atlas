-- Marketplace order changes are operationally time-sensitive. Publish the
-- existing table so authenticated workspace users can receive filtered
-- Postgres Changes events. Row visibility continues to be governed by the
-- existing marketplace_orders RLS policy.
DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) THEN
    RAISE EXCEPTION 'The supabase_realtime publication must exist before enabling marketplace order Realtime';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'marketplace_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.marketplace_orders;
  END IF;
END;
$block$;
