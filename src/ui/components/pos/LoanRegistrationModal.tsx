import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, X } from 'lucide-react'
import type { CurrencyCode, InstallmentFrequency } from '@/local-db'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
import { formatLocalDateValue, parseLocalDateValue } from '@/lib/utils'
import {
    Dialog,
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
    firstDueDate: string
    notes?: string
}

interface LoanRegistrationModalProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    onSubmit: (data: LoanRegistrationData) => void
    workspaceId: string
    settlementCurrency: CurrencyCode
    isSubmitting?: boolean
}

export function LoanRegistrationModal({
    isOpen,
    onOpenChange,
    onSubmit,
    workspaceId,
    settlementCurrency,
    isSubmitting = false
}: LoanRegistrationModalProps) {
    const { t } = useTranslation()
    const [form, setForm] = useState<LoanRegistrationData>({
        linkedPartyType: null,
        linkedPartyId: null,
        linkedPartyName: null,
        borrowerName: '',
        borrowerPhone: '',
        borrowerAddress: '',
        borrowerNationalId: '',
        installmentCount: 1,
        installmentFrequency: 'monthly',
        firstDueDate: formatLocalDateValue(new Date()),
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
            firstDueDate: formatLocalDateValue(new Date()),
            notes: ''
        })
        setIsPartyPickerOpen(false)
    }, [isOpen])

    const isValid = form.borrowerName.trim() &&
        form.borrowerPhone.trim() &&
        form.borrowerAddress.trim() &&
        form.borrowerNationalId.trim() &&
        form.installmentCount > 0 &&
        form.firstDueDate

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
            <DialogContent className="top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-0.75rem)] w-[calc(100vw-0.75rem)] max-w-4xl flex-col overflow-hidden rounded-[1.25rem] border-border/60 p-0 sm:w-full sm:max-h-[min(calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),820px)] sm:rounded-[1.75rem]">
                <DialogHeader className="border-b bg-muted/30 px-4 py-4 pr-14 text-left sm:px-6 sm:py-5">
                    <DialogTitle>{t('loans.registerFromPos') || 'Register Loan'}</DialogTitle>
                    <DialogDescription>{t('loans.selectPartyHint', { defaultValue: 'You can link this loan to an existing business partner and still edit the borrower fields manually.' })}</DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
                        <div className="grid gap-4">
                            <div className="text-xs text-muted-foreground">
                                {(t('loans.currencyHint') || 'Settlement Currency')}: {settlementCurrency.toUpperCase()}
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('loans.borrowerName') || 'Borrower Name'} <span className="text-destructive">*</span></Label>
                                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                                    <PartnerAutocompleteInput
                                        value={form.borrowerName}
                                        onChange={v => setForm(prev => ({ ...prev, borrowerName: v }))}
                                        onSelectPartner={(partner: BusinessPartner) => {
                                            setForm(prev => ({
                                                ...prev,
                                                borrowerName: partner.name,
                                                borrowerPhone: partner.phone || prev.borrowerPhone,
                                                borrowerAddress: [partner.address, partner.city, partner.country].filter(Boolean).join(', ') || prev.borrowerAddress,
                                                linkedPartyType: 'business_partner',
                                                linkedPartyId: partner.id,
                                                linkedPartyName: partner.name
                                            }))
                                        }}
                                        workspaceId={workspaceId}
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

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label>{t('loans.borrowerPhone') || 'Borrower Phone'} <span className="text-destructive">*</span></Label>
                                    <Input
                                        value={form.borrowerPhone}
                                        onChange={e => setForm(prev => ({ ...prev, borrowerPhone: e.target.value }))}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label>{t('loans.borrowerNationalId') || 'Borrower National ID'} <span className="text-destructive">*</span></Label>
                                    <Input
                                        value={form.borrowerNationalId}
                                        onChange={e => setForm(prev => ({ ...prev, borrowerNationalId: e.target.value }))}
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('loans.borrowerAddress') || 'Borrower Address'} <span className="text-destructive">*</span></Label>
                                <Input
                                    value={form.borrowerAddress}
                                    onChange={e => setForm(prev => ({ ...prev, borrowerAddress: e.target.value }))}
                                />
                            </div>

                            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                <div className="grid gap-2">
                                    <Label>{t('loans.installmentCount') || 'Installments'} <span className="text-destructive">*</span></Label>
                                    <Input
                                        type="number"
                                        min={1}
                                        inputMode="numeric"
                                        value={form.installmentCount}
                                        onChange={e => setForm(prev => ({ ...prev, installmentCount: Math.max(1, Number(e.target.value || 1)) }))}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label>{t('loans.frequency') || 'Frequency'}</Label>
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
                                <div className="grid gap-2">
                                    <Label>{t('loans.firstDueDate') || 'First Due Date'} <span className="text-destructive">*</span></Label>
                                    <DateTimePicker
                                        id="registration-loan-first-due-date"
                                        mode="date"
                                        date={parseLocalDateValue(form.firstDueDate)}
                                        setDate={(value) => setForm(prev => ({ ...prev, firstDueDate: value ? formatLocalDateValue(value) : '' }))}
                                        placeholder={t('loans.firstDueDate') || 'First Due Date'}
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('loans.notes') || 'Notes'}</Label>
                                <Textarea
                                    rows={4}
                                    value={form.notes}
                                    onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
                                />
                            </div>
                        </div>
                    </div>

                    <DialogFooter className="border-t bg-muted/20 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-between sm:px-6">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button type="button" className="w-full sm:w-auto" onClick={submit} disabled={!isValid || isSubmitting}>
                            {t('common.confirm') || 'Confirm'}
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
