import type { OfflineMutationEntityType } from '@/local-db/models'

export type SyncMutationKind = 'entity' | 'command' | 'derived' | 'control'

export interface SyncRegistration {
  kind: SyncMutationKind
  payloadSchemaVersion: number
  /** Entity rows may be compacted only while no attempt has been leased. */
  compact: boolean
  /** Whether the queued payload is also the materialized local post-state. */
  materializePayload: boolean
  /** Control-plane actions are deliberately unavailable while offline. */
  onlineOnly?: boolean
}

const entity = (): SyncRegistration => ({
  kind: 'entity',
  payloadSchemaVersion: 1,
  compact: true,
  materializePayload: true,
})

const command = (): SyncRegistration => ({
  kind: 'command',
  payloadSchemaVersion: 1,
  compact: false,
  materializePayload: false,
})

const derived = (): SyncRegistration => ({
  kind: 'derived',
  payloadSchemaVersion: 1,
  compact: false,
  materializePayload: false,
})

const control = (): SyncRegistration => ({
  kind: 'control',
  payloadSchemaVersion: 1,
  compact: false,
  materializePayload: false,
  onlineOnly: true,
})

/**
 * Mandatory Cloud Sync registry.
 *
 * Every value in OfflineMutationEntityType is intentionally classified here.
 * Adding a new queue type without making a durability/protocol decision is a
 * TypeScript error and is also covered by the registry tests.
 */
export const SYNC_REGISTRY = {
  products: entity(),
  product_barcodes: entity(),
  price_books: entity(),
  price_book_items: entity(),
  activity_catalog: entity(),
  activity_transactions: command(),
  activity_transaction_lines: derived(),
  inventory: derived(),
  inventory_transactions: command(),
  stock_batches: derived(),
  reorder_transfer_rules: entity(),
  inventory_transfer_transactions: command(),
  invoices: entity(),
  users: entity(),
  sales: command(),
  sale_product_exchanges: command(),
  order_returns: command(),
  order_return_items: derived(),
  categories: entity(),
  units: entity(),
  product_discounts: entity(),
  category_discounts: entity(),
  workspaces: control(),
  workspace_branches: control(),
  storages: entity(),
  employees: entity(),
  workspace_contacts: entity(),
  // Loan creation/payment/reversal remain immutable commands, while a loan's
  // editable metadata (notes and linked partner) is an ordinary entity intent.
  loans: entity(),
  loan_installments: derived(),
  loan_payments: derived(),
  loan_commands: command(),
  installment_sales: command(),
  installment_sale_installments: derived(),
  installment_sale_payments: derived(),
  payment_transactions: command(),
  financial_transaction_voids: command(),
  payment_accounts: entity(),
  capital_pools: entity(),
  payment_account_balances: derived(),
  payment_account_movements: derived(),
  cashier_shifts: command(),
  cashier_shift_currency_counts: derived(),
  cashier_shift_templates: entity(),
  cashier_shift_assignments: entity(),
  cashier_shift_occurrences: command(),
  cashier_shift_pause_requests: command(),
  cashier_shift_pause_periods: derived(),
  budget_settings: entity(),
  budget_allocations: entity(),
  expense_categories: entity(),
  expense_series: command(),
  expense_items: derived(),
  payroll_statuses: command(),
  dividend_statuses: command(),
  customers: entity(),
  suppliers: entity(),
  agents: entity(),
  agent_excluded_categories: entity(),
  agent_commission_plans: entity(),
  agent_commission_memberships: entity(),
  product_commission_rules: entity(),
  product_commission_rule_agents: entity(),
  sales_order_agent_assignments: entity(),
  agent_commission_entries: derived(),
  agent_product_commission_entries: derived(),
  sales_agent_commission_reconciliation: command(),
  fleet_vehicles: entity(),
  fleet_vehicle_assignments: entity(),
  delivery_merchant_profiles: entity(),
  delivery_shipments: command(),
  delivery_shipment_events: command(),
  delivery_shipment_cod_adjustment_requests: command(),
  delivery_shipment_cod_corrections: derived(),
  delivery_shipment_recipient_payout_corrections: derived(),
  delivery_shipment_recipient_payout_adjustment_requests: command(),
  delivery_runs: command(),
  delivery_run_items: derived(),
  delivery_settlements: command(),
  delivery_ledger_entries: derived(),
  delivery_voice_cleanup: command(),
  rental_vehicles: entity(),
  rental_requests: command(),
  rental_contracts: command(),
  business_partners: entity(),
  business_partner_merge_candidates: derived(),
  sales_orders: command(),
  purchase_orders: command(),
  order_installments: derived(),
  real_estate_transactions: command(),
  real_estate_installments: derived(),
  real_estate_payments: derived(),
  travel_bookings: command(),
  travel_passengers: derived(),
  exchange_pair_prices: entity(),
  exchange_transactions: command(),
  exchange_fee_rules: entity(),
  fx_safes: entity(),
  fx_safe_balances: derived(),
  fx_safe_movements: derived(),
  clinical_appointments: command(),
  clinical_patients: entity(),
  clinical_attachments: entity(),
  clinical_presets: entity(),
  manual_entry_templates: entity(),
  manual_entries: command(),
  restaurant_table_settings: entity(),
  restaurant_pos_tickets: command(),
} satisfies Record<OfflineMutationEntityType, SyncRegistration>

export function getSyncRegistration(entityType: OfflineMutationEntityType) {
  const registration = SYNC_REGISTRY[entityType]
  if (!registration) {
    throw new Error(`Unregistered Cloud Sync mutation type: ${entityType}`)
  }
  return registration
}

export function isDerivedSyncEntity(entityType: OfflineMutationEntityType) {
  return getSyncRegistration(entityType).kind === 'derived'
}
