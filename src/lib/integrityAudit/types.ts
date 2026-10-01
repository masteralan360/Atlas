export type AuditCategory = 'order' | 'items' | 'inventory' | 'payments' | 'loan' | 'installments' | 'relationships' | 'mirror'
export type AuditStatus = 'PASS' | 'WARNING' | 'FAIL' | 'NOT_APPLICABLE'

export interface IntegrityAuditCheck {
  code: string
  category: AuditCategory
  status: AuditStatus
  severity: 'info' | 'warning' | 'error' | 'critical'
  entityType: string
  entityId?: string
  expected?: unknown
  actual?: unknown
}

export interface IntegrityAuditResult<TActual = unknown> {
  transactionType: string
  transactionId: string
  transactionNumber?: string
  workspaceId: string
  auditedAt: string
  sourceOfTruth: 'supabase' | 'sqlite'
  integrityStatus: AuditStatus
  mirrorStatus: AuditStatus | null
  checks: IntegrityAuditCheck[]
  summary: { total: number; passed: number; warnings: number; failed: number }
  expected: Record<string, unknown>
  actual: TActual
  mirrorActual: TActual | null
}

export class IntegrityAuditReadError extends Error {
  readonly code = 'AUDIT_SOURCE_READ_FAILED'
  readonly messageKey = 'transactionAudit.loadFailed'
  readonly cause: unknown
  constructor(readonly source: 'supabase' | 'sqlite', cause: unknown) {
    super(`Unable to read the ${source} audit graph`)
    this.cause = cause
  }
}
