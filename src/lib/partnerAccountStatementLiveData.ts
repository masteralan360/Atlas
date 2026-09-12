export const PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES = [
  'business_partners',
  'agents',
  'agent_commission_entries',
  'agent_product_commission_entries',
  'sales_orders',
  'order_returns',
  'order_return_items',
  'purchase_orders',
  'loans',
  'loan_payments',
  'installment_sales',
  'payment_transactions',
  'delivery_merchant_profiles',
  'delivery_ledger_entries',
  'delivery_shipments',
  'delivery_settlements'
] as const

export const PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES = [
  ...PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES,
  'sales'
] as const

export type PartnerAccountStatementLiveTableName =
  (typeof PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES)[number]

export interface PartnerAccountStatementLiveDataRefreshers {
  refreshTable: (
    tableName: PartnerAccountStatementLiveTableName,
    workspaceId: string
  ) => Promise<void>
  refreshSales: (workspaceId: string) => Promise<void>
}

/**
 * Refreshes every source used to calculate a partner account statement.
 * The caller decides how remote rows are mirrored into the local UI cache.
 */
export async function refreshPartnerAccountStatementLiveData(
  workspaceId: string,
  refreshers: PartnerAccountStatementLiveDataRefreshers
) {
  await Promise.all([
    ...PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES.map((tableName) =>
      refreshers.refreshTable(tableName, workspaceId)
    ),
    refreshers.refreshSales(workspaceId)
  ])
}
