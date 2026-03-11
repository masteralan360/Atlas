import { supabase } from '@/auth/supabase'

const budgetTables = new Set([
    'budget_settings',
    'budget_allocations',
    'expense_series',
    'expense_items',
    'payroll_statuses',
    'dividend_statuses'
])

const budgetClient = supabase.schema('budget')

export function isBudgetTable(tableName: string): boolean {
    return budgetTables.has(tableName)
}

export function getSupabaseClientForTable(tableName: string) {
    return isBudgetTable(tableName) ? budgetClient : supabase
}
