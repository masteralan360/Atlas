import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, X } from 'lucide-react'
import type { CurrencyCode, InstallmentFrequency } from '@/local-db'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
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
} from '@/ui/components'
import { LoanPartyPickerDialog } from '@/ui/components/loans/LoanPartyPickerDialog'

export interface LoanRegistrationData {
    linkedPartyType?: 'customer' | null
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
        firstDueDate: new Date().toISOString().slice(0, 10),
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
            firstDueDate: new Date().toISOString().slice(0, 10),
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
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t('loans.registerFromPos') || 'Register Loan'}</DialogTitle>
                    <DialogDescription>{t('loans.selectPartyHint', { defaultValue: 'You can link this loan to an existing customer and still edit the borrower fields manually.' })}</DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-2">
                    <div className="text-xs text-muted-foreground">
                        {(t('loans.currencyHint') || 'Settlement Currency')}: {settlementCurrency.toUpperCase()}
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('loans.borrowerName') || 'Borrower Name'}</Label>
                        <div className="flex items-center gap-2">
                            <Input
                                value={form.borrowerName}
                                onChange={e => setForm(prev => ({ ...prev, borrowerName: e.target.value }))}
                                className="flex-1"
                            />
                            <Button type="button" variant="outline" className="shrink-0 gap-2" onClick={() => setIsPartyPickerOpen(true)}>
                                <Users className="h-4 w-4" />
                                {t('loans.selectParty', { defaultValue: 'Customer' })}
                            </Button>
                        </div>
                        {form.linkedPartyType && form.linkedPartyName ? (
                            <div className="flex items-start justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
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

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="grid gap-2">
                            <Label>{t('loans.borrowerPhone') || 'Borrower Phone'}</Label>
                            <Input
                                value={form.borrowerPhone}
                                onChange={e => setForm(prev => ({ ...prev, borrowerPhone: e.target.value }))}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label>{t('loans.borrowerNationalId') || 'Borrower National ID'}</Label>
                            <Input
                                value={form.borrowerNationalId}
                                onChange={e => setForm(prev => ({ ...prev, borrowerNationalId: e.target.value }))}
                            />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('loans.borrowerAddress') || 'Borrower Address'}</Label>
                        <Input
                            value={form.borrowerAddress}
                            onChange={e => setForm(prev => ({ ...prev, borrowerAddress: e.target.value }))}
                        />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="grid gap-2">
                            <Label>{t('loans.installmentCount') || 'Installments'}</Label>
                            <Input
                                type="number"
                                min={1}
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
                            <Label>{t('loans.firstDueDate') || 'First Due Date'}</Label>
                            <Input
                                type="date"
                                value={form.firstDueDate}
                                onChange={e => setForm(prev => ({ ...prev, firstDueDate: e.target.value }))}
                            />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('loans.notes') || 'Notes'}</Label>
                        <Input
                            value={form.notes}
                            onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        {t('common.cancel') || 'Cancel'}
                    </Button>
                    <Button onClick={submit} disabled={!isValid || isSubmitting}>
                        {t('common.confirm') || 'Confirm'}
                    </Button>
                </DialogFooter>
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
