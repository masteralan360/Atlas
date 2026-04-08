ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS exchange_rate_snapshot jsonb NULL;
