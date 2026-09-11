import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CalendarClock, CreditCard, Loader2, RotateCcw, WalletCards } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  getPaymentTransactionReversalState,
  usePaymentAccountsState,
  usePaymentTransactions,
  type IQDDisplayPreference,
  type PaymentTransaction,
  type ReversePaymentTransactionInput,
  type WorkspacePaymentMethod,
} from '@/local-db'
import { STANDARD_PAYMENT_METHODS, getPaymentMethodLabel } from '@/lib/paymentMethods'
import {
  formatCurrency,
  formatLocalDateTimeValue,
  formatNumericInput,
  parseFormattedNumber,
  parseLocalDateTimeValue,
  sanitizeNumericInput,
} from '@/lib/utils'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
} from '@/ui/components/dialog'
import { Button } from '@/ui/components/button'
import { DateTimePicker } from '@/ui/components/ui/date-time-picker'
import { Input } from '@/ui/components/input'
import { Label } from '@/ui/components/label'
import { Textarea } from '@/ui/components/textarea'
import { PaymentMethodSelector } from '@/ui/components/PaymentMethodSelector'
import { PaymentAccountSelector } from './PaymentAccountSelector'

export type PaymentReversalDialogInput = Pick<
  ReversePaymentTransactionInput,
  'amount' | 'paidAt' | 'note' | 'paymentMethod' | 'accountId' | 'accountNameSnapshot'
>

interface PaymentReversalDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: PaymentReversalDialogInput) => Promise<void> | void
  isProcessing?: boolean
  transaction: PaymentTransaction | null
  workspaceId?: string
  iqdPreference?: IQDDisplayPreference
}

const PAYMENT_EPSILON = 0.000001

export function PaymentReversalDialog({
  open,
  onOpenChange,
  onSubmit,
  isProcessing = false,
  transaction,
  workspaceId,
  iqdPreference = 'IQD',
}: PaymentReversalDialogProps) {
  const { t } = useTranslation()
  const transactions = usePaymentTransactions(workspaceId, { includeReversals: true }, { hydrateSourceTables: false })
  const { accounts } = usePaymentAccountsState(workspaceId)
  const reversalState = useMemo(
    () => transaction ? getPaymentTransactionReversalState(transaction, transactions) : null,
    [transaction, transactions],
  )
  const [amount, setAmount] = useState('')
  const [paidAt, setPaidAt] = useState('')
  const [note, setNote] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
  const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null)
  const [paymentAccountName, setPaymentAccountName] = useState<string | null>(null)
  const [accountSelectionTouched, setAccountSelectionTouched] = useState(false)
  const [isSubmittingLocally, setIsSubmittingLocally] = useState(false)
  const submittingRef = useRef(false)
  const initializedTransactionRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open || !transaction) {
      initializedTransactionRef.current = null
      return
    }
    if (initializedTransactionRef.current === transaction.id) return

    const state = getPaymentTransactionReversalState(transaction, transactions)
    setAmount(String(state.remainingAmount || ''))
    setPaidAt(formatLocalDateTimeValue(new Date()))
    setNote('')
    setPaymentMethod(transaction.paymentMethod)
    setPaymentAccountId(transaction.accountId ?? null)
    setPaymentAccountName(transaction.accountNameSnapshot ?? null)
    setAccountSelectionTouched(false)
    setIsSubmittingLocally(false)
    submittingRef.current = false
    initializedTransactionRef.current = transaction.id
  }, [open, transaction, transactions])

  const isBusy = isProcessing || isSubmittingLocally

  const selectedPaidAt = parseLocalDateTimeValue(paidAt)
  const parsedAmount = parseFormattedNumber(amount || '0')
  const supportsPartial = reversalState?.amountPolicy === 'partial_or_full'
  const originalAccount = transaction?.accountId
    ? accounts.find((account) => account.id === transaction.accountId) ?? null
    : null
  const originalAccountUnavailable = Boolean(
    transaction?.accountId && (!originalAccount || originalAccount.isDeleted || !originalAccount.isActive),
  )
  const stillUsesUnavailableOriginal = originalAccountUnavailable
    && paymentAccountId === transaction?.accountId
    && !accountSelectionTouched
  const remainingAmount = reversalState?.remainingAmount ?? 0
  const validAmount = parsedAmount > PAYMENT_EPSILON
    && parsedAmount - remainingAmount <= PAYMENT_EPSILON
    && (supportsPartial || Math.abs(parsedAmount - remainingAmount) <= PAYMENT_EPSILON)
  const canSubmit = Boolean(
    transaction
    && reversalState
    && reversalState.status !== 'fully_reversed'
    && selectedPaidAt
    && validAmount
    && !stillUsesUnavailableOriginal,
  )
  const canChangePaymentMethod = STANDARD_PAYMENT_METHODS.includes(
    paymentMethod as (typeof STANDARD_PAYMENT_METHODS)[number],
  )
  const sourceLabel = transaction?.referenceLabel?.trim()
    || transaction?.counterpartyName?.trim()
    || t('paymentReversal.transaction', { defaultValue: 'Payment transaction' })
  const cashEffectLabel = transaction?.direction === 'incoming'
    ? t('paymentReversal.cashReturned', { defaultValue: 'Cash returned' })
    : t('paymentReversal.cashRestored', { defaultValue: 'Cash restored' })

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isBusy) onOpenChange(nextOpen)
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!transaction || !selectedPaidAt || !canSubmit || submittingRef.current) return

    submittingRef.current = true
    setIsSubmittingLocally(true)
    void Promise.resolve()
      .then(() => onSubmit({
        amount: parsedAmount,
        paidAt: selectedPaidAt.toISOString(),
        note: note.trim() || undefined,
        paymentMethod,
        accountId: paymentAccountId,
        accountNameSnapshot: paymentAccountName,
      }))
      .finally(() => {
        submittingRef.current = false
        setIsSubmittingLocally(false)
      })
  }

  return (
    <AppDialog open={open} onOpenChange={handleOpenChange}>
      <AppDialogContent className="max-w-2xl lg:max-w-5xl" showCloseButton={!isBusy}>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-violet-600" />
              {transaction?.direction === 'incoming'
                ? t('paymentReversal.reverseCollection', { defaultValue: 'Reverse Collection' })
                : t('paymentReversal.reversePayment', { defaultValue: 'Reverse Payment' })}
            </AppDialogTitle>
            <p className="text-sm text-muted-foreground">
              {t('paymentReversal.description', { defaultValue: 'Record a linked counter-entry without deleting the original payment.' })}
            </p>
          </AppDialogHeader>

          <AppDialogBody className="space-y-5">
            {transaction && reversalState ? (
              <>
                <section className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                        {t('paymentReversal.originalTransaction', { defaultValue: 'Original transaction' })}
                      </p>
                      <p className="mt-1 truncate font-semibold">{sourceLabel}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{transaction.id}</p>
                    </div>
                    <div className="text-start sm:text-end">
                      <p className="text-xl font-bold tabular-nums">
                        {formatCurrency(reversalState.originalAmount, transaction.currency, iqdPreference)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('paymentReversal.remainingValue', {
                          defaultValue: '{{amount}} remaining',
                          amount: formatCurrency(remainingAmount, transaction.currency, iqdPreference),
                        })}
                      </p>
                    </div>
                  </div>
                  {reversalState.reversedAmount > PAYMENT_EPSILON ? (
                    <div className="mt-3 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-sm">
                      {t('paymentReversal.alreadyReversed', {
                        defaultValue: 'Already reversed: {{amount}}',
                        amount: formatCurrency(reversalState.reversedAmount, transaction.currency, iqdPreference),
                      })}
                    </div>
                  ) : null}
                </section>

                <section className="grid gap-3 rounded-xl border bg-muted/20 p-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                  <div className="flex items-center gap-3">
                    {transaction.direction === 'incoming'
                      ? <ArrowDownLeft className="h-5 w-5 text-emerald-600" />
                      : <ArrowUpRight className="h-5 w-5 text-amber-600" />}
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                        {t('paymentReversal.originalCashEffect', { defaultValue: 'Original cash effect' })}
                      </p>
                      <p className="font-semibold">{transaction.direction === 'incoming'
                        ? t('paymentReversal.cashReceived', { defaultValue: 'Cash received' })
                        : t('paymentReversal.cashPaid', { defaultValue: 'Cash paid' })}</p>
                    </div>
                  </div>
                  <RotateCcw className="mx-auto h-5 w-5 text-violet-600" />
                  <div className="flex items-center gap-3 sm:justify-end">
                    <WalletCards className="h-5 w-5 text-violet-600" />
                    <div className="sm:text-end">
                      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                        {t('paymentReversal.reversalCashEffect', { defaultValue: 'Reversal cash effect' })}
                      </p>
                      <p className="font-semibold text-violet-700 dark:text-violet-300">{cashEffectLabel}</p>
                    </div>
                  </div>
                </section>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="payment-reversal-amount">
                      {t('paymentReversal.amount', { defaultValue: 'Reversal amount' })} *
                    </Label>
                    {supportsPartial ? (
                      <Input
                        id="payment-reversal-amount"
                        type="text"
                        inputMode={transaction.currency === 'iqd' ? 'numeric' : 'decimal'}
                        value={formatNumericInput(amount)}
                        onChange={(event) => setAmount(sanitizeNumericInput(event.target.value, {
                          allowDecimal: transaction.currency !== 'iqd',
                          maxFractionDigits: transaction.currency === 'iqd' ? 0 : 3,
                        }))}
                        placeholder="0"
                        disabled={isBusy}
                        aria-invalid={!validAmount}
                      />
                    ) : (
                      <div className="rounded-xl border bg-background px-3 py-2.5 font-semibold tabular-nums">
                        {formatCurrency(remainingAmount, transaction.currency, iqdPreference)}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {supportsPartial
                        ? t('paymentReversal.partialAllowed', { defaultValue: 'You may reverse part or all of the remaining payment.' })
                        : t('paymentReversal.fullOnly', { defaultValue: 'This source supports full remaining reversal only.' })}
                    </p>
                    {supportsPartial && parsedAmount - remainingAmount > PAYMENT_EPSILON ? (
                      <p className="text-xs font-medium text-destructive">
                        {t('paymentReversal.amountExceedsRemaining', { defaultValue: 'Amount cannot exceed the remaining payment.' })}
                      </p>
                    ) : null}
                  </div>

                  <div className="grid gap-2">
                    <Label>{t('paymentReversal.dateTime', { defaultValue: 'Reversal date and time' })} *</Label>
                    <DateTimePicker
                      id="payment-reversal-paid-at"
                      date={selectedPaidAt}
                      setDate={(value) => setPaidAt(value ? formatLocalDateTimeValue(value) : '')}
                      disabled={isBusy}
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="payment-reversal-method" className="flex items-center gap-2">
                      <CreditCard className="h-4 w-4" />
                      {t('paymentReversal.paymentMethod', { defaultValue: 'Payment method' })} *
                    </Label>
                    {canChangePaymentMethod ? (
                      <PaymentMethodSelector
                        id="payment-reversal-method"
                        value={paymentMethod as (typeof STANDARD_PAYMENT_METHODS)[number]}
                        methods={STANDARD_PAYMENT_METHODS}
                        workspaceId={workspaceId}
                        disabled={isBusy}
                        onValueChange={(value) => setPaymentMethod(value as WorkspacePaymentMethod)}
                        onLinkedPaymentAccountSelect={(account) => {
                          setPaymentAccountId(account.id)
                          setPaymentAccountName(account.name)
                          setAccountSelectionTouched(true)
                        }}
                      />
                    ) : (
                      <div className="rounded-xl border bg-muted/30 px-3 py-2.5 text-sm font-medium">
                        {getPaymentMethodLabel(paymentMethod, t)}
                      </div>
                    )}
                  </div>

                  <PaymentAccountSelector
                    key={transaction.id}
                    workspaceId={workspaceId}
                    value={paymentAccountId}
                    onValueChange={(account) => {
                      setPaymentAccountId(account?.id ?? null)
                      setPaymentAccountName(account?.name ?? null)
                      setAccountSelectionTouched(true)
                    }}
                    disabled={isBusy}
                    cashDrawerOnly={paymentMethod === 'cash'}
                    applyDefault={false}
                    originAccountId={transaction.accountId ?? null}
                    label={t('paymentReversal.paymentAccount', { defaultValue: 'Payment Account (optional)' })}
                  />
                </div>

                {transaction.accountId ? (
                  <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
                    <p className="font-semibold">
                      {t('paymentReversal.originalAccount', {
                        defaultValue: 'Original transaction account: {{account}}',
                        account: transaction.accountNameSnapshot || originalAccount?.name || transaction.accountId,
                      })}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {paymentAccountId === transaction.accountId
                        ? t('paymentReversal.sameAccountEffect', { defaultValue: 'The counter-entry will return the cash effect to the original account.' })
                        : t('paymentReversal.differentAccountEffect', { defaultValue: 'The reversal will affect the newly selected account; the original account movement remains unchanged.' })}
                    </p>
                  </div>
                ) : null}

                {stillUsesUnavailableOriginal ? (
                  <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <p>{t('paymentReversal.unavailableOriginalAccount', { defaultValue: 'The original account is no longer active. Select another account or choose ledger only.' })}</p>
                  </div>
                ) : null}

                <div className="grid gap-2">
                  <Label htmlFor="payment-reversal-note">
                    {t('paymentReversal.reason', { defaultValue: 'Reversal reason' })}
                  </Label>
                  <Textarea
                    id="payment-reversal-note"
                    rows={3}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={t('paymentReversal.reasonPlaceholder', { defaultValue: 'Explain why this payment is being reversed' })}
                    disabled={isBusy}
                  />
                </div>

                <div className="flex gap-3 rounded-xl border border-violet-500/20 bg-violet-500/5 p-3 text-sm">
                  <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
                  <p>{t('paymentReversal.ledgerNotice', { defaultValue: 'The Ledger will keep both entries on their actual dates and link this reversal to the original payment.' })}</p>
                </div>
              </>
            ) : null}
          </AppDialogBody>

          <AppDialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={isBusy || !canSubmit}>
              {isBusy ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <RotateCcw className="me-2 h-4 w-4" />}
              {isBusy
                ? t('paymentReversal.reversing', { defaultValue: 'Reversing…' })
                : t('paymentReversal.confirm', { defaultValue: 'Record Reversal' })}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  )
}
