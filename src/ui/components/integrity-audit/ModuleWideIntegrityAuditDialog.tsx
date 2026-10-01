import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Loader2, XCircle } from 'lucide-react'
import {
  runModuleWideIntegrityAudit,
  type ModuleWideIntegrityAuditAdapter,
  type ModuleWideIntegrityAuditProgress,
  type ModuleWideIntegrityAuditRow
} from '@/lib/integrityAudit/moduleWide'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button
} from '@/ui/components'
import { cn } from '@/lib/utils'

const statusClasses = {
  PASS: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
  WARNING: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300',
  FAIL: 'border-destructive/40 bg-destructive/5 text-destructive'
} as const

function StatusIcon({ status }: { status: ModuleWideIntegrityAuditRow['status'] }) {
  if (status === 'FAIL') return <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
  if (status === 'WARNING') return <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
  return <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
}

export function ModuleWideIntegrityAuditResults({ rows }: { rows: readonly ModuleWideIntegrityAuditRow[] }) {
  const { t } = useTranslation()
  return <div role="list" aria-label={t('moduleWideIntegrityAudit.results')} className="space-y-2">
    {rows.map(row => (
      <div
        key={row.transactionId}
        role="listitem"
        className={cn('flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5', statusClasses[row.status])}
      >
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <StatusIcon status={row.status} />
          <span className="truncate">{row.transactionReference}</span>
          <span className="sr-only">{t(`moduleWideIntegrityAudit.status.${row.status}`)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
          <span>{t('moduleWideIntegrityAudit.counts.passed', { count: row.passed })}</span>
          <span>{t('moduleWideIntegrityAudit.counts.warnings', { count: row.warnings })}</span>
          <span>{t('moduleWideIntegrityAudit.counts.failed', { count: row.failed })}</span>
        </div>
      </div>
    ))}
  </div>
}

export function ModuleWideIntegrityAuditDialog<TTransaction, TAuditResult>({
  open,
  onOpenChange,
  transactions,
  adapter,
  transactionLabel
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  transactions: readonly TTransaction[]
  adapter: ModuleWideIntegrityAuditAdapter<TTransaction, TAuditResult>
  transactionLabel: string
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<ModuleWideIntegrityAuditRow[] | null>(null)
  const [progress, setProgress] = useState<ModuleWideIntegrityAuditProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRows(null)
    setProgress(null)
    setRunning(false)
    setErrorKey(null)
  }, [open])

  async function startAudit() {
    if (running || transactions.length === 0) return
    setRows(null)
    setProgress({ completed: 0, total: transactions.length })
    setErrorKey(null)
    setRunning(true)
    try {
      const snapshot = [...transactions]
      const result = await runModuleWideIntegrityAudit(snapshot, adapter, setProgress)
      setRows(result)
    } catch (error) {
      const messageKey = error && typeof error === 'object' && 'messageKey' in error
        && typeof error.messageKey === 'string'
        ? error.messageKey
        : 'moduleWideIntegrityAudit.failed'
      setErrorKey(messageKey)
    } finally {
      setRunning(false)
    }
  }

  return <AppDialog open={open} onOpenChange={next => { if (!running) onOpenChange(next) }}>
    <AppDialogContent
      className="max-w-3xl"
      showCloseButton={!running}
      onEscapeKeyDown={event => { if (running) event.preventDefault() }}
      onPointerDownOutside={event => { if (running) event.preventDefault() }}
    >
      <AppDialogHeader>
        <AppDialogTitle className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
          {t('moduleWideIntegrityAudit.title')}
        </AppDialogTitle>
      </AppDialogHeader>
      <AppDialogBody className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t('moduleWideIntegrityAudit.scope', { count: transactions.length, moduleName: transactionLabel })}
        </p>

        {transactions.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('moduleWideIntegrityAudit.empty')}
          </div>
        )}

        {running && progress && (
          <div role="status" className="flex items-center gap-2 rounded-lg border p-3 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('moduleWideIntegrityAudit.progress', { ...progress, moduleName: transactionLabel })}
          </div>
        )}

        {errorKey && (
          <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
            {t(errorKey)}
          </p>
        )}

        {rows && <ModuleWideIntegrityAuditResults rows={rows} />}
      </AppDialogBody>
      <AppDialogFooter>
        <Button variant="outline" disabled={running} onClick={() => onOpenChange(false)}>
          {t('transactionAudit.close')}
        </Button>
        <Button onClick={startAudit} disabled={running || transactions.length === 0}>
          {running
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            : <ClipboardCheck className="mr-2 h-4 w-4" aria-hidden="true" />}
          {running
            ? t('moduleWideIntegrityAudit.running', { moduleName: transactionLabel })
            : t('moduleWideIntegrityAudit.start')}
        </Button>
      </AppDialogFooter>
    </AppDialogContent>
  </AppDialog>
}
