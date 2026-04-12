import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PaymentObligation, WorkspacePaymentMethod } from '@/local-db'
import { formatCurrency, formatDate, formatLocalDateTimeValue, parseLocalDateTimeValue } from '@/lib/utils'
import {
    Button,
    DateTimePicker,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea
} from '@/ui/components'
import { useWorkspace } from '@/workspace'

interface SettlementDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    obligation: PaymentObligation | null
    isSubmitting?: boolean
    includeLoanAdjustment?: boolean
    onSubmit: (input: {
        paymentMethod: WorkspacePaymentMethod
        paidAt: string
        note?: string
    }) => Promise<void> | void
}

export function SettlementDialog({
    open,
    onOpenChange,
    obligation,
    isSubmitting = false,
    includeLoanAdjustment = false,
    onSubmit
}: SettlementDialogProps) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
    const [paidAt, setPaidAt] = useState('')
    const [note, setNote] = useState('')

    useEffect(() => {
        if (!open) {
            return
        }

        setPaymentMethod('cash')
        setPaidAt(formatLocalDateTimeValue(new Date()))
        setNote('')
    }, [open, obligation?.id])

    const methods = useMemo(() => {
        const baseMethods: Array<{ value: WorkspacePaymentMethod; label: string }> = [
            { value: 'cash', label: t('directTransactions.paymentMethod.cash', { defaultValue: 'Cash' }) },
            { value: 'fib', label: t('directTransactions.paymentMethod.fib', { defaultValue: 'FIB' }) },
            { value: 'qicard', label: t('directTransactions.paymentMethod.qicard', { defaultValue: 'QiCard' }) },
            { value: 'zaincash', label: t('directTransactions.paymentMethod.zaincash', { defaultValue: 'ZainCash' }) },
            { value: 'fastpay', label: t('directTransactions.paymentMethod.fastpay', { defaultValue: 'FastPay' }) },
            { value: 'bank_transfer', label: t('directTransactions.paymentMethod.bankTransfer', { defaultValue: 'Bank Transfer' }) }
        ]

        if (includeLoanAdjustment) {
            baseMethods.push({ 
                value: 'loan_adjustment' as WorkspacePaymentMethod, 
                label: t('directTransactions.paymentMethod.loanAdjustment', { defaultValue: 'Loan Adjustment' }) 
            })
        }

        return baseMethods
    }, [includeLoanAdjustment, t])

    const selectedPaidAt = parseLocalDateTimeValue(paidAt)

    const actionLabel = obligation?.direction === 'incoming' 
        ? t('settlementModal.recordCollection', { defaultValue: 'Record Collection' }) 
        : t('settlementModal.recordPayment', { defaultValue: 'Record Payment' })

    const directionLabel = obligation?.direction === 'incoming'
        ? t('settlementModal.receivable', { defaultValue: 'Receivable' })
        : t('settlementModal.payable', { defaultValue: 'Payable' })

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{actionLabel}</DialogTitle>
                    <DialogDescription>
                        {obligation 
                            ? `${obligation.referenceLabel || obligation.title} • ${formatDate(obligation.dueDate)}` 
                            : t('settlementModal.postSettlement', { defaultValue: 'Post this settlement to the central ledger.' })}
                    </DialogDescription>
                </DialogHeader>

                {obligation && (
                    <div className="grid gap-4">
                        <div className="rounded-xl border bg-muted/20 p-4">
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {directionLabel}
                            </div>
                            <div className="mt-1 text-xl font-bold">
                                {formatCurrency(obligation.amount, obligation.currency, features.iqd_display_preference)}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                                {obligation.counterpartyName || obligation.title}
                            </div>
                        </div>

                        <div className="grid gap-2">
                            <Label>{t('settlementModal.paymentMethod', { defaultValue: 'Payment Method' })}</Label>
                            <Select value={paymentMethod} onValueChange={(value: WorkspacePaymentMethod) => setPaymentMethod(value)}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {methods.map((method) => (
                                        <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="grid gap-2">
                            <Label>{t('settlementModal.paidAt', { defaultValue: 'Paid At' })}</Label>
                            <DateTimePicker
                                id="settlement-paid-at"
                                date={selectedPaidAt}
                                setDate={(value) => setPaidAt(value ? formatLocalDateTimeValue(value) : '')}
                                placeholder={t('settlementModal.pickPaymentTime', { defaultValue: 'Pick payment time' })}
                            />
                        </div>

                        <div className="grid gap-2">
                            <Label>{t('settlementModal.note', { defaultValue: 'Note' })}</Label>
                            <Textarea 
                                rows={3} 
                                value={note} 
                                onChange={(event) => setNote(event.target.value)} 
                                placeholder={t('settlementModal.optionalNote', { defaultValue: 'Optional note' })} 
                            />
                        </div>
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        {t('settlementModal.cancel', { defaultValue: 'Cancel' })}
                    </Button>
                    <Button
                        onClick={() => onSubmit({
                            paymentMethod,
                            paidAt: selectedPaidAt?.toISOString() || '',
                            note: note.trim() || undefined
                        })}
                        disabled={!obligation || !selectedPaidAt || isSubmitting}
                    >
                        {actionLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
