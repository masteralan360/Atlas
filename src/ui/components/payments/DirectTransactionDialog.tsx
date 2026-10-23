import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleHelp, Loader2, UserRound, Users, X } from 'lucide-react'
import { type CurrencyCode, type DirectTransactionPartnerAccountEffect, type PaymentAccount, type WorkspacePaymentMethod, type RecordDirectTransactionInput } from '@/local-db'
import { fetchDirectCounterparties } from '@/local-db/directTransactionCounterparties'
import { useDirectCounterpartyPage } from '@/local-db/directTransactionHooks'
import { queryClient } from '@/query/queryClient'
import { queryKeys } from '@/query/queryKeys'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { generateId, formatLocalDateTimeValue, formatNumericInput, parseFormattedNumber, parseLocalDateTimeValue, sanitizeNumericInput } from '@/lib/utils'
import { Input } from '@/ui/components/input'
import {
  Button,
  Badge,
  CurrencySelector,
  DateTimePicker,
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
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
  TooltipTrigger,
} from '@/ui/components'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { DirectTransactionCounterpartyPickerDialog } from './DirectTransactionCounterpartyPickerDialog'
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
    onSubmit: (input: RecordDirectTransactionInput) => Promise<void> | void
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
    const formId = useId()
    const initializedWorkspace = useRef<string | null>(null)
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
        type: 'business_partner' | 'agent' | null
        id: string | null
        agentId: string | null
        partnerName: string | null
    }>({ type: null, id: null, agentId: null, partnerName: null })
    const [partnerAccountTreatment, setPartnerAccountTreatment] = useState<PartnerAccountTreatment>('unselected')
    const [partnerAccountEffect, setPartnerAccountEffect] = useState<DirectTransactionPartnerAccountEffect>('none')
    const [isPartyPickerOpen, setIsPartyPickerOpen] = useState(false)
    const submissionLock = useRef(false)
    const [saving, setSaving] = useState(false)
    const [submissionId, setSubmissionId] = useState(generateId)
    const processing = saving || isSubmitting
    const selectedCounterparty = useDirectCounterpartyPage(workspaceId, {
        scope: 'all', selectedPartnerId: linkedPartner.id ?? undefined, page: 1, pageSize: 1,
    }, open && Boolean(linkedPartner.id))
    const resolvedRecord = selectedCounterparty.data?.items[0]
    const selectedRecord = resolvedRecord && (!linkedPartner.agentId || resolvedRecord.agent?.id === linkedPartner.agentId)
        ? resolvedRecord : undefined
    const canLink = selectedCounterparty.scope.ready && (selectedCounterparty.scope.agents || selectedCounterparty.scope.partners)
    const scopeKey = JSON.stringify([selectedCounterparty.scope.key, selectedCounterparty.scope.remote])
    const searchCounterparties = useCallback(async (search: string) => {
        if (!canLink) return []
        const result = await queryClient.fetchQuery({
            queryKey: [...queryKeys.directTransactions.all(workspaceId), 'autocomplete', search, scopeKey],
            queryFn: ({ signal }) => fetchDirectCounterparties(workspaceId, { scope: 'all', search, page: 1, pageSize: 8 }, signal),
        })
        return result.items.map(item => item.partner)
    }, [workspaceId, canLink, scopeKey])

    useEffect(() => () => {
        void queryClient.cancelQueries({ queryKey: [...queryKeys.directTransactions.all(workspaceId), 'autocomplete'] })
    }, [workspaceId, open, scopeKey])

    useEffect(() => {
        if (!open) {
            initializedWorkspace.current = null
            return
        }
        if (initializedWorkspace.current === workspaceId) return
        initializedWorkspace.current = workspaceId

        setDirection('outgoing')
        setAmount('')
        setCurrency((features.default_currency || 'usd') as CurrencyCode)
        setPaymentMethod('cash')
        setPaymentAccount(null)
        setPaidAt(formatLocalDateTimeValue(new Date()))
        setReason('')
        setNote('')
        setCounterpartyName('')
        setLinkedPartner({ type: null, id: null, agentId: null, partnerName: null })
        setPartnerAccountTreatment('unselected')
        setPartnerAccountEffect('none')
        setIsPartyPickerOpen(false)
        setSubmissionId(generateId())
    }, [features.default_currency, open, workspaceId])

    const selectedPaidAt = parseLocalDateTimeValue(paidAt)
    const partnerAccountEffectOptions = PARTNER_ACCOUNT_EFFECT_OPTIONS[direction]
    const selectedPartnerAccountEffect = partnerAccountEffectOptions.find((option) => option.value === partnerAccountEffect)

    const isValid = parseFormattedNumber(amount) > 0 &&
        reason.trim() !== '' &&
        counterpartyName.trim() !== '' &&
        !!selectedPaidAt &&
        (!linkedPartner.id || Boolean(selectedRecord && !selectedCounterparty.isLoading && !selectedCounterparty.error)) &&
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

    const clearPartnerLink = (clearName = true) => {
        if (clearName) setCounterpartyName('')
        setLinkedPartner({ type: null, id: null, agentId: null, partnerName: null })
        setPartnerAccountTreatment('unselected')
        setPartnerAccountEffect('none')
    }

    const selectPartner = (partner: Pick<BusinessPartner, 'id' | 'partnerName' | 'role' | 'agentFacetId'>) => {
        setCounterpartyName(partner.partnerName)
        setLinkedPartner({
            type: partner.role === 'agent' ? 'agent' : 'business_partner',
            id: partner.id,
            agentId: partner.role === 'agent' ? partner.agentFacetId ?? null : null,
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

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        if (submissionLock.current || processing || !isValid) return
        submissionLock.current = true
        setSaving(true)
        try { await onSubmit({
            id: submissionId,
            direction,
            amount: parseFormattedNumber(amount),
            currency,
            paymentMethod,
            paidAt: selectedPaidAt?.toISOString() || '',
            reason: reason.trim(),
            note: note.trim() || undefined,
            counterpartyName: counterpartyName.trim() || undefined,
            businessPartnerId: linkedPartner.id,
            agentId: linkedPartner.agentId,
            partnerAccountEffect: linkedPartner.id && partnerAccountTreatment === 'account_movement'
                ? partnerAccountEffect
                : 'none',
            accountId: paymentAccount?.id ?? null,
            accountNameSnapshot: paymentAccount?.name ?? null
        }) } finally { submissionLock.current = false; setSaving(false) }
    }

    return (
        <AppDialog open={open} onOpenChange={(nextOpen) => {
            if (!processing) {
                onOpenChange(nextOpen)
            }
        }}>
            <AppDialogContent className="max-w-4xl" onPointerDownOutside={(event) => processing && event.preventDefault()} onEscapeKeyDown={(event) => processing && event.preventDefault()} showCloseButton={!processing}>
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
                                    <Label htmlFor={`${formId}-direction`}>{t('directTransactionModal.fields.direction')} <span className="text-destructive">*</span></Label>
                                    <Select value={direction} onValueChange={handleDirectionChange} disabled={processing}>
                                        <SelectTrigger id={`${formId}-direction`}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="outgoing">{t('directTransactionModal.fields.directionOutgoing', { defaultValue: 'Outgoing' })}</SelectItem>
                                            <SelectItem value="incoming">{t('directTransactionModal.fields.directionIncoming', { defaultValue: 'Incoming' })}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="grid gap-2">
                                    <Label htmlFor={`${formId}-method`}>{t('directTransactionModal.fields.paymentMethod')} <span className="text-destructive">*</span></Label>
                                    <PaymentMethodSelector
                                        id={`${formId}-method`}
                                        disabled={processing}
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
                                disabled={processing}
                            />

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label htmlFor={`${formId}-amount`}>{t('directTransactionModal.fields.amount')} <span className="text-destructive">*</span></Label>
                                    <Input
                                        id={`${formId}-amount`}
                                        type="text"
                                        inputMode={currency === 'iqd' ? 'numeric' : 'decimal'}
                                        placeholder="0"
                                        value={formatNumericInput(amount)}
                                        disabled={processing}
                                        onChange={(event) => setAmount(sanitizeNumericInput(event.target.value, {
                                            allowDecimal: currency !== 'iqd'
                                        }))}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label htmlFor={`${formId}-currency`}>{t('products.form.currency')} <span className="text-destructive">*</span></Label>
                                    <CurrencySelector id={`${formId}-currency`} value={currency} onChange={setCurrency} iqdDisplayPreference={features.iqd_display_preference} disabled={processing} />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor={`${formId}-reason`}>{t('directTransactionModal.fields.reason')} <span className="text-destructive">*</span></Label>
                                <Input 
                                    id={`${formId}-reason`}
                                    value={reason} 
                                    disabled={processing}
                                    onChange={(event) => setReason(event.target.value)} 
                                    placeholder={t('directTransactionModal.fields.reasonPlaceholder', { defaultValue: 'Why did this payment happen?' })} 
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor={`${formId}-counterparty`}>{t('directTransactionModal.fields.counterparty')} <span className="text-destructive">*</span></Label>
                                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                                    <PartnerAutocompleteInput
                                        id={`${formId}-counterparty`}
                                        value={counterpartyName}
                                        onChange={(value) => {
                                            setCounterpartyName(value)
                                            if (linkedPartner.id && value !== linkedPartner.partnerName) {
                                                clearPartnerLink(false)
                                            }
                                        }}
                                        onSelectPartner={(partner: BusinessPartner) => {
                                            selectPartner(partner)
                                        }}
                                        workspaceId={workspaceId}
                                        includeAgentRoles={selectedCounterparty.scope.agents}
                                        searchProvider={searchCounterparties}

                                        placeholder={t('directTransactionModal.fields.counterpartyPlaceholder', { defaultValue: 'Who received or paid this amount?' })}
                                        disabled={processing}
                                    />
                                    {canLink ? (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className="w-full shrink-0 gap-2 md:w-auto"
                                            onClick={() => setIsPartyPickerOpen(true)}
                                            disabled={processing}
                                        >
                                            <Users className="h-4 w-4" />
                                            {t('directTransactionModal.counterparties.browse')}
                                        </Button>
                                    ) : null}
                                </div>
                                {linkedPartner.type && linkedPartner.partnerName ? (
                                    <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                                <Badge variant="outline">{t('businessPartners.linked')}</Badge>
                                            </div>
                                            <div className="text-sm font-semibold">
                                                {linkedPartner.type === 'agent' ? <UserRound className="me-1 inline h-4 w-4" /> : <Users className="me-1 inline h-4 w-4" />}
                                                {linkedPartner.type === 'agent' ? t('agents.agent') : t('directTransactions.businessPartnerLink')} · {linkedPartner.partnerName}
                                                {selectedRecord?.agent ? <span className="ms-2 text-xs text-muted-foreground">{selectedRecord.customType?.name || t(`businessPartners.agent.types.${selectedRecord.agent.agentType}`)}</span> : null}
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 shrink-0 px-2 text-muted-foreground"
                                            onClick={() => clearPartnerLink()}
                                            disabled={processing}
                                        >
                                            <X className="h-4 w-4" />
                                            {t('directTransactionModal.counterparties.unlink')}
                                        </Button>
                                    </div>
                                ) : null}
                                {linkedPartner.id && (selectedCounterparty.isLoading || selectedCounterparty.error || !selectedRecord) ? (
                                    <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
                                        {selectedCounterparty.isLoading ? t('common.loading') : selectedCounterparty.error
                                            ? t('common.autocomplete.searchFailed') : t('directTransactionModal.counterparties.unavailable')}
                                        {selectedCounterparty.error ? <Button type="button" variant="link" disabled={processing} onClick={() => void selectedCounterparty.refetch()}>{t('directTransactionModal.counterparties.retry')}</Button> : null}
                                    </p>
                                ) : null}
                                {linkedPartner.id ? (
                                    <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3">
                                        <div className="flex items-center gap-1.5">
                                            <Label>{t('directTransactionModal.partnerAccount.title', { defaultValue: 'Partner account treatment' })} <span className="text-destructive">*</span></Label>
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
                                            disabled={processing}
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
                                                <legend className="text-sm font-medium">{t('directTransactionModal.partnerAccount.movementType', { defaultValue: 'How should it affect the partner account?' })} <span className="text-destructive">*</span></legend>
                                                <SelectionCards
                                                    name="partner-account-effect"
                                                    ariaLabel={t('directTransactionModal.partnerAccount.movementType', { defaultValue: 'How should it affect the partner account?' })}
                                                    value={partnerAccountEffect === 'none' ? null : partnerAccountEffect}
                                                    onValueChange={(value) => setPartnerAccountEffect(value)}
                                                    disabled={processing}
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
                                <Label htmlFor={`${formId}-paid-at`}>{t('directTransactionModal.fields.paidAt')} <span className="text-destructive">*</span></Label>
                                <DateTimePicker
                                    id={`${formId}-paid-at`}
                                    date={selectedPaidAt}
                                    setDate={(value) => setPaidAt(value ? formatLocalDateTimeValue(value) : '')}
                                    placeholder={t('directTransactionModal.fields.paidAtPlaceholder', { defaultValue: 'Pick transaction time' })}
                                    disabled={processing}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor={`${formId}-note`}>{t('directTransactionModal.fields.note')}</Label>
                                <Textarea 
                                    id={`${formId}-note`}
                                    rows={3} 
                                    value={note} 
                                    disabled={processing}
                                    onChange={(event) => setNote(event.target.value)} 
                                    placeholder={t('directTransactionModal.fields.notePlaceholder', { defaultValue: 'Optional note' })} 
                                />
                            </div>
                        </div>
                    </AppDialogBody>

                    <AppDialogFooter>
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={processing}>
                            {t('directTransactionModal.actions.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="submit"
                            className="w-full sm:w-auto"
                            disabled={processing || !isValid}
                        >
                            {processing ? <><Loader2 className="me-2 h-4 w-4 animate-spin" />{t('common.saving')}</> : t('directTransactionModal.actions.save')}
                        </Button>
                    </AppDialogFooter>
                </form>
            </AppDialogContent>

            {canLink && open ? (
                <DirectTransactionCounterpartyPickerDialog
                    key={workspaceId}
                    open={isPartyPickerOpen}
                    onOpenChange={setIsPartyPickerOpen}
                    workspaceId={workspaceId}
                    selectedPartnerId={linkedPartner.id}
                    onSelect={item => selectPartner(item.partner)}
                />
            ) : null}
        </AppDialog>
    )
}
