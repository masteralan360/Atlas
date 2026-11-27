import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Database, Download, Loader2, RefreshCw, XCircle } from 'lucide-react'
import type { AuditCategory, AuditStatus, IntegrityAuditResult } from '@/lib/integrityAudit/salesOrderAudit'
import { AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle, Button } from '@/ui/components'
import { downloadIntegrityAuditModel } from '@/lib/integrityAudit/auditModelExport'
import { AuditModelJsonPanel } from '@/ui/components/integrity-audit/AuditModelJsonPanel'
import { IntegrityAuditCategoryIcon } from '@/ui/components/integrity-audit/IntegrityAuditCategoryIcon'

const categories: AuditCategory[] = ['order', 'items', 'inventory', 'payments', 'loan', 'relationships', 'mirror']
export { AuditModelJsonPanel } from '@/ui/components/integrity-audit/AuditModelJsonPanel'

function StatusIcon({ status }: { status: AuditStatus }) {
  return status === 'FAIL' ? <XCircle className="h-4 w-4 text-destructive" />
    : status === 'WARNING' ? <AlertTriangle className="h-4 w-4 text-amber-600" />
      : status === 'NOT_APPLICABLE' ? <Database className="h-4 w-4 text-muted-foreground" />
      : <CheckCircle2 className="h-4 w-4 text-emerald-600" />
}

function displayValue(value: unknown) {
  if (value === undefined) return '—'
  if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 6 })
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return serialized.length > 300 ? `${serialized.slice(0, 300)}…` : serialized
}

function findingKey(check: IntegrityAuditResult['checks'][number]) {
  return `${check.code}:${check.entityType}:${check.entityId ?? ''}`
}

export function SalesOrderIntegrityAuditDialog({ open, onOpenChange, orderId, orderType = 'sales', result, previousResult = null, errorKey, loading, onRunAgain }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderId: string
  orderType?: 'sales' | 'purchase'
  result: IntegrityAuditResult | null
  previousResult?: IntegrityAuditResult | null
  errorKey: string | null
  loading: boolean
  onRunAgain?: () => void
}) {
  const { t, i18n } = useTranslation()
  const [exporting, setExporting] = useState(false)
  const [exportErrorKey, setExportErrorKey] = useState<string | null>(null)
  const [showPassedChecks, setShowPassedChecks] = useState(false)
  const processing = loading || exporting

  async function exportAuditModel() {
    if (!result || processing) return
    setExportErrorKey(null)
    setExporting(true)
    try {
      await downloadIntegrityAuditModel(result)
    } catch {
      setExportErrorKey('transactionAudit.exportFailed')
    } finally {
      setExporting(false)
    }
  }

  return <AppDialog open={open} onOpenChange={next => { if (!processing) onOpenChange(next) }}>
    <AppDialogContent className="max-w-3xl" showCloseButton={!processing} onEscapeKeyDown={event => { if (processing) event.preventDefault() }} onPointerDownOutside={event => { if (processing) event.preventDefault() }}>
      <AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5" />{t('transactionAudit.title')}</AppDialogTitle></AppDialogHeader>
      <AppDialogBody className="space-y-4">
        {loading && <div role="status" className="flex items-center gap-2 py-8 text-sm"><Loader2 className="h-5 w-5 animate-spin" />{t('transactionAudit.running')}</div>}
        {errorKey && <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{t(errorKey)}</p>}
        {exportErrorKey && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t(exportErrorKey)}</p>}
        {result && <>
          <div className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2 font-semibold"><StatusIcon status={result.integrityStatus} />{t('transactionAudit.transactionStatus')}: {t(`transactionAudit.status.${result.integrityStatus}`)}</div>
            <div className="mt-1 text-sm text-muted-foreground">{t(orderType === 'sales' ? 'transactionAudit.orderNumber' : 'transactionAudit.purchaseOrderNumber', { number: result.transactionNumber ?? orderId })}</div>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Database className="h-3 w-3" />{t('transactionAudit.source')}: {result.sourceOfTruth === 'supabase' ? 'Supabase' : 'SQLite'}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t('transactionAudit.auditedAt')}: {new Date(result.auditedAt).toLocaleString(i18n.resolvedLanguage || i18n.language)}</div>
            <div className="mt-2 text-sm">{t('transactionAudit.summary', result.summary)}</div>
            {result.summary.warnings > 0 && <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-muted-foreground">{t('transactionAudit.warningExplanation')}</p>}
            {result.mirrorStatus && <div className="mt-2 flex items-center gap-2 text-sm"><StatusIcon status={result.mirrorStatus} />{t('transactionAudit.mirrorStatus')}: {t(`transactionAudit.status.${result.mirrorStatus}`)}</div>}
          </div>
          {previousResult && previousResult.auditedAt !== result.auditedAt && (() => {
            const previous = new Set(previousResult.checks.filter(check => check.status === 'FAIL' || check.status === 'WARNING').map(findingKey))
            const current = new Set(result.checks.filter(check => check.status === 'FAIL' || check.status === 'WARNING').map(findingKey))
            const cleared = [...previous].filter(key => !current.has(key)).length
            const added = [...current].filter(key => !previous.has(key)).length
            const remaining = [...current].filter(key => previous.has(key)).length
            return <div role="status" className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
              <div className="font-medium">{t('transactionAudit.comparisonTitle')}</div>
              <p className="mt-1 text-muted-foreground">{t('transactionAudit.comparisonSummary', { cleared, added, remaining })}</p>
            </div>
          })()}
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" disabled={result.summary.passed === 0} onClick={() => setShowPassedChecks(value => !value)} className="gap-2">
              <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
              {t(showPassedChecks ? 'transactionAudit.hidePassedChecks' : 'transactionAudit.showPassedChecks')}
            </Button>
          </div>
          {categories.filter(category => category !== 'mirror' || result.mirrorStatus).map(category => {
            const rows = result.checks.filter(check => check.category === category)
            const visibleRows = rows.filter(check => showPassedChecks || check.status !== 'PASS')
            const status: AuditStatus = rows.length === 0 ? 'NOT_APPLICABLE' : rows.some(row => row.status === 'FAIL') ? 'FAIL' : rows.some(row => row.status === 'WARNING') ? 'WARNING' : 'PASS'
            return <details key={category} className="rounded-lg border p-3" open={status !== 'PASS' || undefined}>
              <summary className="flex cursor-pointer items-center gap-2 font-medium"><StatusIcon status={status} /><IntegrityAuditCategoryIcon category={category} />{t(`transactionAudit.categories.${category}`)} <span className="text-xs text-muted-foreground">({rows.length})</span>{status === 'NOT_APPLICABLE' && <span className="text-xs text-muted-foreground">{t('transactionAudit.status.NOT_APPLICABLE')}</span>}</summary>
              <div className="mt-3 space-y-2">
                {visibleRows.map((check, index) => <div key={`${check.code}:${check.entityId ?? index}`} className="rounded-md bg-muted/50 p-3 text-sm">
                  <div className="flex items-center gap-2"><StatusIcon status={check.status} /><span className="font-mono text-xs break-all">{check.code}</span></div>
                  {check.status !== 'PASS' && <p className="mt-1 text-sm">{t(`transactionAudit.codes.${check.code}`, { defaultValue: t('transactionAudit.mismatch') })}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{t('transactionAudit.entity')}: {check.entityType}{check.entityId ? ` · ${check.entityId}` : ''}</p>
                  {check.status !== 'PASS' && (check.expected !== undefined || check.actual !== undefined) && <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                    <span className="break-all">{t('transactionAudit.expected')}: {displayValue(check.expected)}</span>
                    <span className="break-all">{t('transactionAudit.actual')}: {displayValue(check.actual)}</span>
                  </div>}
                  {check.status !== 'PASS' && <p className="mt-2 border-s-2 border-primary/40 ps-2 text-xs text-muted-foreground">{t(`transactionAudit.nextStep.${check.category}`)}</p>}
                </div>)}
                {visibleRows.length === 0 && <p className="text-sm text-muted-foreground">{t('transactionAudit.noFindingsInCategory')}</p>}
              </div>
            </details>
          })}
          <AuditModelJsonPanel result={result} />
        </>}
      </AppDialogBody>
      <AppDialogFooter>
        {result && onRunAgain && <Button type="button" variant="outline" disabled={processing} onClick={onRunAgain} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          {t(loading ? 'transactionAudit.running' : 'transactionAudit.runAgain')}
        </Button>}
        {result && <Button type="button" variant="outline" disabled={processing} onClick={() => { void exportAuditModel() }} className="gap-2">
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
          {t(exporting ? 'transactionAudit.exportingJson' : 'transactionAudit.exportJson')}
        </Button>}
        <Button variant="outline" disabled={processing} onClick={() => onOpenChange(false)}>{t('transactionAudit.close')}</Button>
      </AppDialogFooter>
    </AppDialogContent>
  </AppDialog>
}
