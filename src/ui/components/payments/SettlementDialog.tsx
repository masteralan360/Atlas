import { useEffect, useMemo, useState } from 'react'

import type { PaymentObligation, WorkspacePaymentMethod } from '@/local-db'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
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

function toLocalDateTimeValue(value: string) {
    const date = new Date(value)
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    return local.toISOString().slice(0, 16)
}

const basePaymentMethods: Array<{ value: WorkspacePaymentMethod; label: string }> = [
    { value: 'cash', label: 'Cash' },
    { value: 'fib', label: 'FIB' },
    { value: 'qicard', label: 'QiCard' },
    { value: 'zaincash', label: 'ZainCash' },
    { value: 'fastpay', label: 'FastPay' },
    { value: 'bank_transfer', label: 'Bank Transfer' }
]

export function SettlementDialog({
    open,
    onOpenChange,
    obligation,
    isSubmitting = false,
    includeLoanAdjustment = false,
    onSubmit
}: SettlementDialogProps) {
    const { features } = useWorkspace()
    const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
    const [paidAt, setPaidAt] = useState('')
    const [note, setNote] = useState('')

    useEffect(() => {
        if (!open) {
            return
        }

        setPaymentMethod('cash')
        setPaidAt(toLocalDateTimeValue(new Date().toISOString()))
        setNote('')
    }, [open, obligation?.id])

    const methods = useMemo(
        () => includeLoanAdjustment
            ? [...basePaymentMethods, { value: 'loan_adjustment' as WorkspacePaymentMethod, label: 'Loan Adjustment' }]
            : basePaymentMethods,
        [includeLoanAdjustment]
    )

    const actionLabel = obligation?.direction === 'incoming' ? 'Record Collection' : 'Record Payment'

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{actionLabel}</DialogTitle>
                    <DialogDescription>
                        {obligation ? `${obligation.referenceLabel || obligation.title} • ${formatDate(obligation.dueDate)}` : 'Post this settlement to the central ledger.'}
                    </DialogDescription>
                </DialogHeader>

                {obligation && (
                    <div className="grid gap-4">
                        <div className="rounded-xl border bg-muted/20 p-4">
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {obligation.direction === 'incoming' ? 'Receivable' : 'Payable'}
                            </div>
                            <div className="mt-1 text-xl font-bold">
                                {formatCurrency(obligation.amount, obligation.currency, features.iqd_display_preference)}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                                {obligation.counterpartyName || obligation.title}
                            </div>
                        </div>

                        <div className="grid gap-2">
                            <Label>Payment Method</Label>
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
                            <Label>Paid At</Label>
                            <Input type="datetime-local" value={paidAt} onChange={(event) => setPaidAt(event.target.value)} />
                        </div>

                        <div className="grid gap-2">
                            <Label>Note</Label>
                            <Textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note" />
                        </div>
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => onSubmit({
                            paymentMethod,
                            paidAt: new Date(paidAt).toISOString(),
                            note: note.trim() || undefined
                        })}
                        disabled={!obligation || !paidAt || isSubmitting}
                    >
                        {actionLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
