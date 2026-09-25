import { supabase } from '@/auth/supabase'

const budgetTables = new Set([
    'budget_settings',
    'budget_allocations',
    'expense_categories',
    'expense_series',
    'expense_items',
    'payroll_statuses',
    'dividend_statuses'
])

const crmTables = new Set([
    'customers',
    'suppliers',
    'agents',
    'agent_excluded_categories',
    'agent_commission_plans',
    'agent_commission_memberships',
    'product_commission_rules',
    'product_commission_rule_agents',
    'sales_order_agent_assignments',
    'agent_commission_entries',
    'agent_product_commission_entries',
    'business_partners',
    'business_partner_groups',
    'business_partner_group_users',
    'business_partner_group_partners',
    'sales_orders',
    'purchase_orders',
    'order_installments',
])

const realEstateTables = new Set([
    'real_estate_transactions',
    'real_estate_installments',
    'real_estate_payments'
])

const fxTables = new Set([
    'exchange_pair_prices',
    'exchange_transactions',
    'exchange_fee_rules',
    'fx_safes',
    'fx_safe_balances',
    'fx_safe_movements'
])

const clinicsTables = new Set([
    'clinical_appointments',
    'clinical_patients',
    'clinical_attachments',
    'clinical_presets'
])

const activitiesTables = new Set([
    'activity_catalog',
    'activity_transactions',
    'activity_transaction_lines'
])

const fleetTables = new Set([
    'fleet_vehicles',
    'fleet_vehicle_assignments',
    'location_sessions',
    'live_locations',
    'location_history'
])

const rentalTables = new Set([
    'rental_vehicles',
    'rental_requests',
    'rental_contracts'
])

const paymentAccountTables = new Set([
    'payment_accounts',
    'capital_pools',
    'payment_account_balances',
    'payment_account_movements',
    'cashier_shifts',
    'cashier_shift_currency_counts',
    'cashier_shift_templates',
    'cashier_shift_assignments',
    'cashier_shift_occurrences',
    'cashier_shift_pause_requests',
    'cashier_shift_pause_periods'
])

const travelTransportationTables = new Set([
    'travel_bookings',
    'travel_passengers'
])

// The client-side names remain explicit and descriptive, while three physical
// table names inside the isolated payment_accounts schema are shorter.
const paymentAccountRemoteTableNames: Record<string, string> = {
    payment_accounts: 'accounts',
    payment_account_balances: 'account_balances',
    payment_account_movements: 'account_movements',
}

const deliveryTables = new Set([
    'delivery_merchant_profiles',
    'delivery_shipments',
    'delivery_shipment_events',
    'delivery_shipment_cod_adjustment_requests',
    'delivery_shipment_cod_corrections',
    'delivery_shipment_recipient_payout_corrections',
    'delivery_shipment_recipient_payout_adjustment_requests',
    'delivery_runs',
    'delivery_run_items',
    'delivery_settlements',
    'delivery_ledger_entries'
])

const budgetClient = supabase.schema('budget')
const crmClient = supabase.schema('crm')
const realEstateClient = supabase.schema('real_estate')
const travelTransportationClient = supabase.schema('travel_transportation')
const activitiesClient = supabase.schema('activities')
const fxClient = supabase.schema('fx')
const clinicsClient = supabase.schema('clinics')
const fleetClient = supabase.schema('fleet')
const rentalClient = supabase.schema('car_rental')
const deliveryClient = supabase.schema('delivery')
const paymentAccountsClient = supabase.schema('payment_accounts')

export function isBudgetTable(tableName: string): boolean {
    return budgetTables.has(tableName)
}

export function isCrmTable(tableName: string): boolean {
    return crmTables.has(tableName)
}

export function isRealEstateTable(tableName: string): boolean {
    return realEstateTables.has(tableName)
}

// Partner reads use workspace-scoped RPCs; raw SELECT remains revoked so all
// directory reads pass through the active-workspace check.
const workspaceScopedPartnerReadRpcs: Record<string, string> = {
    business_partners: 'list_visible_business_partners',
    customers: 'list_visible_customers',
    suppliers: 'list_visible_suppliers'
}

// Writes use explicit RPCs so workspace and module authorization are checked
// consistently by the database.
const partnerSyncWriteRpcs: Record<string, string> = {
    business_partners: 'sync_business_partner',
    customers: 'sync_customer',
    suppliers: 'sync_supplier'
}

export function isTravelTransportationTable(tableName: string): boolean {
    return travelTransportationTables.has(tableName)
}

export function isFxTable(tableName: string): boolean {
    return fxTables.has(tableName)
}

export function isClinicsTable(tableName: string): boolean {
    return clinicsTables.has(tableName)
}

export function isActivitiesTable(tableName: string): boolean {
    return activitiesTables.has(tableName)
}

export function isFleetTable(tableName: string): boolean {
    return fleetTables.has(tableName)
}

export function isRentalTable(tableName: string): boolean {
    return rentalTables.has(tableName)
}

export function isDeliveryTable(tableName: string): boolean {
    return deliveryTables.has(tableName)
}

export function isPaymentAccountTable(tableName: string): boolean {
    return paymentAccountTables.has(tableName)
}

export function getSupabaseRemoteTableName(tableName: string): string {
    return paymentAccountRemoteTableNames[tableName] ?? tableName
}

export function getWorkspaceScopedPartnerReadRpc(tableName: string): string | undefined {
    return workspaceScopedPartnerReadRpcs[tableName]
}

export function getPartnerSyncWriteRpc(tableName: string): string | undefined {
    return partnerSyncWriteRpcs[tableName]
}

export function getFleetSupabaseClient() {
    return fleetClient
}

export function getSupabaseClientForTable(tableName: string) {
    if (isBudgetTable(tableName)) {
        return budgetClient
    }

    if (isCrmTable(tableName)) {
        return crmClient
    }

    if (isRealEstateTable(tableName)) {
        return realEstateClient
    }

    if (isTravelTransportationTable(tableName)) {
        return travelTransportationClient
    }

    if (isActivitiesTable(tableName)) {
        return activitiesClient
    }

    if (isFxTable(tableName)) {
        return fxClient
    }

    if (isClinicsTable(tableName)) {
        return clinicsClient
    }

    if (isFleetTable(tableName)) {
        return fleetClient
    }

    if (isRentalTable(tableName)) {
        return rentalClient
    }

    if (isDeliveryTable(tableName)) {
        return deliveryClient
    }

    if (isPaymentAccountTable(tableName)) {
        return paymentAccountsClient
    }

    return supabase
}
