import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Download, Loader2, X, XCircle } from 'lucide-react'
import {
  runModuleWideIntegrityAudit,
  type ModuleWideIntegrityAuditAdapter,
  type ModuleWideIntegrityAuditGroupSummary,
  type ModuleWideIntegrityAuditProgress,
  type ModuleWideIntegrityAuditRow
} from '@/lib/integrityAudit/moduleWide'
import { downloadModuleWideIntegrityAuditReferences, getModuleWideIntegrityAuditExportRows, type ModuleWideIntegrityAuditExportType } from '@/lib/integrityAudit/moduleWideExport'
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
import { IntegrityAuditCategoryIcon } from './IntegrityAuditCategoryIcon'

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
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3">
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
          <GroupIssueIcons groups={row.groups ?? []} />
        </div>
      </div>
    ))}
  </div>
}

function GroupIssueIcons({ groups }: { groups: readonly ModuleWideIntegrityAuditGroupSummary[] }) {
  const { t } = useTranslation()
  const issueGroups = groups.filter(group => group.warnings > 0 || group.failed > 0)
  if (issueGroups.length === 0) return null

  return <div role="list" aria-label={t('moduleWideIntegrityAudit.issueGroups')} className="flex basis-full flex-wrap items-center gap-2">
    {issueGroups.map(group => {
      const label = t(`transactionAudit.categories.${group.category}`)
      const ariaLabel = t('moduleWideIntegrityAudit.groupIssueSummary', {
        group: label,
        warnings: group.warnings,
        failed: group.failed
      })
      return <div
        key={group.category}
        role="listitem"
        aria-label={ariaLabel}
        title={ariaLabel}
        className="inline-flex min-h-9 items-center gap-2 rounded-md border bg-background/70 px-2.5 py-1"
      >
        <IntegrityAuditCategoryIcon category={group.category} className="h-5 w-5" />
        {group.warnings > 0 && <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />{group.warnings}
        </span>}
        {group.failed > 0 && <span className="inline-flex items-center gap-1 text-sm font-medium text-destructive">
          <XCircle className="h-4 w-4" aria-hidden="true" />{group.failed}
        </span>}
      </div>
    })}
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
  const [cancelRequested, setCancelRequested] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [exportErrorKey, setExportErrorKey] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    setRows(null)
    setProgress(null)
    setRunning(false)
    setCancelRequested(false)
    setCancelled(false)
    setErrorKey(null)
    setExportErrorKey(null)
    return () => controllerRef.current?.abort()
  }, [open])

  async function startAudit() {
    if (running || transactions.length === 0) return
    setRows([])
    setProgress({ completed: 0, total: transactions.length })
    setErrorKey(null)
    setExportErrorKey(null)
    setCancelRequested(false)
    setCancelled(false)
    setRunning(true)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const snapshot = [...transactions]
      const result = await runModuleWideIntegrityAudit(
        snapshot,
        adapter,
        setProgress,
        4,
        (row, transactionIndex) => setRows(current => {
          const next = [...(current ?? [])]
          next[transactionIndex] = row
          return next.filter(result => result !== undefined)
        }),
        controller.signal
      )
      setRows(result)
      setCancelled(controller.signal.aborted)
    } catch (error) {
      const messageKey = error && typeof error === 'object' && 'messageKey' in error
        && typeof error.messageKey === 'string'
        ? error.messageKey
        : 'moduleWideIntegrityAudit.failed'
      setErrorKey(messageKey)
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      setRunning(false)
      setCancelRequested(false)
    }
  }

  function cancelAudit() {
    if (!running || cancelRequested || !controllerRef.current
      || (progress && progress.completed >= progress.total)) return
    setCancelRequested(true)
    controllerRef.current.abort()
  }

  async function exportRows(type: ModuleWideIntegrityAuditExportType) {
    if (!rows) return
    setExportErrorKey(null)
    try {
      await downloadModuleWideIntegrityAuditReferences(rows, type)
    } catch {
      setExportErrorKey('moduleWideIntegrityAudit.exportFailed')
    }
  }

  const exportOptions: Array<{ type: ModuleWideIntegrityAuditExportType; labelKey: string }> = [
    { type: 'warnings', labelKey: 'moduleWideIntegrityAudit.exportWarnings' },
    { type: 'failures', labelKey: 'moduleWideIntegrityAudit.exportFailures' },
    { type: 'warnings-and-failures', labelKey: 'moduleWideIntegrityAudit.exportWarningsAndFailures' }
  ]

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
            {cancelRequested
              ? t('moduleWideIntegrityAudit.cancelling')
              : t('moduleWideIntegrityAudit.progress', { ...progress, moduleName: transactionLabel })}
          </div>
        )}

        {cancelled && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">
          {t('moduleWideIntegrityAudit.cancelled', { count: rows?.length ?? 0 })}
        </p>}

        {errorKey && (
          <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
            {t(errorKey)}
          </p>
        )}

        {exportErrorKey && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t(exportErrorKey)}</p>}

        {!running && rows && rows.length > 0 && <div className="flex flex-wrap gap-2">
          {exportOptions.map(option => {
            const hasMatches = getModuleWideIntegrityAuditExportRows(rows, option.type).length > 0
            return <Button
              key={option.type}
              type="button"
              variant="outline"
              disabled={!hasMatches}
              onClick={() => { void exportRows(option.type) }}
              className="gap-2"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {t(option.labelKey)}
            </Button>
          })}
        </div>}

        {rows && rows.length > 0 && <ModuleWideIntegrityAuditResults rows={rows} />}
      </AppDialogBody>
      <AppDialogFooter>
        {running && <Button type="button" variant="outline"
          disabled={cancelRequested || Boolean(progress && progress.completed >= progress.total)}
          onClick={cancelAudit}>
          {cancelRequested
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            : <X className="mr-2 h-4 w-4" aria-hidden="true" />}
          {t(cancelRequested ? 'moduleWideIntegrityAudit.cancelling' : 'moduleWideIntegrityAudit.cancel')}
        </Button>}
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
