import { Plus } from 'lucide-react'

import { Button } from '@/ui/components/button'
import { cn } from '@/lib/utils'

export interface PartnerCreationTriggerProps {
    onClick: () => void
    label: string
    disabled?: boolean
    className?: string
}

/** Compact plus button attached to the start of a partner autocomplete field. */
export function PartnerCreationTrigger({ onClick, label, disabled, className }: PartnerCreationTriggerProps) {
    return (
        <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn('h-8 w-8 shrink-0 rounded-e-none rounded-s-lg border-e-0 bg-background p-0 hover:bg-muted/70', className)}
            aria-label={label}
            title={label}
            onClick={onClick}
            disabled={disabled}
        >
            <Plus className="h-4 w-4" />
        </Button>
    )
}
