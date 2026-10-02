import { TransactionIntegrityAuditAction } from '@/ui/components/integrity-audit/TransactionIntegrityAuditAction'
import type { TransactionIntegrityAuditPhase } from '@/ui/components/integrity-audit/useDeferredTransactionIntegrityAudit'

export function LoanIntegrityAuditBreadcrumbAction({ onClick, phase }: {
  onClick: () => void
  phase?: TransactionIntegrityAuditPhase
}) {
  return <TransactionIntegrityAuditAction onClick={onClick} phase={phase} />
}
