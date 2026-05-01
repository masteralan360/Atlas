import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'

import { useBusinessPartners, type BusinessPartner } from '@/local-db'
import { Input } from '@/ui/components'
import { cn } from '@/lib/utils'

interface PartnerAutocompleteInputProps {
    value: string
    onChange: (value: string) => void
    onSelectPartner: (partner: BusinessPartner) => void
    workspaceId: string
    placeholder?: string
    className?: string
    disabled?: boolean
}

export function PartnerAutocompleteInput({
    value,
    onChange,
    onSelectPartner,
    workspaceId,
    placeholder,
    className,
    disabled
}: PartnerAutocompleteInputProps) {
    const { t } = useTranslation()
    const partners = useBusinessPartners(workspaceId) || []
    const [isFocused, setIsFocused] = useState(false)
    const [justSelected, setJustSelected] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    const query = value.trim().toLowerCase()

    const filtered = useMemo(() => {
        if (!query || query.length < 1) return []
        return partners
            .filter((p) => p.name.toLowerCase().includes(query))
            .slice(0, 8)
    }, [partners, query])

    const showDropdown = isFocused && !justSelected && filtered.length > 0

    const handleSelect = useCallback((partner: BusinessPartner) => {
        setJustSelected(true)
        onSelectPartner(partner)
        onChange(partner.name)
    }, [onChange, onSelectPartner])

    useEffect(() => {
        if (justSelected) {
            const timeout = setTimeout(() => setJustSelected(false), 200)
            return () => clearTimeout(timeout)
        }
    }, [justSelected])

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsFocused(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    return (
        <div ref={containerRef} className={cn('relative w-full', className)}>
            <Input
                value={value}
                onChange={(e) => {
                    setJustSelected(false)
                    onChange(e.target.value)
                }}
                onFocus={() => setIsFocused(true)}
                placeholder={placeholder}
                disabled={disabled}
                className="flex-1"
            />
            {showDropdown ? (
                <div className="absolute left-0 right-0 top-full z-[100] mt-1 max-h-56 overflow-y-auto rounded-xl border bg-popover shadow-lg">
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
                                <div className="truncate font-medium">{partner.name}</div>
                                {partner.phone ? (
                                    <div className="truncate text-xs text-muted-foreground">{partner.phone}</div>
                                ) : null}
                            </div>
                            <span className="shrink-0 rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {partner.role === 'both'
                                    ? t('businessPartners.roles.both', { defaultValue: 'Both' })
                                    : partner.role === 'supplier'
                                        ? t('suppliers.title', { defaultValue: 'Supplier' })
                                        : t('customers.title', { defaultValue: 'Customer' })}
                            </span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
