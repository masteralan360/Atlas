-- Sales history is intentionally immutable.
-- Finalized sales must be reversed through return flows, not deleted.

DROP FUNCTION IF EXISTS public.delete_sale(uuid);
