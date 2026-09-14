import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'

import { useBusinessPartners, type BusinessPartner, type BusinessPartnerRole } from '@/local-db'
import { Input } from '@/ui/components'
import { cn } from '@/lib/utils'
import { AutocompletePopover } from '@/ui/components/AutocompletePopover'

interface PartnerAutocompleteInputProps {
    value: string
    onChange: (value: string) => void
    onSelectPartner: (partner: BusinessPartner) => void
    workspaceId: string
    placeholder?: string
    className?: string
    disabled?: boolean
    required?: boolean
    includeRealEstateRoles?: boolean
    includeAgentRoles?: boolean
    /** When agent roles are included, limits them to these eligible agent partners. */
    eligibleAgentPartnerIds?: string[]
    excludePartnerIds?: string[]
    roles?: BusinessPartnerRole[]
}

export function PartnerAutocompleteInput({
    value,
    onChange,
    onSelectPartner,
    workspaceId,
    placeholder,
    className,
    disabled,
    required,
    includeRealEstateRoles = false,
    includeAgentRoles = false,
    eligibleAgentPartnerIds,
    excludePartnerIds = [],
    roles
}: PartnerAutocompleteInputProps) {
    const { t } = useTranslation()
    const partners = useBusinessPartners(workspaceId, { includeRealEstateRoles, includeAgentRoles, roles })
    const [isFocused, setIsFocused] = useState(false)
    const [justSelected, setJustSelected] = useState(false)

    const query = value.trim().toLowerCase()
    const excludedPartnerIds = useMemo(() => new Set(excludePartnerIds.filter(Boolean)), [excludePartnerIds])
    const eligibleAgentPartnerIdSet = useMemo(
        () => eligibleAgentPartnerIds === undefined ? null : new Set(eligibleAgentPartnerIds.filter(Boolean)),
        [eligibleAgentPartnerIds]
    )

    const filtered = useMemo(() => {
        if (!query || query.length < 1) return []
        return partners
            .filter((p) => !excludedPartnerIds.has(p.id))
            .filter((p) => p.role !== 'agent' || !eligibleAgentPartnerIdSet || eligibleAgentPartnerIdSet.has(p.id))
            .filter((p) => p.partnerName.toLowerCase().includes(query))
            .slice(0, 8)
    }, [eligibleAgentPartnerIdSet, excludedPartnerIds, partners, query])

    const showDropdown = isFocused && !justSelected && filtered.length > 0

    const handleSelect = useCallback((partner: BusinessPartner) => {
        setJustSelected(true)
        setIsFocused(false)
        onChange(partner.partnerName)
        onSelectPartner(partner)
    }, [onChange, onSelectPartner])

    useEffect(() => {
        if (justSelected) {
            const timeout = setTimeout(() => setJustSelected(false), 200)
            return () => clearTimeout(timeout)
        }
    }, [justSelected])

    return (
        <AutocompletePopover
            open={showDropdown}
            onOpenChange={setIsFocused}
            anchor={(
                <div data-autocomplete-popover-anchor className={cn('w-full', className)}>
                    <Input
                        value={value}
                        onChange={(e) => {
                            setJustSelected(false)
                            onChange(e.target.value)
                        }}
                        onFocus={() => setIsFocused(true)}
                        placeholder={placeholder}
                        disabled={disabled}
                        required={required}
                        className="flex-1"
                    />
                </div>
            )}
        >
            <div className="rounded-xl border bg-popover shadow-lg">
                    {filtered.map((partner) => (
                        <button
                            key={partner.id}
                            type="button"
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                            onMouseDown={(e) => {
                                e.preventDefault()
                                handleSelect(partner)
                            }}
                        >
                            <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">{partner.partnerName}</div>
                                {partner.phone ? (
                                    <div className="truncate text-xs text-muted-foreground">{partner.phone}</div>
                                ) : null}
                            </div>
                            <span className="shrink-0 rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {partner.role === 'both'
                                    ? t('businessPartners.roles.both', { defaultValue: 'Both' })
                                    : partner.role === 'supplier'
                                        ? t('suppliers.title', { defaultValue: 'Supplier' })
                                        : partner.role === 'buyer'
                                            ? t('businessPartners.roles.buyer', { defaultValue: 'Buyer' })
                                            : partner.role === 'seller'
                                                ? t('businessPartners.roles.seller', { defaultValue: 'Seller' })
                                                : partner.role === 'agent'
                                                    ? t('businessPartners.roles.agent', { defaultValue: 'Agent' })
                                                    : partner.role === 'online_customer'
                                                        ? t('businessPartners.roles.onlineCustomer', { defaultValue: 'Online Customer' })
                                                : t('customers.title', { defaultValue: 'Customer' })}
                            </span>
                        </button>
                    ))}
                </div>
        </AutocompletePopover>
    )
}
