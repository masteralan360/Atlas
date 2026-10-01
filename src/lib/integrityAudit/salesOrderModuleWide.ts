import type { WorkspaceDataMode } from '@/local-db/models'
import type { SalesOrder } from '@/local-db/models'
import { runSalesOrderIntegrityAudit } from './salesOrderAudit'
import type { IntegrityAuditResult } from './types'
import type { ModuleWideIntegrityAuditAdapter } from './moduleWide'

export function createSalesOrderModuleWideIntegrityAuditAdapter(
  workspaceId: string,
  mode: WorkspaceDataMode
): ModuleWideIntegrityAuditAdapter<SalesOrder, IntegrityAuditResult> {
  return {
    getTransactionId: order => order.id,
    getTransactionReference: order => order.orderNumber,
    auditTransaction: order => runSalesOrderIntegrityAudit(workspaceId, order.id, mode),
    getSummary: result => result.summary
  }
}
