-- DDL for public.budget_allocations reconstructed from Supabase metadata

CREATE TABLE IF NOT EXISTS public.budget_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('fixed', 'percentage')),
    amount NUMERIC NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    start_point BOOLEAN NOT NULL DEFAULT false
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_budget_allocations_workspace_id ON public.budget_allocations(workspace_id);

-- RLS
ALTER TABLE public.budget_allocations ENABLE ROW LEVEL SECURITY;
