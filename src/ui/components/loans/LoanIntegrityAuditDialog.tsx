import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Database, Loader2, XCircle } from 'lucide-react'
import { IntegrityAuditReadError } from '@/lib/integrityAudit/types'
import { runLoanIntegrityAudit, type LoanIntegrityAuditResult } from '@/lib/integrityAudit/loanAudit'
import { AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle, Button } from '@/ui/components'
import { AuditModelJsonPanel } from '@/ui/components/integrity-audit/AuditModelJsonPanel'

const categories = ['loan', 'installments', 'payments', 'relationships', 'mirror'] as const

function StatusIcon({ status }: { status: LoanIntegrityAuditResult['integrityStatus'] }) {
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

export function LoanIntegrityAuditDialog({ open, onOpenChange, workspaceId, loanId, mode }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  loanId: string
  mode: 'cloud' | 'hybrid' | 'local' | 'demo'
}) {
  const { t } = useTranslation()
  const [result, setResult] = useState<LoanIntegrityAuditResult | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setResult(null)
    setErrorKey(null)
    setLoading(true)
    void runLoanIntegrityAudit(workspaceId, loanId, mode)
      .then(value => { if (!cancelled) setResult(value) })
      .catch(error => { if (!cancelled) setErrorKey(error instanceof IntegrityAuditReadError ? error.messageKey : 'transactionAudit.loadFailed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, workspaceId, loanId, mode])

  return <AppDialog open={open} onOpenChange={next => { if (!loading) onOpenChange(next) }}>
    <AppDialogContent className="max-w-3xl" showCloseButton={!loading}
      onEscapeKeyDown={event => { if (loading) event.preventDefault() }}
      onPointerDownOutside={event => { if (loading) event.preventDefault() }}>
      <AppDialogHeader>
        <AppDialogTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5" />{t('transactionAudit.title')}</AppDialogTitle>
      </AppDialogHeader>
      <AppDialogBody className="space-y-4">
        {loading && <div role="status" className="flex items-center gap-2 py-8 text-sm"><Loader2 className="h-5 w-5 animate-spin" />{t('transactionAudit.running')}</div>}
        {errorKey && <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{t(errorKey)}</p>}
        {result && <>
          <div className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2 font-semibold"><StatusIcon status={result.integrityStatus} />{t('transactionAudit.transactionStatus')}: {t(`transactionAudit.status.${result.integrityStatus}`)}</div>
            <div className="mt-1 text-sm text-muted-foreground">{t('transactionAudit.loanNumber', { number: result.transactionNumber ?? loanId })}</div>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Database className="h-3 w-3" />{t('transactionAudit.source')}: {result.sourceOfTruth === 'supabase' ? 'Supabase' : 'SQLite'}</div>
            <div className="mt-2 text-sm">{t('transactionAudit.summary', result.summary)}</div>
            {result.mirrorStatus && <div className="mt-2 flex items-center gap-2 text-sm"><StatusIcon status={result.mirrorStatus} />{t('transactionAudit.mirrorStatus')}: {t(`transactionAudit.status.${result.mirrorStatus}`)}</div>}
          </div>
          {categories.filter(category => category !== 'mirror' || result.mirrorStatus).map(category => {
            const rows = result.checks.filter(item => item.category === category)
            const status: LoanIntegrityAuditResult['integrityStatus'] = rows.length === 0 ? 'NOT_APPLICABLE'
              : rows.some(item => item.status === 'FAIL') ? 'FAIL'
                : rows.some(item => item.status === 'WARNING') ? 'WARNING' : 'PASS'
            return <details key={category} className="rounded-lg border p-3" open={status !== 'PASS' || undefined}>
              <summary className="flex cursor-pointer items-center gap-2 font-medium"><StatusIcon status={status} />{t(`transactionAudit.categories.${category}`)} <span className="text-xs text-muted-foreground">({rows.length})</span>{status === 'NOT_APPLICABLE' && <span className="text-xs text-muted-foreground">{t('transactionAudit.status.NOT_APPLICABLE')}</span>}</summary>
              <div className="mt-3 space-y-2">
                {rows.map((item, index) => <div key={`${item.code}:${item.entityId ?? index}`} className="rounded-md bg-muted/50 p-3 text-sm">
                  <div className="flex items-center gap-2"><StatusIcon status={item.status} /><span className="font-mono text-xs break-all">{item.code}</span></div>
                  {item.status !== 'PASS' && <p className="mt-1 text-sm">{t(`transactionAudit.codes.${item.code}`, { defaultValue: t('transactionAudit.mismatch') })}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{t('transactionAudit.entity')}: {item.entityType}{item.entityId ? ` · ${item.entityId}` : ''}</p>
                  {item.status !== 'PASS' && (item.expected !== undefined || item.actual !== undefined) && <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                    <span className="break-all">{t('transactionAudit.expected')}: {displayValue(item.expected)}</span>
                    <span className="break-all">{t('transactionAudit.actual')}: {displayValue(item.actual)}</span>
                  </div>}
                </div>)}
              </div>
            </details>
          })}
          <AuditModelJsonPanel result={result} />
        </>}
      </AppDialogBody>
      <AppDialogFooter><Button variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>{t('transactionAudit.close')}</Button></AppDialogFooter>
    </AppDialogContent>
  </AppDialog>
}
