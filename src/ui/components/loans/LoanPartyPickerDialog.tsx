import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MapPin, Phone, Search, UserRound } from 'lucide-react'

import { type Customer, useCustomers } from '@/local-db'
import type { LoanPartySelection } from '@/lib/loanParties'
import { cn } from '@/lib/utils'
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from '@/ui/components'

interface LoanPartyPickerDialogProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    onSelect: (selection: LoanPartySelection) => void
    selectedPartyId?: string | null
}

function composeAddress(parts: Array<string | null | undefined>) {
    return parts
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(', ')
}

function buildCustomerSelection(customer: Customer): LoanPartySelection {
    return {
        linkedPartyType: 'customer',
        linkedPartyId: customer.id,
        linkedPartyName: customer.name,
        borrowerName: customer.name,
        borrowerPhone: customer.phone?.trim() || '',
        borrowerAddress: composeAddress([customer.address, customer.city, customer.country])
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
    selectedPartyId
}: LoanPartyPickerDialogProps) {
    const { t } = useTranslation()
    const customers = useCustomers(workspaceId)
    const [search, setSearch] = useState('')

    useEffect(() => {
        if (!isOpen) {
            return
        }

        setSearch('')
    }, [isOpen])

    const normalizedQuery = search.trim().toLowerCase()

    const filteredCustomers = useMemo(() => {
        if (!normalizedQuery) {
            return customers
        }

        return customers.filter((customer) =>
            [customer.name, customer.phone, customer.email, customer.address, customer.city, customer.country]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .some((value) => value.toLowerCase().includes(normalizedQuery))
        )
    }, [customers, normalizedQuery])

    const handleCustomerSelect = (customer: Customer) => {
        onSelect(buildCustomerSelection(customer))
        onOpenChange(false)
    }

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{t('loans.selectParty', { defaultValue: 'Customer' })}</DialogTitle>
                    <DialogDescription>{t('loans.selectPartyDescription', { defaultValue: 'Choose an existing customer to fill the borrower details and mark who this loan belongs to.' })}</DialogDescription>
                </DialogHeader>

                <div className="relative">
                    <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        className="ps-9"
                        placeholder={t('loans.searchPartyPlaceholder', { defaultValue: 'Search customers...' })}
                    />
                </div>

                <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
                    {filteredCustomers.length === 0 ? (
                        <div className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
                            {t('loans.noPartyResults', { defaultValue: 'No matching customers found.' })}
                        </div>
                    ) : filteredCustomers.map((customer) => (
                        <CustomerListItem
                            key={customer.id}
                            icon={<UserRound className="h-4 w-4" />}
                            name={customer.name}
                            phone={customer.phone}
                            address={composeAddress([customer.address, customer.city, customer.country])}
                            isActive={selectedPartyId === customer.id}
                            onClick={() => handleCustomerSelect(customer)}
                        />
                    ))}
                </div>

                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common.cancel')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
