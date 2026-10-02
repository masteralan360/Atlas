export type TransactionIntegritySeverity = 'passed' | 'warning' | 'failed'

export interface TransactionIntegrityCounts {
  passed: number
  warnings: number
  failed: number
}

export function getTransactionIntegritySeverity(counts: TransactionIntegrityCounts): TransactionIntegritySeverity {
  if (counts.failed > 0) return 'failed'
  if (counts.warnings > 0) return 'warning'
  return 'passed'
}
