import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { getLoanRecordPaymentLabel } from '@/lib/loanPresentation'
import { formatCurrency, formatDate, formatNumberWithCommas, parseFormattedNumber } from '@/lib/utils'
import { recordLoanPayment, type Loan, type LoanInstallment, type LoanPaymentMethod } from '@/local-db'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Label,
    Input,
    Button,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    useToast
} from '@/ui/components'
import { useWorkspace } from '@/workspace'

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
    const [note, setNote] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const paymentBalance = selectedInstallment?.balanceAmount && selectedInstallment.balanceAmount > 0
        ? selectedInstallment.balanceAmount
        : loan?.balanceAmount ?? 0

    useEffect(() => {
        if (!isOpen || !loan) return
        setAmount(formatPaymentAmountInput(String(paymentBalance)))
        setMethod('cash')
        setNote('')
    }, [isOpen, loan, paymentBalance])

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
                createdBy: user?.id
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

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{getLoanRecordPaymentLabel(loan, t)}</DialogTitle>
                </DialogHeader>

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
                                    #{String(selectedInstallment.installmentNo).padStart(2, '0')} - {t('loans.dueDate') || 'Due Date'}: {formatDate(selectedInstallment.dueDate)}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('loans.paymentAmount') || 'Payment Amount'}</Label>
                        <Input
                            type="text"
                            inputMode={loan.settlementCurrency === 'iqd' ? 'numeric' : 'decimal'}
                            value={amount}
                            onChange={e => {
                                const nextValue = sanitizePaymentAmountInput(e.target.value, loan.settlementCurrency)
                                setAmount(formatPaymentAmountInput(nextValue))
                            }}
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('pos.paymentMethod') || 'Payment Method'}</Label>
                        <Select value={method} onValueChange={(value: LoanPaymentMethod) => setMethod(value)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="cash">{t('pos.cash') || 'Cash'}</SelectItem>
                                <SelectItem value="fib">FIB</SelectItem>
                                <SelectItem value="qicard">QiCard</SelectItem>
                                <SelectItem value="zaincash">ZainCash</SelectItem>
                                <SelectItem value="fastpay">FastPay</SelectItem>
                                <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                                <SelectItem value="loan_adjustment">{t('loans.adjustment') || 'Loan Adjustment'}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('loans.notes') || 'Notes'}</Label>
                        <Input value={note} onChange={e => setNote(e.target.value)} />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
                        {t('common.cancel') || 'Cancel'}
                    </Button>
                    <Button onClick={handleSave} disabled={!canSubmit || isSaving}>
                        {t('common.save') || 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
