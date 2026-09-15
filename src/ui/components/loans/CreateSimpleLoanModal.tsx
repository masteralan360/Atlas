import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownLeft, ArrowUpRight, Users, X } from 'lucide-react'

import { useAuth } from '@/auth'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { createManualLoan, useBusinessPartnersLoading, type CurrencyCode, type LoanDirection, type PaymentAccount } from '@/local-db'
import { buildOrderExchangeRatesSnapshot } from '@/lib/orderCurrency'
import { getLoanCounterpartyNameLabel, getLoanDirectionLabel } from '@/lib/loanPresentation'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
import { formatLocalDateTimeValue, formatLocalDateValue, formatNumericInput, parseFormattedNumber, parseLocalDateTimeValue, parseLocalDateValue, sanitizeNumericInput } from '@/lib/utils'
import {
    Button,
    CurrencySelector,
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
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    useToast
} from '@/ui/components'
import { useWorkspace } from '@/workspace'
import { LoanPartyPickerDialog } from './LoanPartyPickerDialog'
import { SaveBorrowerAsPartnerDialog, usePendingSavePartnerPrompt } from './SaveBorrowerAsPartnerDialog'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import type { BusinessPartner } from '@/local-db'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'

interface CreateSimpleLoanModalProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    settlementCurrency: CurrencyCode
    onCreated?: (loanId: string) => void
}

export function CreateSimpleLoanModal({
    isOpen,
    onOpenChange,
    workspaceId,
    settlementCurrency,
    onCreated
}: CreateSimpleLoanModalProps) {
    const { t } = useTranslation()
    const arePartnersLoading = useBusinessPartnersLoading(workspaceId)
    const { toast } = useToast()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const [isSaving, setIsSaving] = useState(false)
    const [direction, setDirection] = useState<LoanDirection>('lent')
    const [selectedCurrency, setSelectedCurrency] = useState<CurrencyCode>(settlementCurrency)
    const [borrowerName, setBorrowerName] = useState('')
    const [borrowerPhone, setBorrowerPhone] = useState('')
    const [borrowerAddress, setBorrowerAddress] = useState('')
    const [selectedParty, setSelectedParty] = useState<LoanPartySelection | null>(null)
    const [isPartyPickerOpen, setIsPartyPickerOpen] = useState(false)
    const [principalAmount, setPrincipalAmount] = useState('')
    const [createdAt, setCreatedAt] = useState('')
    const [dueDate, setDueDate] = useState<string | null>(null)
    const [notes, setNotes] = useState('')
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [savePartnerData, setSavePartnerData] = usePendingSavePartnerPrompt()

    useEffect(() => {
        if (!isOpen) return

        setIsSaving(false)
        setDirection('lent')
        setSelectedCurrency(settlementCurrency)
        setBorrowerName('')
        setBorrowerPhone('')
        setBorrowerAddress('')
        setSelectedParty(null)
        setIsPartyPickerOpen(false)
        setPrincipalAmount('')
        setCreatedAt(formatLocalDateTimeValue(new Date()))
        setDueDate(null)
        setNotes('')
        setPaymentAccount(null)
    }, [isOpen, settlementCurrency])

    useEffect(() => {
        setPrincipalAmount((current) => sanitizeNumericInput(current, {
            allowDecimal: selectedCurrency !== 'iqd'
        }))
    }, [selectedCurrency])

    const selectedCreatedAt = parseLocalDateTimeValue(createdAt)
    const canSubmit = borrowerName.trim()
        && parseFormattedNumber(principalAmount || '0') > 0
        && !!selectedCreatedAt

    const counterpartyNameLabel = useMemo(
        () => getLoanCounterpartyNameLabel({ loanCategory: 'simple', direction }, t),
        [direction, t]
    )
    const exchangeRateSnapshot = useMemo(() => {
        const snapshot = buildOrderExchangeRatesSnapshot({
            exchangeData,
            eurRates,
            tryRates
        })
        return snapshot.length > 0 ? snapshot : null
    }, [exchangeData, eurRates, tryRates])

    const handlePartySelect = (selection: LoanPartySelection) => {
        setSelectedParty(selection)
        setSelectedCurrency(selection.defaultCurrency)
        setBorrowerName(selection.borrowerName)
        setBorrowerPhone(selection.borrowerPhone)
        setBorrowerAddress(selection.borrowerAddress)
    }

    const handleCreate = async () => {
        if (!canSubmit || !selectedCreatedAt || isSaving) return

        setIsSaving(true)
        try {
            const result = await createManualLoan(workspaceId, {
                saleId: null,
                loanCategory: 'simple',
                direction,
                linkedPartyType: selectedParty?.linkedPartyType || null,
                linkedPartyId: selectedParty?.linkedPartyId || null,
                linkedPartyName: selectedParty?.linkedPartyName || null,
                borrowerName: borrowerName.trim(),
                borrowerPhone: borrowerPhone.trim(),
                borrowerAddress: borrowerAddress.trim(),
                borrowerNationalId: '',
                principalAmount: parseFormattedNumber(principalAmount || '0'),
                settlementCurrency: selectedCurrency,
                exchangeRateSnapshot,
                installmentCount: 1,
                installmentFrequency: 'monthly',
                firstDueDate: dueDate,
                createdAt: selectedCreatedAt.toISOString(),
                notes: notes.trim() || undefined,
                createdBy: user?.id,
                accountId: paymentAccount?.id ?? null,
                accountNameSnapshot: paymentAccount?.name ?? null
            })

            toast({
                title: t('messages.success') || 'Success',
                description: t('loans.messages.loanCreated') || 'Loan created successfully'
            })

            if (!selectedParty && borrowerName.trim()) {
                setSavePartnerData({
                    loanId: result.loan.id,
                    borrowerName: borrowerName.trim(),
                    borrowerPhone: borrowerPhone.trim(),
                    borrowerAddress: borrowerAddress.trim(),
                    settlementCurrency: selectedCurrency
                })
            } else {
                onOpenChange(false)
                onCreated?.(result.loan.id)
            }
        } catch (error: any) {
            toast({
                variant: 'destructive',
                title: t('messages.error') || 'Error',
                description: error?.message || (t('loans.messages.loanCreateFailed') || 'Failed to create loan')
            })
        } finally {
            setIsSaving(false)
        }
    }

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        void handleCreate()
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => {
            if (!isSaving) onOpenChange(open)
        }}>
            <DialogContent layout="structured" className="max-w-3xl">
                <DialogHeader layout="structured">
                    <DialogTitle>{t('loans.createSimpleLoan', { defaultValue: 'Create Simple Loan' })}</DialogTitle>
                    <DialogDescription>
                        {t('loans.simpleLoanDescription', { defaultValue: 'Add a manual lending or borrowing entry and optionally link it to a business partner.' })}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <DialogBody className="py-5">
                        <div className="grid gap-5">

                            <div className="grid gap-2">
                                <Label isLoading={arePartnersLoading}>{counterpartyNameLabel} <span className="text-destructive">*</span></Label>
                                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                                    <PartnerAutocompleteInput
                                        value={borrowerName}
                                        onChange={setBorrowerName}
                                        onSelectPartner={(partner: BusinessPartner) => {
                                            setSelectedParty({
                                                linkedPartyType: 'business_partner',
                                                linkedPartyId: partner.id,
                                                linkedPartyName: partner.partnerName,
                                                borrowerName: partner.partnerName,
                                                borrowerPhone: partner.phone || '',
                                                borrowerAddress: [partner.address, partner.city].filter(Boolean).join(', '),
                                                defaultCurrency: partner.defaultCurrency
                                            })
                                            setSelectedCurrency(partner.defaultCurrency)
                                            setBorrowerName(partner.partnerName)
                                            setBorrowerPhone(partner.phone || '')
                                            setBorrowerAddress([partner.address, partner.city].filter(Boolean).join(', '))
                                        }}
                                        workspaceId={workspaceId}
                                        isLoading={arePartnersLoading}
                                    />
                                    <Button type="button" variant="outline" className="w-full shrink-0 gap-2 md:w-auto" onClick={() => setIsPartyPickerOpen(true)}>
                                        <Users className="h-4 w-4" />
                                        {t('loans.selectParty', { defaultValue: 'Business Partner' })}
                                    </Button>
                                </div>
                                {selectedParty ? (
                                    <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                                {t('loans.belongsTo', { defaultValue: 'Belongs to' })}
                                            </div>
                                            <div className="text-sm font-semibold">
                                                {getLoanLinkedPartyTypeLabel(selectedParty.linkedPartyType, t)} - {selectedParty.linkedPartyName}
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 shrink-0 px-2 text-muted-foreground"
                                            onClick={() => setSelectedParty(null)}
                                        >
                                            <X className="h-4 w-4" />
                                            {t('loans.clearParty', { defaultValue: 'Clear Link' })}
                                        </Button>
                                    </div>
                                ) : null}
                            </div>

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                <div className="grid gap-2 md:col-span-1">
                                    <Label>{t('loans.contactPhone', { defaultValue: 'Phone' })}</Label>
                                    <Input value={borrowerPhone} onChange={e => setBorrowerPhone(e.target.value)} />
                                </div>
                                <div className="grid gap-2 md:col-span-2">
                                    <Label>{t('loans.contactAddress', { defaultValue: 'Address' })}</Label>
                                    <Input value={borrowerAddress} onChange={e => setBorrowerAddress(e.target.value)} />
                                </div>
                            </div>

                            <div className="grid gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
                                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                    <div className="grid gap-2">
                                        <Label>{t('loans.direction', { defaultValue: 'Direction' })}</Label>
                                        <Select value={direction} onValueChange={(value: LoanDirection) => setDirection(value)}>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="lent">
                                                    <span className="flex items-center gap-2">
                                                        <ArrowUpRight className="h-4 w-4" />
                                                        {getLoanDirectionLabel('lent', t)}
                                                    </span>
                                                </SelectItem>
                                                <SelectItem value="borrowed">
                                                    <span className="flex items-center gap-2">
                                                        <ArrowDownLeft className="h-4 w-4" />
                                                        {getLoanDirectionLabel('borrowed', t)}
                                                    </span>
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <CurrencySelector
                                        value={selectedCurrency}
                                        onChange={(value) => setSelectedCurrency(value)}
                                        label={t('loans.currencyHint', { defaultValue: 'Settlement Currency' })}
                                        iqdDisplayPreference={features.iqd_display_preference}
                                        allowedCurrencies={Array.from(new Set([settlementCurrency, ...features.allowed_currencies])) as CurrencyCode[]}
                                    />
                                </div>
                                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                    <div className="grid gap-2">
                                        <Label>{t('loans.principal', { defaultValue: 'Principal' })} <span className="text-destructive">*</span></Label>
                                        <Input
                                            type="text"
                                            inputMode={selectedCurrency === 'iqd' ? 'numeric' : 'decimal'}
                                            placeholder="0"
                                            value={formatNumericInput(principalAmount)}
                                            onChange={e => setPrincipalAmount(sanitizeNumericInput(e.target.value, {
                                                allowDecimal: selectedCurrency !== 'iqd'
                                            }))}
                                        />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label>{t('loans.createdAt', { defaultValue: 'Created At' })}</Label>
                                        <DateTimePicker
                                            id="simple-loan-created-at"
                                            date={selectedCreatedAt}
                                            setDate={(value) => setCreatedAt(value ? formatLocalDateTimeValue(value) : '')}
                                            placeholder={t('loans.pickCreatedAt', { defaultValue: 'Pick creation time' })}
                                            disabled={isSaving}
                                        />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label>{t('loans.dueDate', { defaultValue: 'Due Date' })}</Label>
                                        <DateTimePicker
                                            id="simple-loan-due-date"
                                            mode="date"
                                            date={parseLocalDateValue(dueDate)}
                                            setDate={(value) => setDueDate(value ? formatLocalDateValue(value) : null)}
                                            placeholder={t('loans.dueDate', { defaultValue: 'Due Date' })}
                                        />
                                    </div>
                                </div>
                                <PaymentAccountSelector
                                    workspaceId={workspaceId}
                                    value={paymentAccount?.id ?? null}
                                    onValueChange={setPaymentAccount}
                                    disabled={isSaving}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('loans.notes', { defaultValue: 'Notes' })}</Label>
                                <Textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} />
                            </div>
                        </div>
                    </DialogBody>

                    <DialogFooter layout="structured">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={isSaving}>
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button type="submit" className="w-full sm:w-auto" disabled={!canSubmit || isSaving}>
                            {t('common.create') || 'Create'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>

            <LoanPartyPickerDialog
                isOpen={isPartyPickerOpen}
                onOpenChange={setIsPartyPickerOpen}
                workspaceId={workspaceId}
                selectedPartyId={selectedParty?.linkedPartyId}
                onSelect={handlePartySelect}
            />

            <SaveBorrowerAsPartnerDialog
                isOpen={savePartnerData !== null}
                onOpenChange={(open) => { if (!open) setSavePartnerData(null) }}
                workspaceId={workspaceId}
                data={savePartnerData}
                onComplete={() => {
                    const loanId = savePartnerData?.loanId
                    setSavePartnerData(null)
                    onOpenChange(false)
                    if (loanId) onCreated?.(loanId)
                }}
            />
        </Dialog>
    )
}
