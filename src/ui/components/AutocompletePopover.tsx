import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'

interface AutocompletePopoverProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    anchor: ReactNode
    children: ReactNode
    className?: string
}

/**
 * A shared autocomplete list surface that stays attached to its field while
 * avoiding every edge of the visible window.
 */
export function AutocompletePopover({
    open,
    onOpenChange,
    anchor,
    children,
    className
}: AutocompletePopoverProps) {
    const isAnchorInteraction = (target: EventTarget | null) => (
        target instanceof Element && Boolean(target.closest('[data-autocomplete-popover-anchor]'))
    )

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverAnchor asChild>{anchor}</PopoverAnchor>
            {open ? (
                <PopoverContent
                    align="start"
                    side="bottom"
                    sideOffset={4}
                    collisionPadding={8}
                    sticky="always"
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    // The custom anchor is not a Radix PopoverTrigger, so it
                    // must be explicitly treated as part of this interaction.
                    // Otherwise focusing the input again is immediately
                    // interpreted as leaving the popover.
                    onPointerDownOutside={(event) => {
                        if (isAnchorInteraction(event.target)) {
                            event.preventDefault()
                        }
                    }}
                    onFocusOutside={(event) => {
                        if (isAnchorInteraction(event.target)) {
                            event.preventDefault()
                        }
                    }}
                    className={cn(
                        'z-[60] max-h-[min(14rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-content-available-width)] overflow-y-auto p-0',
                        className
                    )}
                >
                    {children}
                </PopoverContent>
            ) : null}
        </Popover>
    )
}
