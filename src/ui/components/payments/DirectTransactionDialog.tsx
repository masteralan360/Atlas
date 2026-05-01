import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, X } from 'lucide-react'
import { type CurrencyCode, type WorkspacePaymentMethod } from '@/local-db'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
import { formatLocalDateTimeValue, formatNumericInput, parseFormattedNumber, parseLocalDateTimeValue, sanitizeNumericInput } from '@/lib/utils'
import {
    Button,
    CurrencySelector,
    DateTimePicker,
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
import { LoanPartyPickerDialog } from '@/ui/components/loans/LoanPartyPickerDialog'

interface DirectTransactionDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    isSubmitting?: boolean
    onSubmit: (input: {
        direction: 'incoming' | 'outgoing'
        amount: number
        currency: CurrencyCode
        paymentMethod: WorkspacePaymentMethod
        paidAt: string
        reason: string
        note?: string
        counterpartyName?: string
        businessPartnerId?: string | null
    }) => Promise<void> | void
}

export function DirectTransactionDialog({
    open,
    onOpenChange,
    workspaceId,
    isSubmitting = false,
    onSubmit
}: DirectTransactionDialogProps) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const [direction, setDirection] = useState<'incoming' | 'outgoing'>('outgoing')
    const [amount, setAmount] = useState('')
    const [currency, setCurrency] = useState<CurrencyCode>((features.default_currency || 'usd') as CurrencyCode)
    const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
    const [paidAt, setPaidAt] = useState('')
    const [reason, setReason] = useState('')
    const [note, setNote] = useState('')
    const [counterpartyName, setCounterpartyName] = useState('')
    const [linkedPartner, setLinkedPartner] = useState<{
        type: 'business_partner' | null
        id: string | null
        name: string | null
    }>({ type: null, id: null, name: null })
    const [isPartyPickerOpen, setIsPartyPickerOpen] = useState(false)

    useEffect(() => {
        if (!open) {
            return
        }

        setDirection('outgoing')
        setAmount('')
        setCurrency((features.default_currency || 'usd') as CurrencyCode)
        setPaymentMethod('cash')
        setPaidAt(formatLocalDateTimeValue(new Date()))
        setReason('')
        setNote('')
        setCounterpartyName('')
        setLinkedPartner({ type: null, id: null, name: null })
        setIsPartyPickerOpen(false)
    }, [features.default_currency, open])

    const selectedPaidAt = parseLocalDateTimeValue(paidAt)

    const isValid = parseFormattedNumber(amount) > 0 &&
        reason.trim() !== '' &&
        counterpartyName.trim() !== '' &&
        !!selectedPaidAt

    const handlePartySelect = (selection: LoanPartySelection) => {
        setLinkedPartner({
            type: selection.linkedPartyType,
            id: selection.linkedPartyId,
            name: selection.linkedPartyName
        })
        setCounterpartyName(selection.borrowerName)
    }

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault()
        void onSubmit({
            direction,
            amount: parseFormattedNumber(amount),
            currency,
            paymentMethod,
            paidAt: selectedPaidAt?.toISOString() || '',
            reason: reason.trim(),
            note: note.trim() || undefined,
            counterpartyName: counterpartyName.trim() || undefined,
            businessPartnerId: linkedPartner.id
        })
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-0.75rem)] w-[calc(100vw-0.75rem)] max-w-4xl flex-col overflow-hidden rounded-[1.25rem] border-border/60 p-0 sm:w-full sm:max-h-[min(calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),820px)] sm:rounded-[1.75rem]">
                <DialogHeader className="border-b bg-muted/30 px-4 py-4 pr-14 text-left sm:px-6 sm:py-5">
                    <DialogTitle>{t('directTransactionModal.title', { defaultValue: 'New Direct Transaction' })}</DialogTitle>
                    <DialogDescription>
                        {t('directTransactionModal.description', { defaultValue: 'Manual incoming or outgoing money for activity outside the tracked system modules. Payroll does not belong here.' })}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
                        <div className="grid gap-4">
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label>{t('directTransactionModal.fields.direction', { defaultValue: 'Direction' })}</Label>
                                    <Select value={direction} onValueChange={(value: 'incoming' | 'outgoing') => setDirection(value)}>
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="outgoing">{t('directTransactionModal.fields.directionOutgoing', { defaultValue: 'Outgoing' })}</SelectItem>
                                            <SelectItem value="incoming">{t('directTransactionModal.fields.directionIncoming', { defaultValue: 'Incoming' })}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="grid gap-2">
                                    <Label>{t('directTransactionModal.fields.paymentMethod', { defaultValue: 'Payment Method' })}</Label>
                                    <Select value={paymentMethod} onValueChange={(value: WorkspacePaymentMethod) => setPaymentMethod(value)}>
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="cash">{t('directTransactions.paymentMethod.cash', { defaultValue: 'Cash' })}</SelectItem>
                                            <SelectItem value="fib">{t('directTransactions.paymentMethod.fib', { defaultValue: 'FIB' })}</SelectItem>
                                            <SelectItem value="qicard">{t('directTransactions.paymentMethod.qicard', { defaultValue: 'QiCard' })}</SelectItem>
                                            <SelectItem value="zaincash">{t('directTransactions.paymentMethod.zaincash', { defaultValue: 'ZainCash' })}</SelectItem>
                                            <SelectItem value="fastpay">{t('directTransactions.paymentMethod.fastpay', { defaultValue: 'FastPay' })}</SelectItem>
                                            <SelectItem value="bank_transfer">{t('directTransactions.paymentMethod.bankTransfer', { defaultValue: 'Bank Transfer' })}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label>{t('directTransactionModal.fields.amount', { defaultValue: 'Amount' })} <span className="text-destructive">*</span></Label>
                                    <Input
                                        type="text"
                                        inputMode={currency === 'iqd' ? 'numeric' : 'decimal'}
                                        placeholder="0"
                                        value={formatNumericInput(amount)}
                                        onChange={(event) => setAmount(sanitizeNumericInput(event.target.value, {
                                            allowDecimal: currency !== 'iqd'
                                        }))}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label>{t('products.form.currency') || 'Currency'}</Label>
                                    <CurrencySelector value={currency} onChange={setCurrency} iqdDisplayPreference={features.iqd_display_preference} />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('directTransactionModal.fields.reason', { defaultValue: 'Reason' })} <span className="text-destructive">*</span></Label>
                                <Input 
                                    value={reason} 
                                    onChange={(event) => setReason(event.target.value)} 
                                    placeholder={t('directTransactionModal.fields.reasonPlaceholder', { defaultValue: 'Why did this payment happen?' })} 
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('directTransactionModal.fields.counterparty', { defaultValue: 'Counterparty' })} <span className="text-destructive">*</span></Label>
                                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                                    <Input
                                        value={counterpartyName}
                                        onChange={(event) => setCounterpartyName(event.target.value)}
                                        placeholder={t('directTransactionModal.fields.counterpartyPlaceholder', { defaultValue: 'Who received or paid this amount?' })}
                                        className="flex-1"
                                    />
                                    {features.crm ? (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className="w-full shrink-0 gap-2 md:w-auto"
                                            onClick={() => setIsPartyPickerOpen(true)}
                                        >
                                            <Users className="h-4 w-4" />
                                            {t('loans.selectParty', { defaultValue: 'Business Partner' })}
                                        </Button>
                                    ) : null}
                                </div>
                                {linkedPartner.type && linkedPartner.name ? (
                                    <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                                {t('loans.belongsTo', { defaultValue: 'Belongs to' })}
                                            </div>
                                            <div className="text-sm font-semibold">
                                                {getLoanLinkedPartyTypeLabel(linkedPartner.type, t)} - {linkedPartner.name}
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 shrink-0 px-2 text-muted-foreground"
                                            onClick={() => setLinkedPartner({ type: null, id: null, name: null })}
                                        >
                                            <X className="h-4 w-4" />
                                            {t('loans.clearParty', { defaultValue: 'Clear Link' })}
                                        </Button>
                                    </div>
                                ) : null}
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('directTransactionModal.fields.paidAt', { defaultValue: 'Paid At' })} <span className="text-destructive">*</span></Label>
                                <DateTimePicker
                                    id="direct-transaction-paid-at"
                                    date={selectedPaidAt}
                                    setDate={(value) => setPaidAt(value ? formatLocalDateTimeValue(value) : '')}
                                    placeholder={t('directTransactionModal.fields.paidAtPlaceholder', { defaultValue: 'Pick transaction time' })}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('directTransactionModal.fields.note', { defaultValue: 'Note' })}</Label>
                                <Textarea 
                                    rows={3} 
                                    value={note} 
                                    onChange={(event) => setNote(event.target.value)} 
                                    placeholder={t('directTransactionModal.fields.notePlaceholder', { defaultValue: 'Optional note' })} 
                                />
                            </div>
                        </div>
                    </div>

                    <DialogFooter className="border-t bg-muted/20 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-between sm:px-6">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                            {t('directTransactionModal.actions.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="submit"
                            className="w-full sm:w-auto"
                            disabled={isSubmitting || !isValid}
                        >
                            {t('directTransactionModal.actions.save', { defaultValue: 'Save Transaction' })}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>

            {features.crm && (
                <LoanPartyPickerDialog
                    isOpen={isPartyPickerOpen}
                    onOpenChange={setIsPartyPickerOpen}
                    workspaceId={workspaceId}
                    selectedPartyId={linkedPartner.id || undefined}
                    onSelect={handlePartySelect}
                />
            )}
        </Dialog>

    )
}
