import { ClipboardCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/components'
import type { TransactionIntegrityAuditPhase } from './useDeferredTransactionIntegrityAudit'

const phaseColor: Record<TransactionIntegrityAuditPhase, string> = {
  idle: 'text-muted-foreground',
  scheduled: 'text-amber-600 dark:text-amber-400',
  running: 'text-amber-600 dark:text-amber-400',
  passed: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  failed: 'text-destructive',
  error: 'text-muted-foreground'
}

export function TransactionIntegrityAuditAction({
  onClick,
  phase = 'idle'
}: {
  onClick: () => void
  phase?: TransactionIntegrityAuditPhase
}) {
  const { t } = useTranslation()
  const label = t('transactionAudit.run')
  const statusLabel = phase === 'idle' ? null : t(`transactionAudit.iconStatus.${phase}`)
  const accessibleLabel = statusLabel ? `${label} · ${statusLabel}` : label

  return <Button
    type="button"
    variant="ghost"
    size="icon"
    allowViewer
    className="h-6 w-6 shrink-0 rounded-md p-0 text-muted-foreground hover:text-foreground"
    aria-label={accessibleLabel}
    title={accessibleLabel}
    onClick={onClick}
  >
    <ClipboardCheck className={`!h-3.5 !w-3.5 ${phaseColor[phase]} ${phase === 'running' ? 'motion-safe:animate-pulse' : ''}`} aria-hidden="true" />
  </Button>
}
