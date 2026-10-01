import type { WorkspaceDataMode } from '@/local-db/models'
import type { SalesOrder } from '@/local-db/models'
import { runSalesOrderIntegrityAudit } from './salesOrderAudit'
import type { AuditCategory, IntegrityAuditResult } from './types'
import type { ModuleWideIntegrityAuditAdapter, ModuleWideIntegrityAuditGroupSummary } from './moduleWide'

function summarizeGroups(result: IntegrityAuditResult): ModuleWideIntegrityAuditGroupSummary[] {
  const groups = new Map<AuditCategory, { warnings: number; failed: number }>()

  for (const check of result.checks) {
    if (check.status !== 'WARNING' && check.status !== 'FAIL') continue
    const counts = groups.get(check.category) ?? { warnings: 0, failed: 0 }
    if (check.status === 'WARNING') counts.warnings += 1
    else counts.failed += 1
    groups.set(check.category, counts)
  }

  return Array.from(groups, ([category, counts]) => ({ category, ...counts }))
}

export function createSalesOrderModuleWideIntegrityAuditAdapter(
  workspaceId: string,
  mode: WorkspaceDataMode
): ModuleWideIntegrityAuditAdapter<SalesOrder, IntegrityAuditResult> {
  return {
    getTransactionId: order => order.id,
    getTransactionReference: order => order.orderNumber,
    auditTransaction: order => runSalesOrderIntegrityAudit(workspaceId, order.id, mode),
    getSummary: result => ({ ...result.summary, groups: summarizeGroups(result) })
  }
}
