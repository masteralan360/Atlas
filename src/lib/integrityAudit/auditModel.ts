import type { IntegrityAuditResult } from './types'

/** The inspectable, read-only snapshot shown to the user for this audit run. */
export function buildIntegrityAuditModel(result: IntegrityAuditResult) {
  const actual = result.actual && typeof result.actual === 'object'
    ? result.actual as Record<string, { status?: unknown; currency?: unknown; settlementCurrency?: unknown } | null>
    : {}
  const transaction = actual.order ?? actual.loan
  return {
    schemaVersion: 1,
    transaction: {
      type: result.transactionType,
      id: result.transactionId,
      number: result.transactionNumber ?? null,
      workspaceId: result.workspaceId,
      status: transaction?.status ?? null,
      currency: transaction?.currency ?? transaction?.settlementCurrency ?? null
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
