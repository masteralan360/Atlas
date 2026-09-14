import { useCallback, useEffect, useMemo, useState } from 'react'
import { UserRound } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Input } from '@/ui/components/input'
import { AutocompletePopover } from '@/ui/components/AutocompletePopover'

interface PaymentAccountHolderNameAutocompleteProps {
    id: string
    value: string
    suggestions: string[]
    onChange: (value: string) => void
    onSelect: (name: string) => void
    onFocus?: () => void
    onBlur?: () => void
    placeholder?: string
    className?: string
    inputClassName?: string
    isInvalid?: boolean
    disabled?: boolean
    required?: boolean
}

export function PaymentAccountHolderNameAutocomplete({
    id,
    value,
    suggestions,
    onChange,
    onSelect,
    onFocus,
    onBlur,
    placeholder,
    className,
    inputClassName,
    isInvalid = false,
    disabled,
    required = false
}: PaymentAccountHolderNameAutocompleteProps) {
    const [isFocused, setIsFocused] = useState(false)
    const [justSelected, setJustSelected] = useState(false)

    const query = value.trim().toLocaleLowerCase()
    const filteredSuggestions = useMemo(() => (
        suggestions
            .filter((name) => !query || name.toLocaleLowerCase().includes(query))
            .slice(0, 8)
    ), [query, suggestions])
    const showDropdown = isFocused && !justSelected && filteredSuggestions.length > 0

    const handleSelect = useCallback((name: string) => {
        setJustSelected(true)
        setIsFocused(false)
        onSelect(name)
    }, [onSelect])

    useEffect(() => {
        if (!justSelected) return
        const timeout = window.setTimeout(() => setJustSelected(false), 200)
        return () => window.clearTimeout(timeout)
    }, [justSelected])

    return (
        <AutocompletePopover
            open={showDropdown}
            onOpenChange={setIsFocused}
            anchor={(
                <div data-autocomplete-popover-anchor className={cn('w-full', className)}>
                    <Input
                        id={id}
                        value={value}
                        required={required}
                        aria-invalid={isInvalid}
                        autoComplete="name"
                        placeholder={placeholder}
                        disabled={disabled}
                        className={inputClassName}
                        onChange={(event) => {
                            setJustSelected(false)
                            onChange(event.target.value)
                        }}
                        onFocus={() => {
                            setIsFocused(true)
                            onFocus?.()
                        }}
                        onBlur={onBlur}
                    />
                </div>
            )}
        >
            <div className="rounded-xl border bg-popover shadow-lg">
                    {filteredSuggestions.map((name) => (
                        <button
                            key={name}
                            type="button"
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-start text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                            onMouseDown={(event) => {
                                event.preventDefault()
                                handleSelect(name)
                            }}
                        >
                            <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                        </button>
                    ))}
                </div>
        </AutocompletePopover>
    )
}
