-- Budget Management Module Tables

CREATE SCHEMA IF NOT EXISTS budget;

GRANT USAGE ON SCHEMA budget TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA budget TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA budget GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- 1. Budget Settings (one per workspace)
CREATE TABLE IF NOT EXISTS budget.budget_settings (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    start_month TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_budget_settings_workspace_id
    ON budget.budget_settings(workspace_id);

-- 2. Budget Allocations (monthly limits)
CREATE TABLE IF NOT EXISTS budget.budget_allocations (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    limit_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    version INTEGER NOT NULL DEFAULT 1,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_budget_allocations_workspace_month
    ON budget.budget_allocations(workspace_id, month);
CREATE INDEX IF NOT EXISTS idx_budget_allocations_workspace_id
    ON budget.budget_allocations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_budget_allocations_month
    ON budget.budget_allocations(month);

-- 3. Expense Series (recurring or one-time definitions)
CREATE TABLE IF NOT EXISTS budget.expense_series (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    due_day INTEGER NOT NULL DEFAULT 1,
    recurrence TEXT NOT NULL CHECK (recurrence IN ('monthly', 'one_time')),
    start_month TEXT NOT NULL,
    end_month TEXT,
    category TEXT,
    subcategory TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_series_workspace_id
    ON budget.expense_series(workspace_id);
CREATE INDEX IF NOT EXISTS idx_expense_series_start_month
    ON budget.expense_series(start_month);

-- 4. Expense Items (monthly occurrences)
CREATE TABLE IF NOT EXISTS budget.expense_items (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    series_id UUID NOT NULL REFERENCES budget.expense_series(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    due_date DATE NOT NULL,
    amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL CHECK (status IN ('pending', 'snoozed', 'paid')) DEFAULT 'pending',
    snoozed_until TIMESTAMPTZ,
    snoozed_indefinite BOOLEAN NOT NULL DEFAULT FALSE,
    snooze_count INTEGER NOT NULL DEFAULT 0,
    paid_at TIMESTAMPTZ,
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_expense_items_series_month
    ON budget.expense_items(series_id, month);
CREATE INDEX IF NOT EXISTS idx_expense_items_workspace_id
    ON budget.expense_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_expense_items_month
    ON budget.expense_items(month);
CREATE INDEX IF NOT EXISTS idx_expense_items_due_date
    ON budget.expense_items(due_date);

-- 5. Payroll Statuses (per employee per month)
CREATE TABLE IF NOT EXISTS budget.payroll_statuses (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE SET NULL,
    month TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'snoozed', 'paid')) DEFAULT 'pending',
    snoozed_until TIMESTAMPTZ,
    snoozed_indefinite BOOLEAN NOT NULL DEFAULT FALSE,
    snooze_count INTEGER NOT NULL DEFAULT 0,
    paid_at TIMESTAMPTZ,
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_status_employee_month
    ON budget.payroll_statuses(employee_id, month);
CREATE INDEX IF NOT EXISTS idx_payroll_status_workspace_id
    ON budget.payroll_statuses(workspace_id);
CREATE INDEX IF NOT EXISTS idx_payroll_status_month
    ON budget.payroll_statuses(month);

-- 6. Dividend Statuses (per employee per month)
CREATE TABLE IF NOT EXISTS budget.dividend_statuses (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE SET NULL,
    month TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'snoozed', 'paid')) DEFAULT 'pending',
    snoozed_until TIMESTAMPTZ,
    snoozed_indefinite BOOLEAN NOT NULL DEFAULT FALSE,
    snooze_count INTEGER NOT NULL DEFAULT 0,
    paid_at TIMESTAMPTZ,
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_dividend_status_employee_month
    ON budget.dividend_statuses(employee_id, month);
CREATE INDEX IF NOT EXISTS idx_dividend_status_workspace_id
    ON budget.dividend_statuses(workspace_id);
CREATE INDEX IF NOT EXISTS idx_dividend_status_month
    ON budget.dividend_statuses(month);

-- Enable RLS
ALTER TABLE budget.budget_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget.budget_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget.expense_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget.expense_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget.payroll_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget.dividend_statuses ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'budget' AND tablename = 'budget_settings' AND policyname = 'Workspaces members can view budget_settings') THEN
        CREATE POLICY "Workspaces members can view budget_settings" ON budget.budget_settings
            FOR ALL USING (
                workspace_id IN (SELECT workspace_id FROM public.profiles WHERE id = auth.uid())
            );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'budget' AND tablename = 'budget_allocations' AND policyname = 'Workspaces members can view budget_allocations') THEN
        CREATE POLICY "Workspaces members can view budget_allocations" ON budget.budget_allocations
            FOR ALL USING (
                workspace_id IN (SELECT workspace_id FROM public.profiles WHERE id = auth.uid())
            );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'budget' AND tablename = 'expense_series' AND policyname = 'Workspaces members can view expense_series') THEN
        CREATE POLICY "Workspaces members can view expense_series" ON budget.expense_series
            FOR ALL USING (
                workspace_id IN (SELECT workspace_id FROM public.profiles WHERE id = auth.uid())
            );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'budget' AND tablename = 'expense_items' AND policyname = 'Workspaces members can view expense_items') THEN
        CREATE POLICY "Workspaces members can view expense_items" ON budget.expense_items
            FOR ALL USING (
                workspace_id IN (SELECT workspace_id FROM public.profiles WHERE id = auth.uid())
            );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'budget' AND tablename = 'payroll_statuses' AND policyname = 'Workspaces members can view payroll_statuses') THEN
        CREATE POLICY "Workspaces members can view payroll_statuses" ON budget.payroll_statuses
            FOR ALL USING (
                workspace_id IN (SELECT workspace_id FROM public.profiles WHERE id = auth.uid())
            );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'budget' AND tablename = 'dividend_statuses' AND policyname = 'Workspaces members can view dividend_statuses') THEN
        CREATE POLICY "Workspaces members can view dividend_statuses" ON budget.dividend_statuses
            FOR ALL USING (
                workspace_id IN (SELECT workspace_id FROM public.profiles WHERE id = auth.uid())
            );
    END IF;
END $$;

-- updated_at triggers
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_budget_settings_updated_at' AND tgrelid = 'budget.budget_settings'::regclass) THEN
        CREATE TRIGGER update_budget_settings_updated_at BEFORE UPDATE ON budget.budget_settings
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_budget_allocations_updated_at' AND tgrelid = 'budget.budget_allocations'::regclass) THEN
        CREATE TRIGGER update_budget_allocations_updated_at BEFORE UPDATE ON budget.budget_allocations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_expense_series_updated_at' AND tgrelid = 'budget.expense_series'::regclass) THEN
        CREATE TRIGGER update_expense_series_updated_at BEFORE UPDATE ON budget.expense_series
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_expense_items_updated_at' AND tgrelid = 'budget.expense_items'::regclass) THEN
        CREATE TRIGGER update_expense_items_updated_at BEFORE UPDATE ON budget.expense_items
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_payroll_statuses_updated_at' AND tgrelid = 'budget.payroll_statuses'::regclass) THEN
        CREATE TRIGGER update_payroll_statuses_updated_at BEFORE UPDATE ON budget.payroll_statuses
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_dividend_statuses_updated_at' AND tgrelid = 'budget.dividend_statuses'::regclass) THEN
        CREATE TRIGGER update_dividend_statuses_updated_at BEFORE UPDATE ON budget.dividend_statuses
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
