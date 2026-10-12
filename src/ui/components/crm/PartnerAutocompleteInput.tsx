import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, UserRound, Users } from 'lucide-react'

import { cacheBusinessPartnerAutocompleteSelection, searchBusinessPartnerAutocompleteSuggestions } from '@/local-db/businessPartners'
import type { BusinessPartner, BusinessPartnerRole } from '@/local-db/models'
import { useAuth } from '@/auth/AuthContext'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Input } from '@/ui/components'
import { cn } from '@/lib/utils'
import { AutocompletePopover } from '@/ui/components/AutocompletePopover'
import { useDebouncedAutocompleteSearch } from '@/ui/components/useDebouncedAutocompleteSearch'

export interface PartnerAutocompleteAdditionalOption {
    id: string
    label: string
    description?: string
    badgeLabel?: string
}

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
    additionalOptions?: PartnerAutocompleteAdditionalOption[]
    onSelectAdditionalOption?: (option: PartnerAutocompleteAdditionalOption) => void
    /** Restrict suggestions to this caller's eligible records, while searching the data source. */
    partnerOptions?: BusinessPartner[]
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
    roles,
    additionalOptions = [],
    onSelectAdditionalOption,
    partnerOptions
}: PartnerAutocompleteInputProps) {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { hasCapability } = useWorkspace()
    const [isFocused, setIsFocused] = useState(false)
    const [justSelected, setJustSelected] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const query = value.trim()
    const normalizedQuery = query.toLocaleLowerCase()
    const rolesKey = roles?.join('|') ?? ''
    const normalizedRoles = useMemo(
        () => rolesKey ? rolesKey.split('|') as BusinessPartnerRole[] : undefined,
        [rolesKey]
    )
    const excludedPartnerIds = useMemo(() => new Set(excludePartnerIds.filter(Boolean)), [excludePartnerIds])
    const partnerOptionIds = useMemo(
        () => partnerOptions ? new Set(partnerOptions.map((partner) => partner.id)) : null,
        [partnerOptions]
    )
    const eligibleAgentPartnerIdSet = useMemo(
        () => eligibleAgentPartnerIds === undefined ? null : new Set(eligibleAgentPartnerIds.filter(Boolean)),
        [eligibleAgentPartnerIds]
    )
    const allowedPartnerIds = useMemo(
        () => partnerOptionIds ? [...partnerOptionIds] : undefined,
        [partnerOptionIds]
    )
    const searchConstraints = useMemo(() => ({
        allowedPartnerIds,
        excludedPartnerIds: [...excludedPartnerIds],
        eligibleAgentPartnerIds: eligibleAgentPartnerIdSet ? [...eligibleAgentPartnerIdSet] : undefined,
    }), [allowedPartnerIds, eligibleAgentPartnerIdSet, excludedPartnerIds])
    const viewer = useMemo(() => ({
        userId: user?.id,
        role: user?.role,
        featureEnabled: hasCapability('businessPartnerGroupPrivacy'),
    }), [hasCapability, user?.id, user?.role])
    const searchOptions = useMemo(() => ({
        roles: normalizedRoles,
        includeRealEstateRoles,
        includeAgentRoles,
        includeEcommerce: true,
    }), [includeAgentRoles, includeRealEstateRoles, normalizedRoles])
    const searchPartners = useCallback((search: string) => (
        searchBusinessPartnerAutocompleteSuggestions(workspaceId, search, searchOptions, viewer, searchConstraints)
    ), [searchConstraints, searchOptions, viewer, workspaceId])
    const remoteSearch = useDebouncedAutocompleteSearch(
        query,
        isFocused && !justSelected && Boolean(workspaceId),
        searchPartners,
        250,
        3,
    )
    const partners = remoteSearch.items
    const isSearchLoading = remoteSearch.isLoading
    const searchError = remoteSearch.error

    const filtered = useMemo(() => {
        const eligiblePartners = partners
            .filter((p) => !partnerOptionIds || partnerOptionIds.has(p.id))
            .filter((p) => !excludedPartnerIds.has(p.id))
            .filter((p) => p.role !== 'agent' || !eligibleAgentPartnerIdSet || eligibleAgentPartnerIdSet.has(p.id))
        if (normalizedQuery.length < 3) return []
        return eligiblePartners
            .slice(0, 8)
    }, [eligibleAgentPartnerIdSet, excludedPartnerIds, normalizedQuery, partnerOptionIds, partners])

    const filteredAdditionalOptions = useMemo(() => {
        if (normalizedQuery.length < 1) return []
        return additionalOptions
            .filter((option) => `${option.label} ${option.description || ''}`.toLocaleLowerCase().includes(normalizedQuery))
            .slice(0, 8)
    }, [additionalOptions, normalizedQuery])

    const showDropdown = isFocused && !justSelected && (
        isSearchLoading
        || Boolean(searchError)
        || filtered.length > 0
        || filteredAdditionalOptions.length > 0
        || (Boolean(workspaceId) && normalizedQuery.length >= 3)
    )

    const handleSelect = useCallback((partner: BusinessPartner) => {
        void cacheBusinessPartnerAutocompleteSelection(partner).catch((error) => {
            console.error('[BusinessPartners] Failed to cache selected autocomplete result:', error)
        })
        setJustSelected(true)
        setIsFocused(false)
        onChange(partner.partnerName)
        onSelectPartner(partner)
    }, [onChange, onSelectPartner])

    const handleSelectAdditionalOption = useCallback((option: PartnerAutocompleteAdditionalOption) => {
        setJustSelected(true)
        setIsFocused(false)
        onChange(option.label)
        onSelectAdditionalOption?.(option)
    }, [onChange, onSelectAdditionalOption])

    useEffect(() => {
        if (justSelected) {
            const timeout = setTimeout(() => setJustSelected(false), 200)
            return () => clearTimeout(timeout)
        }
    }, [justSelected])

    return (
        <AutocompletePopover
            open={showDropdown}
            onOpenChange={(open) => {
                setIsFocused(open)
            }}
            anchor={(
                <div data-autocomplete-popover-anchor className={cn('w-full', className)}>
                    <Input
                        ref={inputRef}
                        value={value}
                        onChange={(e) => {
                            setJustSelected(false)
                            onChange(e.target.value)
                        }}
                        onFocus={() => {
                            setIsFocused(true)
                        }}
                        placeholder={placeholder}
                        disabled={Boolean(disabled)}
                        aria-busy={isSearchLoading || undefined}
                        required={required}
                        className="flex-1"
                    />
                </div>
            )}
        >
            <div className="rounded-xl border bg-popover shadow-lg">
                    {isSearchLoading ? (
                        <div role="status" className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t('common.autocomplete.searching')}
                        </div>
                    ) : searchError ? (
                        <div role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">
                            {t('common.autocomplete.searchFailed')}
                        </div>
                    ) : null}
                    {filtered.map((partner) => (
                        <button
                            key={`partner:${partner.id}`}
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
                    {filteredAdditionalOptions.map((option) => (
                        <button
                            key={`additional:${option.id}`}
                            type="button"
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                            onMouseDown={(e) => {
                                e.preventDefault()
                                handleSelectAdditionalOption(option)
                            }}
                        >
                            <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">{option.label}</div>
                                {option.description ? (
                                    <div className="truncate text-xs text-muted-foreground">{option.description}</div>
                                ) : null}
                            </div>
                            {option.badgeLabel ? (
                                <span className="shrink-0 rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                    {option.badgeLabel}
                                </span>
                            ) : null}
                        </button>
                    ))}
                    {!isSearchLoading && !searchError && filtered.length === 0 && filteredAdditionalOptions.length === 0 && normalizedQuery.length >= 2 ? (
                        <div role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">
                            {t('common.autocomplete.noResults')}
                        </div>
                    ) : null}
                </div>
        </AutocompletePopover>
    )
}
