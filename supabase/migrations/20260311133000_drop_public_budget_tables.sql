-- Remove legacy Budget tables from public schema (migrated to budget schema)

DROP TABLE IF EXISTS public.expense_items CASCADE;
DROP TABLE IF EXISTS public.expense_series CASCADE;
DROP TABLE IF EXISTS public.payroll_statuses CASCADE;
DROP TABLE IF EXISTS public.dividend_statuses CASCADE;
DROP TABLE IF EXISTS public.budget_allocations CASCADE;
DROP TABLE IF EXISTS public.budget_settings CASCADE;
