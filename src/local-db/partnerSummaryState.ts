import { queryClient } from '@/query/queryClient'
import { queryKeys } from '@/query/queryKeys'

/** Derived read-model fields must not survive in new or previously queued writes. */
export const partnerSummaryRemoteFields: Readonly<Record<string, readonly string[]>> = {
  business_partners: [
    'total_sales_orders', 'total_sales_value', 'receivable_balance', 'total_purchase_orders',
    'total_purchase_value', 'payable_balance', 'total_loan_count', 'loan_outstanding_balance', 'net_exposure',
    'receivable_currency_totals', 'payable_currency_totals', 'summary_source', 'summary_default_currency',
  ],
  customers: ['total_orders', 'total_spent', 'outstanding_balance'],
  suppliers: ['total_purchases', 'total_spent'],
}

export function stripPartnerSummaryFields(table: string, payload: Record<string, unknown>) {
  for (const field of partnerSummaryRemoteFields[table] ?? []) delete payload[field]
  return payload
}

const invalidating = new Set<string>()
export function invalidatePartnerSummaries(workspaceId: string) {
  // Invalidation starts an active reader's refresh without putting that network
  // request on an order/payment's persistence path. Inactive readers refetch on mount.
  if (invalidating.has(workspaceId)) return
  invalidating.add(workspaceId)
  queueMicrotask(() => {
    invalidating.delete(workspaceId)
    void queryClient.invalidateQueries({ queryKey: queryKeys.businessPartners.all(workspaceId) })
  })
}
