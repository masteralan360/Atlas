import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, Users, X } from 'lucide-react'
import { useAuth } from '@/auth'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { createManualLoan, useBusinessPartnersLoading, type CurrencyCode, type InstallmentFrequency, type LoanDirection, type PaymentAccount } from '@/local-db'
import { buildOrderExchangeRatesSnapshot } from '@/lib/orderCurrency'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
import { formatCurrency, formatLocalDateValue, formatNumericInput, parseFormattedNumber, parseLocalDateValue, sanitizeNumericInput } from '@/lib/utils'
import {
    CurrencySelector,
    Dialog,
    DialogBody,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Input,
    Label,
    Button,
    DateTimePicker,
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

interface CreateManualLoanModalProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    settlementCurrency: CurrencyCode
    onCreated?: (loanId: string) => void
    initialParty?: LoanPartySelection | null
    lockParty?: boolean
    initialDirection?: LoanDirection
}

export function CreateManualLoanModal({
    isOpen,
    onOpenChange,
    workspaceId,
    settlementCurrency,
    onCreated,
    initialParty = null,
    lockParty = false,
    initialDirection = 'lent'
}: CreateManualLoanModalProps) {
    const { t } = useTranslation()
    const arePartnersLoading = useBusinessPartnersLoading(workspaceId)
    const { toast } = useToast()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const [isSaving, setIsSaving] = useState(false)
    const [selectedCurrency, setSelectedCurrency] = useState<CurrencyCode>(settlementCurrency)
    const [borrowerName, setBorrowerName] = useState('')
    const [borrowerPhone, setBorrowerPhone] = useState('')
    const [borrowerAddress, setBorrowerAddress] = useState('')
    const [selectedParty, setSelectedParty] = useState<LoanPartySelection | null>(null)
    const [isPartyPickerOpen, setIsPartyPickerOpen] = useState(false)
    const [principalAmount, setPrincipalAmount] = useState('')
    const [installmentCount, setInstallmentCount] = useState(1)
    const [installmentFrequency, setInstallmentFrequency] = useState<InstallmentFrequency>('monthly')
    const [firstDueDate, setFirstDueDate] = useState<string | null>(null)
    const [notes, setNotes] = useState('')
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [direction, setDirection] = useState<LoanDirection>(initialDirection)
    const [savePartnerData, setSavePartnerData] = usePendingSavePartnerPrompt()

    useEffect(() => {
        if (!isOpen) return
        setIsSaving(false)
        setSelectedCurrency(initialParty?.defaultCurrency ?? settlementCurrency)
        setBorrowerName(initialParty?.borrowerName ?? '')
        setBorrowerPhone(initialParty?.borrowerPhone ?? '')
        setBorrowerAddress(initialParty?.borrowerAddress ?? '')
        setSelectedParty(initialParty)
        setIsPartyPickerOpen(false)
        setPrincipalAmount('')
        setInstallmentCount(1)
        setInstallmentFrequency('monthly')
        setFirstDueDate(null)
        setNotes('')
        setPaymentAccount(null)
        setDirection(initialDirection)
    }, [initialDirection, initialParty, isOpen, settlementCurrency])

    useEffect(() => {
        setPrincipalAmount((current) => sanitizeNumericInput(current, {
            allowDecimal: selectedCurrency !== 'iqd'
        }))
    }, [selectedCurrency])

    const canSubmit = borrowerName.trim() &&
        borrowerPhone.trim() &&
        borrowerAddress.trim() &&
        parseFormattedNumber(principalAmount || '0') > 0 &&
        installmentCount > 0
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
        if (!canSubmit || isSaving) return
        setIsSaving(true)
        try {
            const result = await createManualLoan(workspaceId, {
                saleId: null,
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
                installmentCount,
                installmentFrequency,
                firstDueDate,
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
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent layout="structured" className="max-w-4xl">
                <DialogHeader layout="structured">
                    <DialogTitle>{t('loans.createManualLoan') || 'Create Manual Loan'}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <DialogBody className="py-5">
                        <div className="grid gap-5">
                            <div className="grid gap-2">
                                <Label isLoading={arePartnersLoading}>{t('loans.borrowerName') || 'Borrower Name'} <span className="text-destructive">*</span></Label>
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
                                        disabled={lockParty}
                                    />
                                    {!lockParty ? (
                                        <Button type="button" variant="outline" className="w-full shrink-0 gap-2 md:w-auto" onClick={() => setIsPartyPickerOpen(true)}>
                                            <Users className="h-4 w-4" />
                                            {t('loans.selectParty', { defaultValue: 'Business Partner' })}
                                        </Button>
                                    ) : null}
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
                                        {!lockParty ? (
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
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                <div className="grid gap-2 md:col-span-1">
                                    <Label>{t('loans.borrowerPhone') || 'Borrower Phone'} <span className="text-destructive">*</span></Label>
                                    <Input value={borrowerPhone} onChange={e => setBorrowerPhone(e.target.value)} />
                                </div>
                                <div className="grid gap-2 md:col-span-2">
                                    <Label>{t('loans.borrowerAddress') || 'Borrower Address'} <span className="text-destructive">*</span></Label>
                                    <Input value={borrowerAddress} onChange={e => setBorrowerAddress(e.target.value)} />
                                </div>
                            </div>

                            <div className="grid gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
                                <div className="grid gap-2">
                                    <Label className="flex items-center gap-2"><ArrowLeftRight className="h-4 w-4" />{t('loans.direction')}</Label>
                                    <Select value={direction} onValueChange={(value) => setDirection(value as LoanDirection)} disabled={isSaving}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="lent">{t('loans.directions.lent')}</SelectItem>
                                            <SelectItem value="borrowed">{t('loans.directions.borrowed')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                    <div className="grid gap-2">
                                        <Label>{t('loans.principal') || 'Principal'} <span className="text-destructive">*</span></Label>
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
                                    <CurrencySelector
                                        value={selectedCurrency}
                                        onChange={(value) => setSelectedCurrency(value)}
                                        label={t('loans.currencyHint') || 'Settlement Currency'}
                                        iqdDisplayPreference={features.iqd_display_preference}
                                        allowedCurrencies={Array.from(new Set([settlementCurrency, ...features.allowed_currencies])) as CurrencyCode[]}
                                    />
                                </div>
                                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                    <div className="grid gap-2">
                                        <Label>{t('loans.installmentCount') || 'Installments'} <span className="text-destructive">*</span></Label>
                                        <Input
                                            type="number"
                                            min={1}
                                            inputMode="numeric"
                                            value={installmentCount}
                                            onChange={e => setInstallmentCount(Math.max(1, Number(e.target.value || 1)))}
                                        />
                                        {parseFormattedNumber(principalAmount || '0') > 0 && installmentCount > 0 && (
                                            <p className="text-[11px] text-muted-foreground">
                                                ≈ {formatCurrency(parseFormattedNumber(principalAmount || '0') / installmentCount, selectedCurrency)} / {t('loans.installment', { defaultValue: 'installment' })}
                                            </p>
                                        )}
                                    </div>
                                    <div className="grid gap-2">
                                        <Label>{t('loans.frequency') || 'Frequency'}</Label>
                                        <Select value={installmentFrequency} onValueChange={(value: InstallmentFrequency) => setInstallmentFrequency(value)}>
                                            <SelectTrigger><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="daily">{t('loans.frequencies.daily') || 'Daily'}</SelectItem>
                                                <SelectItem value="weekly">{t('loans.frequencies.weekly') || 'Weekly'}</SelectItem>
                                                <SelectItem value="biweekly">{t('loans.frequencies.biweekly') || 'Biweekly'}</SelectItem>
                                                <SelectItem value="monthly">{t('loans.frequencies.monthly') || 'Monthly'}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="grid gap-2">
                                        <Label>{t('loans.firstDueDate') || 'First Due Date'}</Label>
                                        <DateTimePicker
                                            id="manual-loan-first-due-date"
                                            mode="date"
                                            date={parseLocalDateValue(firstDueDate)}
                                            setDate={(value) => setFirstDueDate(value ? formatLocalDateValue(value) : null)}
                                            placeholder={t('loans.firstDueDate') || 'First Due Date'}
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
                                <Label>{t('loans.notes') || 'Notes'}</Label>
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
