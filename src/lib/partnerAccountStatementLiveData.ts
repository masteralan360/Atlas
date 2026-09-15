export const PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES = [
  'business_partners',
  'agents',
  'sales_order_agent_assignments',
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

export type PartnerAccountStatementLiveDataProgress = {
  completedSources: number
  totalSources: number
}

export interface PartnerAccountStatementLiveDataRefreshers {
  refreshTable: (
    tableName: PartnerAccountStatementLiveTableName,
    workspaceId: string
  ) => Promise<void>
  refreshSales: (workspaceId: string) => Promise<void>
  onProgress?: (progress: PartnerAccountStatementLiveDataProgress) => void
}

/**
 * Refreshes every source used to calculate a partner account statement.
 * The caller decides how remote rows are mirrored into the local UI cache.
 */
export async function refreshPartnerAccountStatementLiveData(
  workspaceId: string,
  refreshers: PartnerAccountStatementLiveDataRefreshers
) {
  const totalSources = PARTNER_ACCOUNT_STATEMENT_FRESHNESS_TABLE_NAMES.length
  let completedSources = 0
  const reportSourceCompletion = () => {
    completedSources += 1
    refreshers.onProgress?.({ completedSources, totalSources })
  }

  await Promise.all([
    ...PARTNER_ACCOUNT_STATEMENT_LIVE_TABLE_NAMES.map(async (tableName) => {
      await refreshers.refreshTable(tableName, workspaceId)
      reportSourceCompletion()
    }),
    (async () => {
      await refreshers.refreshSales(workspaceId)
      reportSourceCompletion()
    })()
  ])
}
