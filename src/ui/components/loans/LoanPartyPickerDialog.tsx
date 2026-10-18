import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MapPin, Phone, Plus, Search, UserRound } from 'lucide-react'

import { createBusinessPartner, type BusinessPartner, type BusinessPartnerRole, type CurrencyCode, useBusinessPartners } from '@/local-db'
import type { LoanPartySelection } from '@/lib/loanParties'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Input } from '@/ui/components/input'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useToast,
} from '@/ui/components'
import { BusinessPartnerFormDialog, type BusinessPartnerFormPayload } from '@/ui/components/crm/BusinessPartnerFormDialog'

interface LoanPartyPickerDialogProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    onSelect: (selection: LoanPartySelection) => void
    selectedPartyId?: string | null
    roles?: BusinessPartnerRole[]
    copy?: {
        title: string
        description: string
        searchPlaceholder: string
        noResultsMessage: string
    }
}

function composeAddress(parts: Array<string | null | undefined>) {
    return parts
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(', ')
}

function buildPartnerSelection(partner: BusinessPartner): LoanPartySelection {
    return {
        linkedPartyType: 'business_partner',
        linkedPartyId: partner.id,
        linkedPartyName: partner.partnerName,
        defaultCurrency: partner.defaultCurrency,
        borrowerName: partner.partnerName,
        borrowerPhone: partner.phone?.trim() || '',
        borrowerAddress: composeAddress([partner.address, partner.city])
    }
}

function CustomerListItem({
    icon,
    name,
    phone,
    address,
    isActive,
    onClick
}: {
    icon: ReactNode
    name: string
    phone?: string
    address?: string
    isActive: boolean
    onClick: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'w-full rounded-xl border p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5',
                isActive ? 'border-primary bg-primary/5' : 'border-border bg-background'
            )}
        >
            <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-muted p-2 text-muted-foreground">
                    {icon}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                    <div className="font-semibold leading-none">{name}</div>
                    {phone ? (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Phone className="h-3.5 w-3.5" />
                            <span className="truncate">{phone}</span>
                        </div>
                    ) : null}
                    {address ? (
                        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span className="line-clamp-2">{address}</span>
                        </div>
                    ) : null}
                </div>
            </div>
        </button>
    )
}

export function LoanPartyPickerDialog({
    isOpen,
    onOpenChange,
    workspaceId,
    onSelect,
    selectedPartyId,
    roles,
    copy
}: LoanPartyPickerDialogProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { features } = useWorkspace()
    const businessPartners = useBusinessPartners(workspaceId, { roles })
    const [search, setSearch] = useState('')
    const [isCreateOpen, setIsCreateOpen] = useState(false)
    const [isSavingPartner, setIsSavingPartner] = useState(false)

    const availableCurrencies = useMemo(() => {
        return Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[]
    }, [features.allowed_currencies, features.default_currency])

    useEffect(() => {
        if (!isOpen) {
            return
        }

        setSearch('')
    }, [isOpen])

    const normalizedQuery = search.trim().toLowerCase()

    const filteredPartners = useMemo(() => {
        if (!normalizedQuery) {
            return businessPartners
        }

        return businessPartners.filter((partner) =>
            [partner.partnerName, partner.phone, partner.address, partner.city]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .some((value) => value.toLowerCase().includes(normalizedQuery))
        )
    }, [businessPartners, normalizedQuery])

    const handlePartnerSelect = (partner: BusinessPartner) => {
        onSelect(buildPartnerSelection(partner))
        onOpenChange(false)
    }

    const handleCreatePartner = async (payload: BusinessPartnerFormPayload) => {
        setIsSavingPartner(true)
        try {
            const partner = await createBusinessPartner(workspaceId, payload)
            toast({ title: t('businessPartners.messages.addSuccess', { defaultValue: 'Business partner created successfully' }) })
            setIsCreateOpen(false)
            handlePartnerSelect(partner)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || 'Failed to create business partner',
                variant: 'destructive'
            })
        } finally {
            setIsSavingPartner(false)
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{copy?.title ?? t('loans.selectParty', { defaultValue: 'Business Partner' })}</DialogTitle>
                    <DialogDescription>{copy?.description ?? t('loans.selectPartyDescription', { defaultValue: 'Choose an existing business partner to fill the borrower details and mark who this loan belongs to.' })}</DialogDescription>
                </DialogHeader>

                <div className="flex gap-2">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            className="ps-9"
                            placeholder={copy?.searchPlaceholder ?? t('loans.searchPartyPlaceholder', { defaultValue: 'Search business partners...' })}
                        />
                    </div>
                    <Button type="button" onClick={() => setIsCreateOpen(true)} className="shrink-0">
                        <Plus className="mr-2 h-4 w-4" />
                        <span className="hidden sm:inline">{t('businessPartners.addPartner', { defaultValue: 'Create Business Partner' })}</span>
                        <span className="sm:hidden">{t('common.create', { defaultValue: 'Create' })}</span>
                    </Button>
                </div>

                <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
                    {filteredPartners.length === 0 ? (
                        <div className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
                            {copy?.noResultsMessage ?? t('loans.noPartyResults', { defaultValue: 'No matching business partners found.' })}
                        </div>
                    ) : filteredPartners.map((partner) => (
                        <CustomerListItem
                            key={partner.id}
                            icon={<UserRound className="h-4 w-4" />}
                            name={partner.partnerName}
                            phone={partner.phone}
                            address={composeAddress([partner.address, partner.city])}
                            isActive={selectedPartyId === partner.id}
                            onClick={() => handlePartnerSelect(partner)}
                        />
                    ))}
                </div>

                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common.cancel')}
                    </Button>
                </DialogFooter>
            </DialogContent>

            <BusinessPartnerFormDialog
                isOpen={isCreateOpen}
                onOpenChange={setIsCreateOpen}
                defaultCurrency={features.default_currency}
                availableCurrencies={availableCurrencies}
                isSaving={isSavingPartner}
                onSubmit={handleCreatePartner}
            />
        </Dialog>
    )
}
