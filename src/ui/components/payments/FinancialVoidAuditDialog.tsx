import { Ban, CalendarClock, DatabaseZap, FileText, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { FinancialTransactionVoid, PaymentTransaction } from '@/local-db'
import { formatDateTime } from '@/lib/utils'
import {
  Button,
  SmallDialog,
  SmallDialogBody,
  SmallDialogContent,
  SmallDialogDescription,
  SmallDialogFooter,
  SmallDialogHeader,
  SmallDialogTitle,
} from '@/ui/components'

interface FinancialVoidAuditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: FinancialTransactionVoid[]
  getSourceLabel: (row: FinancialTransactionVoid) => string
}

function getTransactionSnapshots(row: FinancialTransactionVoid) {
  return row.transactionSnapshots.filter(
    (value): value is PaymentTransaction => (
      !!value
      && typeof value === 'object'
      && 'id' in value
      && 'paidAt' in value
    ),
  )
}

function getAuditDisplayName(row: FinancialTransactionVoid) {
  const sourceSnapshot = row.sourceSnapshot as {
    expenseSeries?: { name?: unknown }
    expense_series?: { name?: unknown }
    referenceLabel?: unknown
    reference_label?: unknown
  }
  const transaction = getTransactionSnapshots(row)
    .find((entry) => entry.id === row.requestedPaymentTransactionId)
  const value = sourceSnapshot.expenseSeries?.name
    ?? sourceSnapshot.expense_series?.name
    ?? sourceSnapshot.referenceLabel
    ?? sourceSnapshot.reference_label
    ?? transaction?.referenceLabel
  return typeof value === 'string' && value.trim() ? value : row.sourceRecordId
}

export function FinancialVoidAuditDialog({
  open,
  onOpenChange,
  rows,
  getSourceLabel,
}: FinancialVoidAuditDialogProps) {
  const { t } = useTranslation()

  return (
    <SmallDialog open={open} onOpenChange={onOpenChange}>
      <SmallDialogContent className="sm:max-w-3xl">
        <SmallDialogHeader>
          <SmallDialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-destructive" />
            {t('financialVoid.auditTitle')}
          </SmallDialogTitle>
          <SmallDialogDescription>{t('financialVoid.auditDescription')}</SmallDialogDescription>
        </SmallDialogHeader>
        <SmallDialogBody className="space-y-3">
          {rows.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              <Ban className="mx-auto mb-2 h-6 w-6" />
              {t('financialVoid.noAudits')}
            </div>
          ) : rows.map((row) => (
            <article key={row.id} className="rounded-xl border bg-muted/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <p className="truncate font-semibold">{getAuditDisplayName(row)}</p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{getSourceLabel(row)}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {row.rootPaymentTransactionId}
                  </p>
                </div>
                <span className="rounded-full border border-destructive/25 bg-destructive/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-destructive">
                  {t('financialVoid.zeroEffect')}
                </span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm">{row.reason}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <CalendarClock className="h-3.5 w-3.5" />
                  {t('financialVoid.actorAndDate', {
                    actor: row.voidedByNameSnapshot,
                    date: formatDateTime(row.voidedAt),
                  })}
                </span>
                <span>{t('financialVoid.paymentEntries', { count: row.affectedTransactionIds.length })}</span>
                {row.sourceUnavailable ? (
                  <span className="inline-flex items-center gap-1">
                    <DatabaseZap className="h-3.5 w-3.5" />
                    {t('financialVoid.sourceUnavailable')}
                  </span>
                ) : null}
              </div>
            </article>
          ))}
        </SmallDialogBody>
        <SmallDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </SmallDialogFooter>
      </SmallDialogContent>
    </SmallDialog>
  )
}
