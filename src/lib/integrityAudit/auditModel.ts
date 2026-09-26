import type { IntegrityAuditResult } from './salesOrderAudit'

/** The inspectable, read-only snapshot shown to the user for this audit run. */
export function buildIntegrityAuditModel(result: IntegrityAuditResult) {
  return {
    schemaVersion: 1,
    transaction: {
      type: result.transactionType,
      id: result.transactionId,
      number: result.transactionNumber ?? null,
      workspaceId: result.workspaceId,
      status: result.actual.order?.status ?? null,
      currency: result.actual.order?.currency ?? null
    },
    auditedAt: result.auditedAt,
    sourceOfTruth: result.sourceOfTruth,
    expected: result.expected,
    actual: {
      authoritative: result.actual,
      sqliteMirror: result.mirrorActual
    },
    checks: result.checks,
    summary: {
      integrityStatus: result.integrityStatus,
      mirrorStatus: result.mirrorStatus,
      ...result.summary
    }
  }
}
