import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import { type BusinessPartner, type PaymentObligation, type WorkspacePaymentMethod, useBusinessPartners } from '@/local-db'
import { formatCurrency, formatDate, formatLocalDateTimeValue, formatNumericInput, parseFormattedNumber, parseLocalDateTimeValue, sanitizeNumericInput } from '@/lib/utils'
import { LOAN_ADJUSTMENT_PAYMENT_METHOD, STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import {
    Button,
    DateTimePicker,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Textarea
} from '@/ui/components'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { useWorkspace } from '@/workspace'
import { PaymentMethodSelector } from '@/ui/components/PaymentMethodSelector'
import { PaymentAccountSelector } from './PaymentAccountSelector'

interface SettlementDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    obligation: PaymentObligation | null
    initialPaidAt?: string
    initialPaymentAccountId?: string | null
    initialPaymentAccountNameSnapshot?: string | null
    isSubmitting?: boolean
    includeLoanAdjustment?: boolean
    onSubmit: (input: {
        paymentMethod: WorkspacePaymentMethod
        paidAt: string
        amount?: number
        note?: string
        counterpartyName?: string
        businessPartnerId?: string | null
        accountId?: string | null
        accountNameSnapshot?: string | null
    }) => Promise<void> | void
}

function getMetadataString(metadata: Record<string, unknown> | null | undefined, key: string) {
    const value = metadata?.[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function SettlementDialog({
    open,
    onOpenChange,
    obligation,
    initialPaidAt,
    initialPaymentAccountId = null,
    initialPaymentAccountNameSnapshot = null,
    isSubmitting = false,
    includeLoanAdjustment = false,
    onSubmit
}: SettlementDialogProps) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
    const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null)
    const [paymentAccountNameSnapshot, setPaymentAccountNameSnapshot] = useState<string | null>(null)
    const [paidAt, setPaidAt] = useState('')
    const [amount, setAmount] = useState('')
    const [note, setNote] = useState('')
    const [counterpartyName, setCounterpartyName] = useState('')
    const [linkedCounterparty, setLinkedCounterparty] = useState<{ id: string; name: string } | null>(null)
    const showsCounterpartyPicker = obligation?.sourceType === 'real_estate_commission'
    const showsAmountInput = obligation?.sourceType === 'real_estate_commission'
        || obligation?.sourceType === 'sales_order'
        || obligation?.sourceType === 'purchase_order'
        || obligation?.sourceType === 'clinical_appointment'
        || obligation?.sourceType === 'agent_commission_payout'
        || obligation?.sourceType === 'agent_commission_recovery'
    const businessPartners = useBusinessPartners(showsCounterpartyPicker ? obligation?.workspaceId : undefined, { includeRealEstateRoles: true }) || []

    const businessPartnerById = useMemo(() => new Map(businessPartners.map((partner) => [partner.id, partner])), [businessPartners])
    const defaultBusinessPartnerId = getMetadataString(obligation?.metadata, 'businessPartnerId')
    const defaultBusinessPartner = defaultBusinessPartnerId ? businessPartnerById.get(defaultBusinessPartnerId) : undefined
    const defaultCounterpartyName = defaultBusinessPartner?.partnerName || obligation?.counterpartyName || obligation?.title || ''
    useEffect(() => {
        if (!open) {
            return
        }

        setPaymentMethod('cash')
        setPaymentAccountId(initialPaymentAccountId)
        setPaymentAccountNameSnapshot(initialPaymentAccountNameSnapshot)
        setPaidAt(initialPaidAt || formatLocalDateTimeValue(new Date()))
        setAmount(String(obligation?.amount || ''))
        setNote('')
        setCounterpartyName(defaultCounterpartyName)
        setLinkedCounterparty(defaultBusinessPartnerId
            ? {
                id: defaultBusinessPartnerId,
                name: defaultCounterpartyName
            }
            : null)
    }, [defaultBusinessPartnerId, defaultCounterpartyName, initialPaidAt, initialPaymentAccountId, initialPaymentAccountNameSnapshot, open, obligation?.amount, obligation?.id])

    const selectedPaidAt = parseLocalDateTimeValue(paidAt)

    const actionLabel = obligation?.direction === 'incoming' 
        ? t('settlementModal.recordCollection', { defaultValue: 'Record Collection' }) 
        : t('settlementModal.recordPayment', { defaultValue: 'Record Payment' })

    const directionLabel = obligation?.direction === 'incoming'
        ? t('settlementModal.receivable', { defaultValue: 'Receivable' })
        : t('settlementModal.payable', { defaultValue: 'Payable' })

    const requiresLinkedCounterparty = showsCounterpartyPicker
    const allowsOverpayment = obligation?.sourceType === 'clinical_appointment'
    const parsedAmount = parseFormattedNumber(amount || '0')
    const hasEditedAmount = !!obligation
        && showsAmountInput
        && amount.trim() !== ''
        && parsedAmount !== obligation.amount
    const hasValidAmount = !showsAmountInput
        || (!!obligation && parsedAmount > 0 && (allowsOverpayment || parsedAmount <= obligation.amount))
    const canSubmit = !!obligation
        && !!selectedPaidAt
        && hasValidAmount
        && (!requiresLinkedCounterparty || !!linkedCounterparty?.id)

    const handleCounterpartySelect = (partner: BusinessPartner) => {
        setCounterpartyName(partner.partnerName)
        setLinkedCounterparty({ id: partner.id, name: partner.partnerName })
    }

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault()
        if (!obligation || !selectedPaidAt || !canSubmit || isSubmitting) return
        void onSubmit({
            paymentMethod,
            paidAt: selectedPaidAt?.toISOString() || '',
            amount: showsAmountInput ? parsedAmount : undefined,
            note: note.trim() || undefined,
            counterpartyName: counterpartyName.trim() || undefined,
            businessPartnerId: linkedCounterparty?.id || null,
            accountId: paymentAccountId,
            accountNameSnapshot: paymentAccountNameSnapshot
        })
    }

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => {
            if (!isSubmitting) onOpenChange(nextOpen)
        }}>
            <DialogContent
                layout="structured"
                className="max-w-3xl"
                showCloseButton={!isSubmitting}
                onPointerDownOutside={(event) => {
                    if (isSubmitting) event.preventDefault()
                }}
                onInteractOutside={(event) => {
                    if (isSubmitting) event.preventDefault()
                }}
                onEscapeKeyDown={(event) => {
                    if (isSubmitting) event.preventDefault()
                }}
                onOpenAutoFocus={(e) => {
                    if (showsCounterpartyPicker) {
                        e.preventDefault()
                    }
                }}
            >
                <DialogHeader layout="structured">
                    <DialogTitle>{actionLabel}</DialogTitle>
                    <DialogDescription>
                        {obligation 
                            ? `${obligation.referenceLabel || obligation.title} • ${obligation.dueDate ? formatDate(obligation.dueDate) : '-'}`
                            : t('settlementModal.postSettlement', { defaultValue: 'Post this settlement to the central ledger.' })}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <DialogBody>
                        {obligation && (
                            <div className="grid gap-4">
                                <div className="rounded-xl border bg-muted/20 p-4">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {directionLabel}
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-baseline gap-2">
                                        <span className="text-xl font-bold">
                                            {formatCurrency(hasEditedAmount ? parsedAmount : obligation.amount, obligation.currency, features.iqd_display_preference)}
                                        </span>
                                        {hasEditedAmount ? (
                                            <span className="text-sm font-semibold text-muted-foreground line-through decoration-2">
                                                {formatCurrency(obligation.amount, obligation.currency, features.iqd_display_preference)}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="mt-1 text-sm text-muted-foreground">
                                        {counterpartyName || obligation.counterpartyName || obligation.title}
                                    </div>
                                </div>

                                {showsAmountInput ? (
                                    <div className="grid gap-2">
                                        <Label>{t('payments.table.amount', { defaultValue: 'Amount' })}</Label>
                                        <Input
                                            type="text"
                                            inputMode="decimal"
                                            value={formatNumericInput(amount)}
                                            onChange={(event) => setAmount(sanitizeNumericInput(event.target.value, {
                                                allowDecimal: true,
                                                maxFractionDigits: obligation?.sourceType === 'sales_order' || obligation?.sourceType === 'purchase_order' ? 3 : 2
                                            }))}
                                            disabled={isSubmitting}
                                        />
                                        {parsedAmount > obligation.amount && !allowsOverpayment ? (
                                            <p className="text-xs text-destructive">
                                                {t('settlementModal.amountExceedsBalance', { defaultValue: 'Amount cannot exceed the remaining balance.' })}
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}

                                {showsCounterpartyPicker ? (
                                    <div className="grid gap-2">
                                        <Label>
                                            {t('payments.table.counterparty', { defaultValue: 'Counterparty' })}
                                            {requiresLinkedCounterparty ? <span className="text-destructive"> *</span> : null}
                                        </Label>
                                        <PartnerAutocompleteInput
                                            value={counterpartyName}
                                            onChange={(value) => {
                                                setCounterpartyName(value)
                                                setLinkedCounterparty(null)
                                            }}
                                            onSelectPartner={handleCounterpartySelect}
                                            workspaceId={obligation.workspaceId}
                                            placeholder={t('settlementModal.counterpartyPlaceholder', { defaultValue: 'Search business partner' })}
                                            disabled={isSubmitting}
                                            includeRealEstateRoles
                                        />
                                        {linkedCounterparty ? (
                                            <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                                                <div className="min-w-0">
                                                    <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                                        {t('businessPartners.title', { defaultValue: 'Business Partners' })}
                                                    </div>
                                                    <div className="truncate text-sm font-semibold">{linkedCounterparty.name}</div>
                                                </div>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 shrink-0 px-2 text-muted-foreground"
                                                    onClick={() => setLinkedCounterparty(null)}
                                                    disabled={isSubmitting}
                                                >
                                                    <X className="h-4 w-4" />
                                                    {t('loans.clearParty', { defaultValue: 'Clear Link' })}
                                                </Button>
                                            </div>
                                        ) : requiresLinkedCounterparty ? (
                                            <p className="text-xs text-destructive">
                                                {t('settlementModal.businessPartnerRequired', { defaultValue: 'Select a linked business partner for this commission.' })}
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}

                                <div className="grid gap-2">
                                    <Label>{t('settlementModal.paymentMethod', { defaultValue: 'Payment Method' })}</Label>
                                    <PaymentMethodSelector
                                        value={paymentMethod}
                                        onValueChange={(value) => setPaymentMethod(value as WorkspacePaymentMethod)}
                                        onLinkedPaymentAccountSelect={(account) => {
                                            setPaymentAccountId(account.id)
                                            setPaymentAccountNameSnapshot(account.name)
                                        }}
                                        workspaceId={obligation.workspaceId}
                                        methods={includeLoanAdjustment
                                            ? [...STANDARD_PAYMENT_METHODS, LOAN_ADJUSTMENT_PAYMENT_METHOD]
                                            : STANDARD_PAYMENT_METHODS}
                                    />
                                </div>

                                <PaymentAccountSelector
                                    workspaceId={obligation.workspaceId}
                                    value={paymentAccountId}
                                    onValueChange={(account) => {
                                        setPaymentAccountId(account?.id ?? null)
                                        setPaymentAccountNameSnapshot(account?.name ?? null)
                                    }}
                                    disabled={isSubmitting}
                                />

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
                    </DialogBody>

                    <DialogFooter layout="structured">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                            {t('settlementModal.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="submit"
                            className="w-full sm:w-auto"
                            disabled={!canSubmit || isSubmitting}
                        >
                            {actionLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>

    )
}
