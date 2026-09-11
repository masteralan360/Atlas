import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, Ban, BanknoteX, CalendarDays, FileWarning, Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { IQDDisplayPreference, PaymentTransaction } from '@/local-db'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Label,
  Textarea,
} from '@/ui/components'

export type FinancialVoidClassification = 'no_money_moved' | 'money_moved_returned' | 'valid_cancelled'

export interface FinancialTransactionVoidDialogInput {
  reason: string
  cashMovementDeclaration: 'no_money_moved'
}

interface FinancialTransactionVoidDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: FinancialTransactionVoidDialogInput) => Promise<void> | void
  isProcessing?: boolean
  transaction: PaymentTransaction | null
  transactions: PaymentTransaction[]
  sourceLabel: string
  iqdPreference?: IQDDisplayPreference
}

export function FinancialTransactionVoidDialog({
  open,
  onOpenChange,
  onSubmit,
  isProcessing = false,
  transaction,
  transactions,
  sourceLabel,
  iqdPreference = 'IQD',
}: FinancialTransactionVoidDialogProps) {
  const { t } = useTranslation()
  const [classification, setClassification] = useState<FinancialVoidClassification | null>(null)
  const [reason, setReason] = useState('')
  const [isSubmittingLocally, setIsSubmittingLocally] = useState(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setClassification(null)
    setReason('')
    setIsSubmittingLocally(false)
    submittingRef.current = false
  }, [open, transaction?.id])

  const isBusy = isProcessing || isSubmittingLocally
  const affectedMonths = useMemo(
    () => [...new Set(transactions.map((entry) => entry.paidAt.slice(0, 7)))].sort(),
    [transactions],
  )
  const canSubmit = Boolean(
    transaction
    && classification === 'no_money_moved'
    && reason.trim().length >= 10
    && reason.trim().length <= 1000
    && transactions.length > 0,
  )
  const classifications: Array<{
    id: FinancialVoidClassification
    icon: typeof BanknoteX
    title: string
    description: string
  }> = [
    {
      id: 'no_money_moved',
      icon: BanknoteX,
      title: t('financialVoid.classification.noMoneyMoved.title'),
      description: t('financialVoid.classification.noMoneyMoved.description'),
    },
    {
      id: 'money_moved_returned',
      icon: RotateCcw,
      title: t('financialVoid.classification.moneyMoved.title'),
      description: t('financialVoid.classification.moneyMoved.description'),
    },
    {
      id: 'valid_cancelled',
      icon: FileWarning,
      title: t('financialVoid.classification.validCancelled.title'),
      description: t('financialVoid.classification.validCancelled.description'),
    },
  ]

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isBusy) onOpenChange(nextOpen)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit || submittingRef.current) return
    submittingRef.current = true
    setIsSubmittingLocally(true)
    try {
      await onSubmit({
        reason: reason.trim(),
        cashMovementDeclaration: 'no_money_moved',
      })
    } finally {
      submittingRef.current = false
      setIsSubmittingLocally(false)
    }
  }

  return (
    <AppDialog open={open} onOpenChange={handleOpenChange}>
      <AppDialogContent className="max-w-2xl" showCloseButton={!isBusy}>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2">
              <Ban className="h-5 w-5 text-destructive" />
              {t('financialVoid.title')}
            </AppDialogTitle>
            <p className="text-sm text-muted-foreground">{t('financialVoid.description')}</p>
          </AppDialogHeader>

          <AppDialogBody className="space-y-5">
            {transaction ? (
              <section className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-destructive">
                      {t('financialVoid.transactionEnteredInError')}
                    </p>
                    <p className="mt-1 truncate font-semibold">
                      {transaction.referenceLabel || transaction.sourceRecordId}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {sourceLabel} · {t('financialVoid.paymentEntries', { count: transactions.length })}
                    </p>
                  </div>
                  <p className="text-xl font-bold tabular-nums">
                    {formatCurrency(transaction.amount, transaction.currency, iqdPreference)}
                  </p>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {transactions.map((entry) => (
                    <div key={entry.id} className="rounded-lg border bg-background/80 px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">
                          {entry.reversalOfTransactionId
                            ? t('financialVoid.reversalEntry')
                            : t('financialVoid.originalEntry')}
                        </span>
                        <span className="tabular-nums">
                          {formatCurrency(entry.amount, entry.currency, iqdPreference)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                        <CalendarDays className="h-3 w-3" />
                        {formatDateTime(entry.paidAt)}
                      </div>
                    </div>
                  ))}
                </div>
                {affectedMonths.length ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {t('financialVoid.affectedMonths', { months: affectedMonths.join(', ') })}
                  </p>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-2">
              <Label>{t('financialVoid.classificationLabel')} *</Label>
              <div className="grid gap-2" role="radiogroup" aria-label={t('financialVoid.classificationLabel')}>
                {classifications.map((option) => {
                  const Icon = option.icon
                  const selected = classification === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setClassification(option.id)}
                      disabled={isBusy}
                      className={cn(
                        'flex items-start gap-3 rounded-xl border p-3 text-start transition-colors',
                        selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                      )}
                    >
                      <Icon
                        className={cn(
                          'mt-0.5 h-5 w-5 shrink-0',
                          selected ? 'text-primary' : 'text-muted-foreground',
                        )}
                      />
                      <span>
                        <span className="block font-semibold">{option.title}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>

            {classification && classification !== 'no_money_moved' ? (
              <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <p>
                  {classification === 'money_moved_returned'
                    ? t('financialVoid.useReversal')
                    : t('financialVoid.keepReversal')}
                </p>
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="financial-void-reason">{t('financialVoid.reason')} *</Label>
              <Textarea
                id="financial-void-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('financialVoid.reasonPlaceholder')}
                maxLength={1000}
                disabled={isBusy}
                aria-invalid={reason.length > 0 && reason.trim().length < 10}
              />
              <p className="text-xs text-muted-foreground">{t('financialVoid.reasonHint')}</p>
            </div>

            <div className="flex gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <p>{t('financialVoid.auditWarning')}</p>
            </div>
          </AppDialogBody>

          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
              disabled={isBusy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={isBusy || !canSubmit}
            >
              {isBusy
                ? <Loader2 className="me-2 h-4 w-4 animate-spin" />
                : <Ban className="me-2 h-4 w-4" />}
              {isBusy ? t('financialVoid.processing') : t('financialVoid.confirm')}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  )
}
