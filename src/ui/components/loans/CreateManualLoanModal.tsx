import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, X } from 'lucide-react'
import { useAuth } from '@/auth'
import { createManualLoan, type CurrencyCode, type InstallmentFrequency } from '@/local-db'
import { getLoanLinkedPartyTypeLabel, type LoanPartySelection } from '@/lib/loanParties'
import {
    Dialog,
    DialogContent,
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
    useToast
} from '@/ui/components'
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
    const [isSaving, setIsSaving] = useState(false)
    const [borrowerName, setBorrowerName] = useState('')
    const [borrowerPhone, setBorrowerPhone] = useState('')
    const [borrowerAddress, setBorrowerAddress] = useState('')
    const [borrowerNationalId, setBorrowerNationalId] = useState('')
    const [selectedParty, setSelectedParty] = useState<LoanPartySelection | null>(null)
    const [isPartyPickerOpen, setIsPartyPickerOpen] = useState(false)
    const [principalAmount, setPrincipalAmount] = useState('')
    const [installmentCount, setInstallmentCount] = useState(1)
    const [installmentFrequency, setInstallmentFrequency] = useState<InstallmentFrequency>('monthly')
    const [firstDueDate, setFirstDueDate] = useState(new Date().toISOString().slice(0, 10))
    const [notes, setNotes] = useState('')

    useEffect(() => {
        if (!isOpen) return
        setBorrowerName('')
        setBorrowerPhone('')
        setBorrowerAddress('')
        setBorrowerNationalId('')
        setSelectedParty(null)
        setIsPartyPickerOpen(false)
        setPrincipalAmount('')
        setInstallmentCount(1)
        setInstallmentFrequency('monthly')
        setFirstDueDate(new Date().toISOString().slice(0, 10))
        setNotes('')
    }, [isOpen])

    const canSubmit = borrowerName.trim() &&
        borrowerPhone.trim() &&
        borrowerAddress.trim() &&
        borrowerNationalId.trim() &&
        Number(principalAmount) > 0 &&
        installmentCount > 0 &&
        firstDueDate

    const handlePartySelect = (selection: LoanPartySelection) => {
        setSelectedParty(selection)
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
                principalAmount: Number(principalAmount),
                settlementCurrency,
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

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t('loans.createManualLoan') || 'Create Manual Loan'}</DialogTitle>
                </DialogHeader>

                <div className="grid gap-4">
                    <div className="grid gap-2">
                        <Label>{t('loans.borrowerName') || 'Borrower Name'}</Label>
                        <div className="flex items-center gap-2">
                            <Input value={borrowerName} onChange={e => setBorrowerName(e.target.value)} className="flex-1" />
                            <Button type="button" variant="outline" className="shrink-0 gap-2" onClick={() => setIsPartyPickerOpen(true)}>
                                <Users className="h-4 w-4" />
                                {t('loans.selectParty', { defaultValue: 'Customer' })}
                            </Button>
                        </div>
                        {selectedParty ? (
                            <div className="flex items-start justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
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

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="grid gap-2">
                            <Label>{t('loans.borrowerPhone') || 'Borrower Phone'}</Label>
                            <Input value={borrowerPhone} onChange={e => setBorrowerPhone(e.target.value)} />
                        </div>
                        <div className="grid gap-2">
                            <Label>{t('loans.borrowerNationalId') || 'Borrower National ID'}</Label>
                            <Input value={borrowerNationalId} onChange={e => setBorrowerNationalId(e.target.value)} />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('loans.borrowerAddress') || 'Borrower Address'}</Label>
                        <Input value={borrowerAddress} onChange={e => setBorrowerAddress(e.target.value)} />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div className="grid gap-2">
                            <Label>{t('loans.principal') || 'Principal'}</Label>
                            <Input
                                type="number"
                                min={0}
                                value={principalAmount}
                                onChange={e => setPrincipalAmount(e.target.value)}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label>{t('loans.installmentCount') || 'Installments'}</Label>
                            <Input
                                type="number"
                                min={1}
                                value={installmentCount}
                                onChange={e => setInstallmentCount(Math.max(1, Number(e.target.value || 1)))}
                            />
                        </div>
                        <div className="grid gap-2">
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
                        <div className="grid gap-2">
                            <Label>{t('loans.firstDueDate') || 'First Due Date'}</Label>
                            <Input type="date" value={firstDueDate} onChange={e => setFirstDueDate(e.target.value)} />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('loans.notes') || 'Notes'}</Label>
                        <Input value={notes} onChange={e => setNotes(e.target.value)} />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
                        {t('common.cancel') || 'Cancel'}
                    </Button>
                    <Button onClick={handleCreate} disabled={!canSubmit || isSaving}>
                        {t('common.create') || 'Create'}
                    </Button>
                </DialogFooter>
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
