import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import type { BusinessPartner, BusinessPartnerRole, CurrencyCode } from '@/local-db'
import {
    Button,
    Dialog,
    DialogContent,
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
    Textarea
} from '@/ui/components'

type BusinessPartnerFormState = {
    name: string
    contactName: string
    email: string
    phone: string
    address: string
    city: string
    country: string
    defaultCurrency: CurrencyCode
    notes: string
    creditLimit: string
    role: BusinessPartnerRole
}

const DEFAULT_ROLE: BusinessPartnerRole = 'both'

function createEmptyState(defaultCurrency: CurrencyCode, role: BusinessPartnerRole): BusinessPartnerFormState {
    return {
        name: '',
        contactName: '',
        email: '',
        phone: '',
        address: '',
        city: '',
        country: '',
        defaultCurrency,
        notes: '',
        creditLimit: '',
        role
    }
}

function mapPartnerToState(partner: BusinessPartner): BusinessPartnerFormState {
    return {
        name: partner.name,
        contactName: partner.contactName || '',
        email: partner.email || '',
        phone: partner.phone || '',
        address: partner.address || '',
        city: partner.city || '',
        country: partner.country || '',
        defaultCurrency: partner.defaultCurrency,
        notes: partner.notes || '',
        creditLimit: partner.creditLimit ? String(partner.creditLimit) : '',
        role: partner.role
    }
}

export interface BusinessPartnerFormPayload {
    name: string
    contactName?: string
    email?: string
    phone?: string
    address?: string
    city?: string
    country?: string
    defaultCurrency: CurrencyCode
    notes?: string
    creditLimit: number
    role: BusinessPartnerRole
}

interface BusinessPartnerFormDialogProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    partner?: BusinessPartner | null
    defaultCurrency: CurrencyCode
    availableCurrencies: CurrencyCode[]
    initialRole?: BusinessPartnerRole
    isSaving?: boolean
    title?: string
    submitLabel?: string
    onSubmit: (payload: BusinessPartnerFormPayload) => void | Promise<void>
}

export function BusinessPartnerFormDialog({
    isOpen,
    onOpenChange,
    partner,
    defaultCurrency,
    availableCurrencies,
    initialRole = DEFAULT_ROLE,
    isSaving = false,
    title,
    submitLabel,
    onSubmit
}: BusinessPartnerFormDialogProps) {
    const { t } = useTranslation()
    const [formState, setFormState] = useState<BusinessPartnerFormState>(() => createEmptyState(defaultCurrency, initialRole))

    useEffect(() => {
        if (!isOpen) {
            return
        }

        setFormState(
            partner
                ? mapPartnerToState(partner)
                : createEmptyState(defaultCurrency, initialRole)
        )
    }, [defaultCurrency, initialRole, isOpen, partner])

    async function handleSubmit(event: FormEvent) {
        event.preventDefault()
        await onSubmit({
            name: formState.name.trim(),
            contactName: formState.contactName.trim() || undefined,
            email: formState.email.trim() || undefined,
            phone: formState.phone.trim() || undefined,
            address: formState.address.trim() || undefined,
            city: formState.city.trim() || undefined,
            country: formState.country.trim() || undefined,
            defaultCurrency: formState.defaultCurrency,
            notes: formState.notes.trim() || undefined,
            creditLimit: Number(formState.creditLimit || 0),
            role: formState.role
        })
    }

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-0.75rem)] w-[calc(100vw-0.75rem)] max-w-2xl flex-col overflow-hidden rounded-[1.25rem] border-border/60 p-0 sm:w-full sm:max-h-[min(calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),820px)] sm:rounded-[1.75rem]">
                <DialogHeader className="border-b bg-muted/30 px-4 py-4 pr-14 text-left sm:px-6 sm:py-5">
                    <DialogTitle className="text-xl">
                        {title || (partner
                            ? (t('businessPartners.editPartner') || 'Edit Business Partner')
                            : (t('businessPartners.addPartner') || 'Add Business Partner'))}
                    </DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="business-partner-name">{t('suppliers.form.name') || 'Company Name'} <span className="text-destructive">*</span></Label>
                                <Input
                                    id="business-partner-name"
                                    value={formState.name}
                                    onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))}
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="business-partner-contact">{t('suppliers.form.contactName') || 'Contact Name'}</Label>
                                <Input
                                    id="business-partner-contact"
                                    value={formState.contactName}
                                    onChange={(event) => setFormState((current) => ({ ...current, contactName: event.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="business-partner-email">{t('customers.form.email') || 'Email'}</Label>
                                <Input
                                    id="business-partner-email"
                                    type="email"
                                    value={formState.email}
                                    onChange={(event) => setFormState((current) => ({ ...current, email: event.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="business-partner-phone">{t('customers.form.phone') || 'Phone'}</Label>
                                <Input
                                    id="business-partner-phone"
                                    value={formState.phone}
                                    onChange={(event) => setFormState((current) => ({ ...current, phone: event.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>{t('businessPartners.form.role') || 'Role'}</Label>
                                <Select value={formState.role} onValueChange={(value) => setFormState((current) => ({ ...current, role: value as BusinessPartnerRole }))}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="both">{t('businessPartners.roles.both') || 'Both'}</SelectItem>
                                        <SelectItem value="customer">{t('customers.title') || 'Customer'}</SelectItem>
                                        <SelectItem value="supplier">{t('suppliers.title') || 'Supplier'}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label>{t('customers.form.defaultCurrency') || 'Default Currency'}</Label>
                                <Select value={formState.defaultCurrency} onValueChange={(value) => setFormState((current) => ({ ...current, defaultCurrency: value as CurrencyCode }))}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {availableCurrencies.map((currency) => (
                                            <SelectItem key={currency} value={currency}>
                                                {currency.toUpperCase()}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="business-partner-city">{t('customers.form.city') || 'City'}</Label>
                                <Input
                                    id="business-partner-city"
                                    value={formState.city}
                                    onChange={(event) => setFormState((current) => ({ ...current, city: event.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="business-partner-country">{t('customers.form.country') || 'Country'}</Label>
                                <Input
                                    id="business-partner-country"
                                    value={formState.country}
                                    onChange={(event) => setFormState((current) => ({ ...current, country: event.target.value }))}
                                />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="business-partner-address">{t('customers.form.address') || 'Address'}</Label>
                                <Input
                                    id="business-partner-address"
                                    value={formState.address}
                                    onChange={(event) => setFormState((current) => ({ ...current, address: event.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="business-partner-credit-limit">{t('customers.form.creditLimit') || 'Credit Limit'}</Label>
                                <Input
                                    id="business-partner-credit-limit"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={formState.creditLimit}
                                    onChange={(event) => setFormState((current) => ({ ...current, creditLimit: event.target.value }))}
                                />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="business-partner-notes">{t('customers.form.notes') || 'Notes'}</Label>
                                <Textarea
                                    id="business-partner-notes"
                                    rows={4}
                                    value={formState.notes}
                                    onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
                                />
                            </div>
                        </div>
                    </div>

                    <DialogFooter className="border-t bg-muted/20 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-between sm:px-6">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button type="submit" className="w-full sm:w-auto" disabled={isSaving}>
                            {isSaving
                                ? (t('common.loading') || 'Loading...')
                                : (submitLabel || (partner ? (t('common.save') || 'Save') : (t('common.create') || 'Create')))}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
