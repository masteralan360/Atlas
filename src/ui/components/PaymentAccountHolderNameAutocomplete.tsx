import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    isLoading?: boolean
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
    required = false,
    isLoading = false
}: PaymentAccountHolderNameAutocompleteProps) {
    const [isFocused, setIsFocused] = useState(false)
    const [justSelected, setJustSelected] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const pendingOpenRef = useRef(false)
    const hadFocusRef = useRef(false)
    const restoredFocusRef = useRef(false)
    const wasLoadingRef = useRef(isLoading)
    const isDisabled = Boolean(disabled || isLoading)

    const query = value.trim().toLocaleLowerCase()
    const filteredSuggestions = useMemo(() => (
        suggestions
            .filter((name) => !query || name.toLocaleLowerCase().includes(query))
            .slice(0, 8)
    ), [query, suggestions])
    const showDropdown = isFocused && !justSelected && filteredSuggestions.length > 0

    const handleSelect = useCallback((name: string) => {
        hadFocusRef.current = false
        setJustSelected(true)
        setIsFocused(false)
        onSelect(name)
    }, [onSelect])

    useEffect(() => {
        if (!justSelected) return
        const timeout = window.setTimeout(() => setJustSelected(false), 200)
        return () => window.clearTimeout(timeout)
    }, [justSelected])

    useEffect(() => {
        if (isLoading && !wasLoadingRef.current && hadFocusRef.current) {
            pendingOpenRef.current = true
            setIsFocused(false)
        }

        if (!isLoading && wasLoadingRef.current && pendingOpenRef.current) {
            pendingOpenRef.current = false
            if (!disabled) {
                setIsFocused(true)
                restoredFocusRef.current = true
                inputRef.current?.focus()
            }
        }

        wasLoadingRef.current = isLoading
    }, [disabled, isLoading])

    return (
        <AutocompletePopover
            open={showDropdown}
            onOpenChange={(open) => {
                if (!open && !isLoading) hadFocusRef.current = false
                setIsFocused(open)
            }}
            anchor={(
                <div data-autocomplete-popover-anchor className={cn('w-full', className)}>
                    <Input
                        ref={inputRef}
                        id={id}
                        value={value}
                        required={required}
                        aria-invalid={isInvalid}
                        autoComplete="name"
                        placeholder={placeholder}
                        disabled={isDisabled}
                        aria-busy={isLoading || undefined}
                        className={inputClassName}
                        onChange={(event) => {
                            setJustSelected(false)
                            onChange(event.target.value)
                        }}
                        onFocus={() => {
                            hadFocusRef.current = true
                            setIsFocused(true)
                            if (restoredFocusRef.current) {
                                restoredFocusRef.current = false
                            } else {
                                onFocus?.()
                            }
                        }}
                        onBlur={() => {
                            if (!isLoading) hadFocusRef.current = false
                            onBlur?.()
                        }}
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
