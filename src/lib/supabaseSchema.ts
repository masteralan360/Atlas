import { supabase } from '@/auth/supabase'

const budgetTables = new Set([
    'budget_settings',
    'budget_allocations',
    'expense_series',
    'expense_items',
    'payroll_statuses',
    'dividend_statuses'
])

const crmTables = new Set([
    'customers',
    'suppliers',
    'sales_orders',
    'purchase_orders'
])

const budgetClient = supabase.schema('budget')
const crmClient = supabase.schema('crm')

export function isBudgetTable(tableName: string): boolean {
    return budgetTables.has(tableName)
}

export function isCrmTable(tableName: string): boolean {
    return crmTables.has(tableName)
}

export function getSupabaseClientForTable(tableName: string) {
    if (isBudgetTable(tableName)) {
        return budgetClient
    }

    if (isCrmTable(tableName)) {
        return crmClient
    }

    return supabase
}
