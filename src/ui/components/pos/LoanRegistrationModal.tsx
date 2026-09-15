import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, X } from 'lucide-react'
import { useBusinessPartnersLoading, type CurrencyCode, type InstallmentFrequency } from '@/local-db'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
import { formatCurrency, formatLocalDateValue, parseLocalDateValue } from '@/lib/utils'
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Input,
    Label,
    Button,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    DateTimePicker,
    Textarea
} from '@/ui/components'
import { LoanPartyPickerDialog } from '@/ui/components/loans/LoanPartyPickerDialog'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import type { BusinessPartner } from '@/local-db'

export interface LoanRegistrationData {
    linkedPartyType?: 'business_partner' | null
    linkedPartyId?: string | null
    linkedPartyName?: string | null
    borrowerName: string
    borrowerPhone: string
    borrowerAddress: string
    borrowerNationalId: string
    installmentCount: number
    installmentFrequency: InstallmentFrequency
    firstDueDate: string | null
    notes?: string
}

type LoanRegistrationFormData = Omit<LoanRegistrationData, 'installmentCount'> & {
    installmentCount: number | ''
}

interface LoanRegistrationModalProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    onSubmit: (data: LoanRegistrationData) => void
    workspaceId: string
    settlementCurrency: CurrencyCode
    principalAmount: number
    isSubmitting?: boolean
}

export function LoanRegistrationModal({
    isOpen,
    onOpenChange,
    onSubmit,
    workspaceId,
    settlementCurrency,
    principalAmount,
    isSubmitting = false
}: LoanRegistrationModalProps) {
    const { t } = useTranslation()
    const arePartnersLoading = useBusinessPartnersLoading(workspaceId)
    const [form, setForm] = useState<LoanRegistrationFormData>({
        linkedPartyType: null,
        linkedPartyId: null,
        linkedPartyName: null,
        borrowerName: '',
        borrowerPhone: '',
        borrowerAddress: '',
        borrowerNationalId: '',
        installmentCount: 1,
        installmentFrequency: 'monthly',
        firstDueDate: null,
        notes: ''
    })
    const [isPartyPickerOpen, setIsPartyPickerOpen] = useState(false)

    useEffect(() => {
        if (!isOpen) return
        setForm({
            linkedPartyType: null,
            linkedPartyId: null,
            linkedPartyName: null,
            borrowerName: '',
            borrowerPhone: '',
            borrowerAddress: '',
            borrowerNationalId: '',
            installmentCount: 1,
            installmentFrequency: 'monthly',
            firstDueDate: null,
            notes: ''
        })
        setIsPartyPickerOpen(false)
    }, [isOpen])

    const repaymentCount = typeof form.installmentCount === 'number' ? form.installmentCount : 0
    const isValid = form.borrowerName.trim() &&
        form.borrowerPhone.trim() &&
        form.borrowerAddress.trim() &&
        Number.isInteger(repaymentCount) &&
        repaymentCount > 0
    const isInstallmentLoan = repaymentCount > 1

    const submit = () => {
        if (!isValid) return
        onSubmit({
            ...form,
            linkedPartyType: form.linkedPartyType || null,
            linkedPartyId: form.linkedPartyId?.trim() || null,
            linkedPartyName: form.linkedPartyName?.trim() || null,
            borrowerName: form.borrowerName.trim(),
            borrowerPhone: form.borrowerPhone.trim(),
            borrowerAddress: form.borrowerAddress.trim(),
            borrowerNationalId: form.borrowerNationalId.trim(),
            installmentCount: repaymentCount,
            notes: form.notes?.trim() || undefined
        })
    }

    const handlePartySelect = (selection: LoanPartySelection) => {
        setForm(prev => ({
            ...prev,
            linkedPartyType: selection.linkedPartyType,
            linkedPartyId: selection.linkedPartyId,
            linkedPartyName: selection.linkedPartyName,
            borrowerName: selection.borrowerName,
            borrowerPhone: selection.borrowerPhone,
            borrowerAddress: selection.borrowerAddress
        }))
    }

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent layout="structured" className="max-w-4xl">
                <DialogHeader layout="structured">
                    <DialogTitle>
                        {isInstallmentLoan
                            ? t('loans.registerSaleInstallmentLoan', { defaultValue: 'Register Sale Installment Loan' })
                            : t('loans.registerSaleLoan', { defaultValue: 'Register Sale Loan' })}
                    </DialogTitle>
                    <DialogDescription>
                        {isInstallmentLoan
                            ? t('loans.saleInstallmentLoanDescription', { defaultValue: 'Create an installment loan for this POS sale.' })
                            : t('loans.saleLoanDescription', { defaultValue: 'Create one loan for this POS sale. Add more repayments to create an installment loan.' })}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col">
                    <DialogBody className="py-5">
                        <div className="grid gap-5">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>{t('loans.currencyHint', { defaultValue: 'Settlement Currency' })}</span>
                                <span className="rounded-md bg-muted px-2 py-1 font-semibold text-foreground">
                                    {settlementCurrency.toUpperCase()}
                                </span>
                            </div>

                            <div className="grid gap-2">
                                <Label isLoading={arePartnersLoading}>{t('loans.borrowerName') || 'Borrower Name'} <span className="text-destructive">*</span></Label>
                                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                                    <PartnerAutocompleteInput
                                        value={form.borrowerName}
                                        onChange={v => setForm(prev => ({ ...prev, borrowerName: v }))}
                                        onSelectPartner={(partner: BusinessPartner) => {
                                            setForm(prev => ({
                                                ...prev,
                                                borrowerName: partner.partnerName,
                                                borrowerPhone: partner.phone || prev.borrowerPhone,
                                                borrowerAddress: [partner.address, partner.city].filter(Boolean).join(', ') || prev.borrowerAddress,
                                                linkedPartyType: 'business_partner',
                                                linkedPartyId: partner.id,
                                                linkedPartyName: partner.partnerName
                                            }))
                                        }}
                                        workspaceId={workspaceId}
                                        isLoading={arePartnersLoading}
                                    />
                                    <Button type="button" variant="outline" className="w-full shrink-0 gap-2 md:w-auto" onClick={() => setIsPartyPickerOpen(true)}>
                                        <Users className="h-4 w-4" />
                                        {t('loans.selectParty', { defaultValue: 'Business Partner' })}
                                    </Button>
                                </div>
                                {form.linkedPartyType && form.linkedPartyName ? (
                                    <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                                {t('loans.belongsTo', { defaultValue: 'Belongs to' })}
                                            </div>
                                            <div className="text-sm font-semibold">
                                                {getLoanLinkedPartyTypeLabel(form.linkedPartyType, t)} - {form.linkedPartyName}
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 shrink-0 px-2 text-muted-foreground"
                                            onClick={() => setForm(prev => ({
                                                ...prev,
                                                linkedPartyType: null,
                                                linkedPartyId: null,
                                                linkedPartyName: null
                                            }))}
                                        >
                                            <X className="h-4 w-4" />
                                            {t('loans.clearParty', { defaultValue: 'Clear Link' })}
                                        </Button>
                                    </div>
                                ) : null}
                            </div>

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                <div className="grid gap-2 md:col-span-1">
                                    <Label>{t('loans.borrowerPhone') || 'Borrower Phone'} <span className="text-destructive">*</span></Label>
                                    <Input
                                        value={form.borrowerPhone}
                                        onChange={e => setForm(prev => ({ ...prev, borrowerPhone: e.target.value }))}
                                    />
                                </div>
                                <div className="grid gap-2 md:col-span-2">
                                    <Label>{t('loans.borrowerAddress') || 'Borrower Address'} <span className="text-destructive">*</span></Label>
                                    <Input
                                        value={form.borrowerAddress}
                                        onChange={e => setForm(prev => ({ ...prev, borrowerAddress: e.target.value }))}
                                    />
                                </div>
                            </div>

                            <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                                <div className={`grid grid-cols-1 gap-4 ${isInstallmentLoan ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
                                    <div className="grid gap-2">
                                        <Label>
                                            {isInstallmentLoan
                                                ? t('loans.installmentCount', { defaultValue: 'Installment Count' })
                                                : t('loans.repaymentCount', { defaultValue: 'Repayment Count' })}
                                            {' '}<span className="text-destructive">*</span>
                                        </Label>
                                        <Input
                                            type="number"
                                            min={1}
                                            step={1}
                                            inputMode="numeric"
                                            value={form.installmentCount}
                                            placeholder="1"
                                            onChange={e => {
                                                const rawCount = e.target.value
                                                const count = Math.trunc(Number(rawCount))
                                                setForm(prev => ({
                                                    ...prev,
                                                    installmentCount: rawCount && Number.isFinite(count) && count > 0 ? count : ''
                                                }))
                                            }}
                                        />
                                        {principalAmount > 0 && repaymentCount > 0 && (
                                            <p className="text-[11px] text-muted-foreground">
                                                {isInstallmentLoan
                                                    ? `≈ ${formatCurrency(principalAmount / repaymentCount, settlementCurrency)} / ${t('loans.installment', { defaultValue: 'installment' })}`
                                                    : `${t('loans.totalDue', { defaultValue: 'Total Due' })}: ${formatCurrency(principalAmount, settlementCurrency)}`}
                                            </p>
                                        )}
                                    </div>
                                    {isInstallmentLoan ? (
                                        <div className="grid gap-2">
                                            <Label>{t('loans.installmentFrequency', { defaultValue: 'Installment Frequency' })}</Label>
                                            <Select
                                                value={form.installmentFrequency}
                                                onValueChange={(value: InstallmentFrequency) => setForm(prev => ({ ...prev, installmentFrequency: value }))}
                                            >
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="weekly">{t('loans.frequencies.weekly') || 'Weekly'}</SelectItem>
                                                    <SelectItem value="biweekly">{t('loans.frequencies.biweekly') || 'Biweekly'}</SelectItem>
                                                    <SelectItem value="monthly">{t('loans.frequencies.monthly') || 'Monthly'}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    ) : null}
                                    <div className="grid gap-2">
                                        <Label>
                                            {isInstallmentLoan
                                                ? t('loans.firstInstallmentDueDate', { defaultValue: 'First Installment Due Date' })
                                                : t('loans.dueDate', { defaultValue: 'Due Date' })}
                                        </Label>
                                        <DateTimePicker
                                            id="registration-loan-first-due-date"
                                            mode="date"
                                            date={parseLocalDateValue(form.firstDueDate)}
                                            setDate={(value) => setForm(prev => ({ ...prev, firstDueDate: value ? formatLocalDateValue(value) : null }))}
                                            placeholder={isInstallmentLoan
                                                ? t('loans.firstInstallmentDueDate', { defaultValue: 'First Installment Due Date' })
                                                : t('loans.dueDate', { defaultValue: 'Due Date' })}
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('loans.notes') || 'Notes'}</Label>
                                <Textarea
                                    rows={3}
                                    value={form.notes}
                                    onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
                                />
                            </div>
                        </div>
                    </DialogBody>

                    <DialogFooter layout="structured">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button type="button" className="w-full sm:w-auto" onClick={submit} disabled={!isValid || isSubmitting}>
                            {isInstallmentLoan
                                ? t('loans.createSaleInstallmentLoan', { defaultValue: 'Create Sale Installment Loan' })
                                : t('loans.createSaleLoan', { defaultValue: 'Create Sale Loan' })}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>

            <LoanPartyPickerDialog
                isOpen={isPartyPickerOpen}
                onOpenChange={setIsPartyPickerOpen}
                workspaceId={workspaceId}
                selectedPartyId={form.linkedPartyId}
                onSelect={handlePartySelect}
            />
        </Dialog>
    )
}
