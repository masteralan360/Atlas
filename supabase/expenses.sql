-- DDL for public.expenses reconstructed from Supabase metadata and migrations

CREATE TABLE IF NOT EXISTS public.expenses (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    description TEXT,
    type TEXT CHECK (type IN ('recurring', 'one-time')),
    category TEXT CHECK (category IN ('rent', 'electricity', 'payroll', 'utility', 'marketing', 'general', 'other')),
    subcategory TEXT,
    amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT CHECK (status IN ('pending', 'paid', 'snoozed')),
    due_date TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    snooze_until TIMESTAMPTZ,
    snooze_count INTEGER NOT NULL DEFAULT 0,
    employee_id UUID REFERENCES public.employees(id) ON DELETE SET NULL,
    
    -- Sync Metadata
    version INTEGER NOT NULL DEFAULT 1,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Additional columns from live metadata
    is_locked BOOLEAN DEFAULT FALSE,
    category_code TEXT,
    subcategory_code TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_expenses_workspace_id ON public.expenses(workspace_id);
CREATE INDEX IF NOT EXISTS idx_expenses_due_date ON public.expenses(due_date);
CREATE INDEX IF NOT EXISTS idx_expenses_workspace_subcategory ON public.expenses (workspace_id, subcategory);

-- RLS
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

-- Triggers
CREATE TRIGGER update_expenses_updated_at BEFORE UPDATE ON public.expenses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
