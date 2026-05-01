import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, X } from 'lucide-react'
import { useAuth } from '@/auth'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { createManualLoan, type CurrencyCode, type InstallmentFrequency } from '@/local-db'
import { buildOrderExchangeRatesSnapshot } from '@/lib/orderCurrency'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
import { formatLocalDateValue, formatNumericInput, parseFormattedNumber, parseLocalDateValue, sanitizeNumericInput } from '@/lib/utils'
import {
    Dialog,
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

interface CreateManualLoanModalProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    settlementCurrency: CurrencyCode
    onCreated?: (loanId: string) => void
}

export function CreateManualLoanModal({
    isOpen,
    onOpenChange,
    workspaceId,
    settlementCurrency,
    onCreated
}: CreateManualLoanModalProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const [isSaving, setIsSaving] = useState(false)
    const [selectedCurrency, setSelectedCurrency] = useState<CurrencyCode>(settlementCurrency)
    const [borrowerName, setBorrowerName] = useState('')
    const [borrowerPhone, setBorrowerPhone] = useState('')
    const [borrowerAddress, setBorrowerAddress] = useState('')
    const [borrowerNationalId, setBorrowerNationalId] = useState('')
    const [selectedParty, setSelectedParty] = useState<LoanPartySelection | null>(null)
    const [isPartyPickerOpen, setIsPartyPickerOpen] = useState(false)
    const [principalAmount, setPrincipalAmount] = useState('')
    const [installmentCount, setInstallmentCount] = useState(1)
    const [installmentFrequency, setInstallmentFrequency] = useState<InstallmentFrequency>('monthly')
    const [firstDueDate, setFirstDueDate] = useState(formatLocalDateValue(new Date()))
    const [notes, setNotes] = useState('')

    useEffect(() => {
        if (!isOpen) return
        setIsSaving(false)
        setSelectedCurrency(settlementCurrency)
        setBorrowerName('')
        setBorrowerPhone('')
        setBorrowerAddress('')
        setBorrowerNationalId('')
        setSelectedParty(null)
        setIsPartyPickerOpen(false)
        setPrincipalAmount('')
        setInstallmentCount(1)
        setInstallmentFrequency('monthly')
        setFirstDueDate(formatLocalDateValue(new Date()))
        setNotes('')
    }, [isOpen, settlementCurrency])

    useEffect(() => {
        setPrincipalAmount((current) => sanitizeNumericInput(current, {
            allowDecimal: selectedCurrency !== 'iqd'
        }))
    }, [selectedCurrency])

    const canSubmit = borrowerName.trim() &&
        borrowerPhone.trim() &&
        borrowerAddress.trim() &&
        borrowerNationalId.trim() &&
        parseFormattedNumber(principalAmount || '0') > 0 &&
        installmentCount > 0 &&
        firstDueDate
    const availableCurrencies = useMemo(() => {
        const currencies: CurrencyCode[] = Array.from(new Set([settlementCurrency, 'usd', 'iqd'])) as CurrencyCode[]
        if (features.eur_conversion_enabled && !currencies.includes('eur')) currencies.push('eur')
        if (features.try_conversion_enabled && !currencies.includes('try')) currencies.push('try')
        return currencies
    }, [features.eur_conversion_enabled, features.try_conversion_enabled, settlementCurrency])
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
                linkedPartyType: selectedParty?.linkedPartyType || null,
                linkedPartyId: selectedParty?.linkedPartyId || null,
                linkedPartyName: selectedParty?.linkedPartyName || null,
                borrowerName: borrowerName.trim(),
                borrowerPhone: borrowerPhone.trim(),
                borrowerAddress: borrowerAddress.trim(),
                borrowerNationalId: borrowerNationalId.trim(),
                principalAmount: parseFormattedNumber(principalAmount || '0'),
                settlementCurrency: selectedCurrency,
                exchangeRateSnapshot,
                installmentCount,
                installmentFrequency,
                firstDueDate,
                notes: notes.trim() || undefined,
                createdBy: user?.id
            })

            toast({
                title: t('messages.success') || 'Success',
                description: t('loans.messages.loanCreated') || 'Loan created successfully'
            })
            onOpenChange(false)
            onCreated?.(result.loan.id)
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
            <DialogContent className="top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-0.75rem)] w-[calc(100vw-0.75rem)] max-w-4xl flex-col overflow-hidden rounded-[1.25rem] border-border/60 p-0 sm:w-full sm:max-h-[min(calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),820px)] sm:rounded-[1.75rem]">
                <DialogHeader className="border-b bg-muted/30 px-4 py-4 pr-14 text-left sm:px-6 sm:py-5">
                    <DialogTitle>{t('loans.createManualLoan') || 'Create Manual Loan'}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
                        <div className="grid gap-4">
                            <div className="grid gap-2">
                                <Label>{t('loans.borrowerName') || 'Borrower Name'} <span className="text-destructive">*</span></Label>
                                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                                    <Input value={borrowerName} onChange={e => setBorrowerName(e.target.value)} className="flex-1" />
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

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label>{t('loans.borrowerPhone') || 'Borrower Phone'} <span className="text-destructive">*</span></Label>
                                    <Input value={borrowerPhone} onChange={e => setBorrowerPhone(e.target.value)} />
                                </div>
                                <div className="grid gap-2">
                                    <Label>{t('loans.borrowerNationalId') || 'Borrower National ID'} <span className="text-destructive">*</span></Label>
                                    <Input value={borrowerNationalId} onChange={e => setBorrowerNationalId(e.target.value)} />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('loans.borrowerAddress') || 'Borrower Address'} <span className="text-destructive">*</span></Label>
                                <Input value={borrowerAddress} onChange={e => setBorrowerAddress(e.target.value)} />
                            </div>

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
                                <div className="grid gap-2 xl:col-span-3">
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
                                <div className="grid gap-2 xl:col-span-2">
                                    <Label>{t('loans.currencyHint') || 'Settlement Currency'}</Label>
                                    <Select value={selectedCurrency} onValueChange={(value: CurrencyCode) => setSelectedCurrency(value)}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {availableCurrencies.map((currency) => (
                                                <SelectItem key={currency} value={currency}>
                                                    {currency.toUpperCase()}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="grid gap-2 xl:col-span-2">
                                    <Label>{t('loans.installmentCount') || 'Installments'} <span className="text-destructive">*</span></Label>
                                    <Input
                                        type="number"
                                        min={1}
                                        inputMode="numeric"
                                        value={installmentCount}
                                        onChange={e => setInstallmentCount(Math.max(1, Number(e.target.value || 1)))}
                                    />
                                </div>
                                <div className="grid gap-2 xl:col-span-2">
                                    <Label>{t('loans.frequency') || 'Frequency'}</Label>
                                    <Select value={installmentFrequency} onValueChange={(value: InstallmentFrequency) => setInstallmentFrequency(value)}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="weekly">{t('loans.frequencies.weekly') || 'Weekly'}</SelectItem>
                                            <SelectItem value="biweekly">{t('loans.frequencies.biweekly') || 'Biweekly'}</SelectItem>
                                            <SelectItem value="monthly">{t('loans.frequencies.monthly') || 'Monthly'}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="grid gap-2 xl:col-span-3">
                                    <Label>{t('loans.firstDueDate') || 'First Due Date'} <span className="text-destructive">*</span></Label>
                                    <DateTimePicker
                                        id="manual-loan-first-due-date"
                                        mode="date"
                                        date={parseLocalDateValue(firstDueDate)}
                                        setDate={(value) => setFirstDueDate(value ? formatLocalDateValue(value) : '')}
                                        placeholder={t('loans.firstDueDate') || 'First Due Date'}
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('loans.notes') || 'Notes'}</Label>
                                <Textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)} />
                            </div>
                        </div>
                    </div>

                    <DialogFooter className="border-t bg-muted/20 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-between sm:px-6">
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
        </Dialog>
    )
}
