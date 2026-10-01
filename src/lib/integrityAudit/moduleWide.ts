import type { AuditCategory } from './types'

export interface ModuleWideIntegrityAuditGroupSummary {
  category: AuditCategory
  warnings: number
  failed: number
}

export interface IntegrityAuditCounts {
  passed: number
  warnings: number
  failed: number
  groups?: ModuleWideIntegrityAuditGroupSummary[]
}

export interface ModuleWideIntegrityAuditRow extends IntegrityAuditCounts {
  transactionId: string
  transactionReference: string
  status: 'PASS' | 'WARNING' | 'FAIL'
  groups?: ModuleWideIntegrityAuditGroupSummary[]
}

export interface ModuleWideIntegrityAuditAdapter<TTransaction, TAuditResult> {
  getTransactionId(transaction: TTransaction): string
  getTransactionReference(transaction: TTransaction): string
  auditTransaction(transaction: TTransaction): Promise<TAuditResult>
  getSummary(result: TAuditResult): IntegrityAuditCounts
}

export interface ModuleWideIntegrityAuditProgress {
  completed: number
  total: number
}

export async function runModuleWideIntegrityAudit<TTransaction, TAuditResult>(
  transactions: readonly TTransaction[],
  adapter: ModuleWideIntegrityAuditAdapter<TTransaction, TAuditResult>,
  onProgress?: (progress: ModuleWideIntegrityAuditProgress) => void,
  concurrency = 4,
  onResult?: (row: ModuleWideIntegrityAuditRow, transactionIndex: number) => void,
  signal?: AbortSignal
): Promise<ModuleWideIntegrityAuditRow[]> {
  if (transactions.length === 0) return []

  const rows = new Array<ModuleWideIntegrityAuditRow>(transactions.length)
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, transactions.length))
  let nextIndex = 0
  let completed = 0
  let hasError = false
  let firstError: unknown

  const runWorker = async () => {
    while (!hasError && !signal?.aborted) {
      const index = nextIndex++
      if (index >= transactions.length) return

      const transaction = transactions[index]
      try {
        const result = await adapter.auditTransaction(transaction)
        const summary = adapter.getSummary(result)
        const row: ModuleWideIntegrityAuditRow = {
          transactionId: adapter.getTransactionId(transaction),
          transactionReference: adapter.getTransactionReference(transaction),
          passed: summary.passed,
          warnings: summary.warnings,
          failed: summary.failed,
          status: summary.failed > 0 ? 'FAIL' : summary.warnings > 0 ? 'WARNING' : 'PASS',
          ...(summary.groups ? { groups: summary.groups } : {})
        }
        rows[index] = row
        onResult?.(row, index)
      } catch (error) {
        if (!hasError) {
          hasError = true
          firstError = error
        }
      } finally {
        completed += 1
        onProgress?.({ completed, total: transactions.length })
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  if (hasError) throw firstError
  return rows.filter((row): row is ModuleWideIntegrityAuditRow => row !== undefined)
}
