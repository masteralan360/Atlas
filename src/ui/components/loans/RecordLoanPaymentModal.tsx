import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { getLoanRecordPaymentLabel } from '@/lib/loanPresentation'
import { LOAN_ADJUSTMENT_PAYMENT_METHOD, STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { formatCurrency, formatDate, formatNumberWithCommas, parseFormattedNumber } from '@/lib/utils'
import { recordLoanPayment, type Loan, type LoanInstallment, type LoanPaymentMethod, type PaymentAccount } from '@/local-db'
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Label,
    Input,
    Button,
    useToast
} from '@/ui/components'
import { DateTimePicker } from '@/ui/components/ui/date-time-picker'
import { useWorkspace } from '@/workspace'
import { PaymentMethodSelector } from '@/ui/components/PaymentMethodSelector'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'

interface RecordLoanPaymentModalProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    loan: Loan | null
    selectedInstallment?: LoanInstallment | null
    onSaved?: () => void
}

function sanitizePaymentAmountInput(value: string, currency: Loan['settlementCurrency']): string {
    const normalized = value.replace(/,/g, '').replace(/[^\d.]/g, '')
    if (!normalized) {
        return ''
    }

    const [rawWhole = '', ...rawFractionParts] = normalized.split('.')
    const hasDecimal = normalized.includes('.')
    const whole = rawWhole === '' ? '' : String(Number(rawWhole))

    if (currency === 'iqd') {
        return rawWhole === '' ? '' : whole
    }

    const fraction = rawFractionParts.join('').slice(0, 2)
    if (!hasDecimal) {
        return rawWhole === '' ? '' : whole
    }

    return `${whole || '0'}.${fraction}`
}

function formatPaymentAmountInput(value: string): string {
    if (!value) {
        return ''
    }

    const hasDecimal = value.includes('.')
    const [whole = '', fraction = ''] = value.split('.')
    const formattedWhole = whole ? formatNumberWithCommas(whole) : '0'

    if (!hasDecimal) {
        return formattedWhole
    }

    return `${formattedWhole}.${fraction}`
}

export function RecordLoanPaymentModal({
    isOpen,
    onOpenChange,
    workspaceId,
    loan,
    selectedInstallment,
    onSaved
}: RecordLoanPaymentModalProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const [amount, setAmount] = useState('')
    const [method, setMethod] = useState<LoanPaymentMethod>('cash')
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [note, setNote] = useState('')
    const [paymentDate, setPaymentDate] = useState<Date | undefined>(undefined)
    const [isSaving, setIsSaving] = useState(false)
    const paymentBalance = selectedInstallment?.balanceAmount && selectedInstallment.balanceAmount > 0
        ? selectedInstallment.balanceAmount
        : loan?.balanceAmount ?? 0
    const loanId = loan?.id ?? null
    const installmentId = selectedInstallment?.id ?? null
    const initializedTargetRef = useRef<string | null>(null)
    const amountEditedRef = useRef(false)

    useEffect(() => {
        if (!isOpen || !loanId) {
            initializedTargetRef.current = null
            return
        }

        const targetKey = `${loanId}:${installmentId ?? 'loan'}`
        const targetChanged = initializedTargetRef.current !== targetKey
        if (targetChanged) {
            initializedTargetRef.current = targetKey
            amountEditedRef.current = false
            setMethod('cash')
            setPaymentAccount(null)
            setNote('')
            setPaymentDate(new Date())
        }
        if (targetChanged || !amountEditedRef.current) {
            setAmount(formatPaymentAmountInput(String(paymentBalance)))
        }
    }, [installmentId, isOpen, loanId, paymentBalance])

    if (!loan) return null

    const numericAmount = parseFormattedNumber(amount || '0')
    const canSubmit = numericAmount > 0 && numericAmount <= paymentBalance

    const handleSave = async () => {
        if (!canSubmit || isSaving) return
        setIsSaving(true)
        try {
            await recordLoanPayment(workspaceId, {
                loanId: loan.id,
                installmentId: selectedInstallment?.id || undefined,
                amount: numericAmount,
                paymentMethod: method,
                note: note.trim() || undefined,
                paidAt: paymentDate ? paymentDate.toISOString() : undefined,
                createdBy: user?.id,
                accountId: paymentAccount?.id ?? null,
                accountNameSnapshot: paymentAccount?.name ?? null,
            })

            toast({
                title: t('messages.success') || 'Success',
                description: t('loans.messages.paymentRecorded') || 'Payment recorded'
            })
            onOpenChange(false)
            onSaved?.()
        } catch (error: any) {
            toast({
                variant: 'destructive',
                title: t('messages.error') || 'Error',
                description: error?.message || (t('loans.messages.paymentRecordFailed') || 'Failed to record payment')
            })
        } finally {
            setIsSaving(false)
        }
    }

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        void handleSave()
    }

    return (
        <Dialog open={isOpen} onOpenChange={(nextOpen) => {
            if (!isSaving) onOpenChange(nextOpen)
        }}>
            <DialogContent
                layout="structured"
                className="max-w-3xl"
                showCloseButton={!isSaving}
                onPointerDownOutside={(event) => isSaving && event.preventDefault()}
                onInteractOutside={(event) => isSaving && event.preventDefault()}
                onEscapeKeyDown={(event) => isSaving && event.preventDefault()}
            >
                <DialogHeader layout="structured">
                    <DialogTitle>{getLoanRecordPaymentLabel(loan, t)}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <DialogBody>
                        <div className="grid gap-4">
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div className="rounded-xl border bg-muted/20 p-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {t('loans.totalPrincipal') || 'Total Principal'}
                                    </div>
                                    <div className="mt-1 text-lg font-bold text-foreground">
                                        {formatCurrency(loan.principalAmount, loan.settlementCurrency, features.iqd_display_preference)}
                                    </div>
                                </div>

                                <div className="rounded-xl border bg-muted/20 p-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {t('loans.balance') || 'Balance'}
                                    </div>
                                    <div className="mt-1 text-lg font-bold text-foreground">
                                        {formatCurrency(paymentBalance, loan.settlementCurrency, features.iqd_display_preference)}
                                    </div>
                                    {selectedInstallment && (
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            #{String(selectedInstallment.installmentNo).padStart(2, '0')} - {t('loans.dueDate') || 'Due Date'}: {selectedInstallment.dueDate ? formatDate(selectedInstallment.dueDate) : '-'}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="loan-payment-amount">{t('loans.paymentAmount') || 'Payment Amount'}</Label>
                                <Input
                                    id="loan-payment-amount"
                                    type="text"
                                    inputMode={loan.settlementCurrency === 'iqd' ? 'numeric' : 'decimal'}
                                    value={amount}
                                    onChange={e => {
                                        amountEditedRef.current = true
                                        const nextValue = sanitizePaymentAmountInput(e.target.value, loan.settlementCurrency)
                                        setAmount(formatPaymentAmountInput(nextValue))
                                    }}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('pos.paymentMethod') || 'Payment Method'}</Label>
                                <PaymentMethodSelector
                                    value={method}
                                    onValueChange={(value) => setMethod(value as LoanPaymentMethod)}
                                    onLinkedPaymentAccountSelect={setPaymentAccount}
                                    workspaceId={workspaceId}
                                    methods={[...STANDARD_PAYMENT_METHODS, LOAN_ADJUSTMENT_PAYMENT_METHOD]}
                                />
                            </div>

                            <PaymentAccountSelector
                                workspaceId={workspaceId}
                                value={paymentAccount?.id}
                                onValueChange={setPaymentAccount}
                                disabled={isSaving}
                            />

                            <div className="grid gap-2">
                                <Label>{t('loans.paymentDate') || 'Payment Date'}</Label>
                                <DateTimePicker
                                    date={paymentDate}
                                    setDate={setPaymentDate}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('loans.notes') || 'Notes'}</Label>
                                <Input value={note} onChange={e => setNote(e.target.value)} />
                            </div>
                        </div>
                    </DialogBody>

                    <DialogFooter layout="structured">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={isSaving}>
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button type="submit" className="w-full sm:w-auto" disabled={!canSubmit || isSaving}>
                            {t('common.save') || 'Save'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>

    )
}
