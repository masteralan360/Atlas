import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleHelp, Users, X } from 'lucide-react'
import { useBusinessPartnersLoading, type CurrencyCode, type DirectTransactionPartnerAccountEffect, type PaymentAccount, type WorkspacePaymentMethod } from '@/local-db'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { formatLocalDateTimeValue, formatNumericInput, parseFormattedNumber, parseLocalDateTimeValue, sanitizeNumericInput } from '@/lib/utils'
import {
    Button,
    CurrencySelector,
    DateTimePicker,
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SelectionCards,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger
} from '@/ui/components'
import { useWorkspace } from '@/workspace'
import { LoanPartyPickerDialog } from '@/ui/components/loans/LoanPartyPickerDialog'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import type { BusinessPartner } from '@/local-db'
import { PaymentMethodSelector } from '@/ui/components/PaymentMethodSelector'
import { PaymentAccountSelector } from './PaymentAccountSelector'

type PartnerAccountTreatment = 'unselected' | 'cash_only' | 'account_movement'
type PartnerAccountEffect = Exclude<DirectTransactionPartnerAccountEffect, 'none'>

interface PartnerAccountEffectOption {
    value: PartnerAccountEffect
    labelKey: string
    descriptionKey: string
}

const PARTNER_ACCOUNT_EFFECT_OPTIONS: Record<'incoming' | 'outgoing', PartnerAccountEffectOption[]> = {
    outgoing: [
        {
            value: 'increase_receivable',
            labelKey: 'increaseReceivable',
            descriptionKey: 'increaseReceivableDescription'
        },
        {
            value: 'decrease_payable',
            labelKey: 'decreasePayable',
            descriptionKey: 'decreasePayableDescription'
        }
    ],
    incoming: [
        {
            value: 'decrease_receivable',
            labelKey: 'decreaseReceivable',
            descriptionKey: 'decreaseReceivableDescription'
        },
        {
            value: 'increase_payable',
            labelKey: 'increasePayable',
            descriptionKey: 'increasePayableDescription'
        }
    ]
}

function isPartnerAccountEffectAvailableForDirection(
    effect: DirectTransactionPartnerAccountEffect,
    direction: 'incoming' | 'outgoing'
) {
    return PARTNER_ACCOUNT_EFFECT_OPTIONS[direction].some((option) => option.value === effect)
}

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
        partnerAccountEffect?: DirectTransactionPartnerAccountEffect
        accountId?: string | null
        accountNameSnapshot?: string | null
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
    const arePartnersLoading = useBusinessPartnersLoading(workspaceId)
    const { features } = useWorkspace()
    const [direction, setDirection] = useState<'incoming' | 'outgoing'>('outgoing')
    const [amount, setAmount] = useState('')
    const [currency, setCurrency] = useState<CurrencyCode>((features.default_currency || 'usd') as CurrencyCode)
    const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [paidAt, setPaidAt] = useState('')
    const [reason, setReason] = useState('')
    const [note, setNote] = useState('')
    const [counterpartyName, setCounterpartyName] = useState('')
    const [linkedPartner, setLinkedPartner] = useState<{
        type: 'business_partner' | null
        id: string | null
        partnerName: string | null
    }>({ type: null, id: null, partnerName: null })
    const [partnerAccountTreatment, setPartnerAccountTreatment] = useState<PartnerAccountTreatment>('unselected')
    const [partnerAccountEffect, setPartnerAccountEffect] = useState<DirectTransactionPartnerAccountEffect>('none')
    const [isPartyPickerOpen, setIsPartyPickerOpen] = useState(false)

    useEffect(() => {
        if (!open) {
            return
        }

        setDirection('outgoing')
        setAmount('')
        setCurrency((features.default_currency || 'usd') as CurrencyCode)
        setPaymentMethod('cash')
        setPaymentAccount(null)
        setPaidAt(formatLocalDateTimeValue(new Date()))
        setReason('')
        setNote('')
        setCounterpartyName('')
        setLinkedPartner({ type: null, id: null, partnerName: null })
        setPartnerAccountTreatment('unselected')
        setPartnerAccountEffect('none')
        setIsPartyPickerOpen(false)
    }, [features.default_currency, open])

    const selectedPaidAt = parseLocalDateTimeValue(paidAt)
    const partnerAccountEffectOptions = PARTNER_ACCOUNT_EFFECT_OPTIONS[direction]
    const selectedPartnerAccountEffect = partnerAccountEffectOptions.find((option) => option.value === partnerAccountEffect)

    const isValid = parseFormattedNumber(amount) > 0 &&
        reason.trim() !== '' &&
        counterpartyName.trim() !== '' &&
        !!selectedPaidAt &&
        (
            !linkedPartner.id ||
            (
                partnerAccountTreatment !== 'unselected'
                && (
                    partnerAccountTreatment === 'cash_only'
                    || partnerAccountEffect !== 'none'
                )
            )
        )

    const clearPartnerLink = () => {
        setLinkedPartner({ type: null, id: null, partnerName: null })
        setPartnerAccountTreatment('unselected')
        setPartnerAccountEffect('none')
    }

    const selectPartner = (partner: Pick<BusinessPartner, 'id' | 'partnerName'>) => {
        setCounterpartyName(partner.partnerName)
        setLinkedPartner({
            type: 'business_partner',
            id: partner.id,
            partnerName: partner.partnerName
        })
        setPartnerAccountTreatment('unselected')
        setPartnerAccountEffect('none')
    }

    const handleDirectionChange = (value: 'incoming' | 'outgoing') => {
        setDirection(value)
        if (!isPartnerAccountEffectAvailableForDirection(partnerAccountEffect, value)) {
            setPartnerAccountEffect('none')
        }
    }

    const handlePartySelect = (selection: LoanPartySelection) => {
        selectPartner({
            id: selection.linkedPartyId,
            partnerName: selection.linkedPartyName
        })
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
            businessPartnerId: linkedPartner.id,
            partnerAccountEffect: linkedPartner.id && partnerAccountTreatment === 'account_movement'
                ? partnerAccountEffect
                : 'none',
            accountId: paymentAccount?.id ?? null,
            accountNameSnapshot: paymentAccount?.name ?? null
        })
    }

    return (
        <AppDialog open={open} onOpenChange={(nextOpen) => {
            if (!isSubmitting) {
                onOpenChange(nextOpen)
            }
        }}>
            <AppDialogContent className="max-w-4xl" onPointerDownOutside={(event) => isSubmitting && event.preventDefault()} onEscapeKeyDown={(event) => isSubmitting && event.preventDefault()} showCloseButton={!isSubmitting}>
                <AppDialogHeader>
                    <AppDialogTitle>{t('directTransactionModal.title', { defaultValue: 'New Direct Transaction' })}</AppDialogTitle>
                    <AppDialogDescription>
                        {t('directTransactionModal.description', { defaultValue: 'Manual incoming or outgoing money for activity outside the tracked system modules. Payroll does not belong here.' })}
                    </AppDialogDescription>
                </AppDialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <AppDialogBody>
                        <div className="grid gap-4">
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label>{t('directTransactionModal.fields.direction', { defaultValue: 'Direction' })}</Label>
                                    <Select value={direction} onValueChange={handleDirectionChange} disabled={isSubmitting}>
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
                                    <PaymentMethodSelector
                                        value={paymentMethod}
                                        onValueChange={(value) => setPaymentMethod(value as WorkspacePaymentMethod)}
                                        onLinkedPaymentAccountSelect={setPaymentAccount}
                                        workspaceId={workspaceId}
                                        methods={STANDARD_PAYMENT_METHODS}
                                    />
                                </div>
                            </div>

                            <PaymentAccountSelector
                                workspaceId={workspaceId}
                                value={paymentAccount?.id}
                                onValueChange={setPaymentAccount}
                                disabled={isSubmitting}
                            />

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label>{t('directTransactionModal.fields.amount', { defaultValue: 'Amount' })} <span className="text-destructive">*</span></Label>
                                    <Input
                                        type="text"
                                        inputMode={currency === 'iqd' ? 'numeric' : 'decimal'}
                                        placeholder="0"
                                        value={formatNumericInput(amount)}
                                        disabled={isSubmitting}
                                        onChange={(event) => setAmount(sanitizeNumericInput(event.target.value, {
                                            allowDecimal: currency !== 'iqd'
                                        }))}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label>{t('products.form.currency') || 'Currency'}</Label>
                                    <CurrencySelector value={currency} onChange={setCurrency} iqdDisplayPreference={features.iqd_display_preference} disabled={isSubmitting} />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('directTransactionModal.fields.reason', { defaultValue: 'Reason' })} <span className="text-destructive">*</span></Label>
                                <Input 
                                    value={reason} 
                                    disabled={isSubmitting}
                                    onChange={(event) => setReason(event.target.value)} 
                                    placeholder={t('directTransactionModal.fields.reasonPlaceholder', { defaultValue: 'Why did this payment happen?' })} 
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label isLoading={arePartnersLoading}>{t('directTransactionModal.fields.counterparty', { defaultValue: 'Counterparty' })} <span className="text-destructive">*</span></Label>
                                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                                    <PartnerAutocompleteInput
                                        value={counterpartyName}
                                        onChange={(value) => {
                                            setCounterpartyName(value)
                                            if (linkedPartner.id && value !== linkedPartner.partnerName) {
                                                clearPartnerLink()
                                            }
                                        }}
                                        onSelectPartner={(partner: BusinessPartner) => {
                                            selectPartner(partner)
                                        }}
                                        workspaceId={workspaceId}
                                        isLoading={arePartnersLoading}
                                        placeholder={t('directTransactionModal.fields.counterpartyPlaceholder', { defaultValue: 'Who received or paid this amount?' })}
                                        disabled={isSubmitting}
                                    />
                                    {features.crm ? (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className="w-full shrink-0 gap-2 md:w-auto"
                                            onClick={() => setIsPartyPickerOpen(true)}
                                            disabled={isSubmitting}
                                        >
                                            <Users className="h-4 w-4" />
                                            {t('loans.selectParty', { defaultValue: 'Business Partner' })}
                                        </Button>
                                    ) : null}
                                </div>
                                {linkedPartner.type && linkedPartner.partnerName ? (
                                    <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                                {t('loans.belongsTo', { defaultValue: 'Belongs to' })}
                                            </div>
                                            <div className="text-sm font-semibold">
                                                {getLoanLinkedPartyTypeLabel(linkedPartner.type, t)} - {linkedPartner.partnerName}
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 shrink-0 px-2 text-muted-foreground"
                                            onClick={clearPartnerLink}
                                            disabled={isSubmitting}
                                        >
                                            <X className="h-4 w-4" />
                                            {t('loans.clearParty', { defaultValue: 'Clear Link' })}
                                        </Button>
                                    </div>
                                ) : null}
                                {linkedPartner.id ? (
                                    <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3">
                                        <div className="flex items-center gap-1.5">
                                            <Label>{t('directTransactionModal.partnerAccount.title', { defaultValue: 'Partner account treatment' })}</Label>
                                            <TooltipProvider delayDuration={150}>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <button
                                                            type="button"
                                                            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                            aria-label={t('directTransactionModal.partnerAccount.tooltip', { defaultValue: 'Cash-only records stay out of the partner statement. Choose an account movement only when this transaction changes what either side owes.' })}
                                                        >
                                                            <CircleHelp className="h-3.5 w-3.5" />
                                                        </button>
                                                    </TooltipTrigger>
                                                    <TooltipContent side="top" align="start" className="max-w-xs text-xs leading-relaxed">
                                                        {t('directTransactionModal.partnerAccount.tooltip', { defaultValue: 'Cash-only records stay out of the partner statement. Choose an account movement only when this transaction changes what either side owes.' })}
                                                    </TooltipContent>
                                                </Tooltip>
                                            </TooltipProvider>
                                        </div>

                                        <SelectionCards
                                            name="partner-account-treatment"
                                            ariaLabel={t('directTransactionModal.partnerAccount.title', { defaultValue: 'Partner account treatment' })}
                                            value={partnerAccountTreatment === 'unselected' ? null : partnerAccountTreatment}
                                            onValueChange={(value) => {
                                                setPartnerAccountTreatment(value)
                                                if (value === 'cash_only') setPartnerAccountEffect('none')
                                            }}
                                            disabled={isSubmitting}
                                            options={[
                                                {
                                                    value: 'cash_only',
                                                    title: t('directTransactionModal.partnerAccount.cashOnly', { defaultValue: 'Cash record only' }),
                                                    description: t('directTransactionModal.partnerAccount.cashOnlyDescription', { defaultValue: 'Keep this in cash flow only; do not change the partner account statement.' })
                                                },
                                                {
                                                    value: 'account_movement',
                                                    title: t('directTransactionModal.partnerAccount.accountMovement', { defaultValue: 'Partner account movement' }),
                                                    description: t('directTransactionModal.partnerAccount.accountMovementDescription', { defaultValue: 'Post this as a debit or credit in the selected partner’s account statement.' })
                                                }
                                            ]}
                                        />

                                        {partnerAccountTreatment === 'unselected' ? (
                                            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                                                {t('directTransactionModal.partnerAccount.selectionRequired', { defaultValue: 'Select one option to continue.' })}
                                            </p>
                                        ) : null}

                                        {partnerAccountTreatment === 'account_movement' ? (
                                            <fieldset className="grid gap-2">
                                                <legend className="text-sm font-medium">{t('directTransactionModal.partnerAccount.movementType', { defaultValue: 'How should it affect the partner account?' })}</legend>
                                                <SelectionCards
                                                    name="partner-account-effect"
                                                    ariaLabel={t('directTransactionModal.partnerAccount.movementType', { defaultValue: 'How should it affect the partner account?' })}
                                                    value={partnerAccountEffect === 'none' ? null : partnerAccountEffect}
                                                    onValueChange={(value) => setPartnerAccountEffect(value)}
                                                    disabled={isSubmitting}
                                                    options={partnerAccountEffectOptions.map((option) => ({
                                                        value: option.value,
                                                        title: t(`directTransactionModal.partnerAccount.${option.labelKey}`),
                                                        description: t(`directTransactionModal.partnerAccount.${option.descriptionKey}`)
                                                    }))}
                                                />
                                                {selectedPartnerAccountEffect ? (
                                                    <p role="status" className="text-xs text-primary">
                                                        {t('directTransactionModal.partnerAccount.effectPreview', {
                                                            defaultValue: 'Account statement: {{effect}}',
                                                            effect: t(`directTransactionModal.partnerAccount.${selectedPartnerAccountEffect.descriptionKey}`)
                                                        })}
                                                    </p>
                                                ) : null}
                                            </fieldset>
                                        ) : null}
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
                                    disabled={isSubmitting}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('directTransactionModal.fields.note', { defaultValue: 'Note' })}</Label>
                                <Textarea 
                                    rows={3} 
                                    value={note} 
                                    disabled={isSubmitting}
                                    onChange={(event) => setNote(event.target.value)} 
                                    placeholder={t('directTransactionModal.fields.notePlaceholder', { defaultValue: 'Optional note' })} 
                                />
                            </div>
                        </div>
                    </AppDialogBody>

                    <AppDialogFooter>
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
                    </AppDialogFooter>
                </form>
            </AppDialogContent>

            {features.crm && (
                <LoanPartyPickerDialog
                    isOpen={isPartyPickerOpen}
                    onOpenChange={setIsPartyPickerOpen}
                    workspaceId={workspaceId}
                    selectedPartyId={linkedPartner.id || undefined}
                    onSelect={handlePartySelect}
                />
            )}
        </AppDialog>

    )
}
