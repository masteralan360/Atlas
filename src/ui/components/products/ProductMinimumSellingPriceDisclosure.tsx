import type { ReactNode } from 'react'
import { DollarSign, Eye, EyeOff } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/ui/components/button'
import { Label } from '@/ui/components/label'
import { NumericInput } from '@/ui/components/ui/numeric-input'

interface ProductMinimumSellingPriceDisclosureProps {
    enabled: boolean
    open: boolean
    onOpenChange: (open: boolean) => void
    value: string
    onValueChange: (value: string) => void
    currencySymbol: string
    readOnly: boolean
    minimumPriceLabel: string
    invalidLabel: string
    showLabel: string
    hideLabel: string
    children: (toggleButton: ReactNode) => ReactNode
}

/** Adds an on-demand minimum-price field and its attached selling-price control. */
export function ProductMinimumSellingPriceDisclosure({
    enabled,
    open,
    onOpenChange,
    value,
    onValueChange,
    currencySymbol,
    readOnly,
    minimumPriceLabel,
    invalidLabel,
    showLabel,
    hideLabel,
    children
}: ProductMinimumSellingPriceDisclosureProps) {
    const hasValue = value.trim() !== ''
    const minimumValue = Number(value)
    const isInvalid = hasValue && (!Number.isFinite(minimumValue) || minimumValue < 0)
    const toggleLabel = open ? hideLabel : showLabel

    const toggleButton = enabled ? (
        <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-12 w-11 shrink-0 rounded-s-none rounded-e-xl border-s-0 bg-background p-0 hover:bg-muted/70"
            aria-label={toggleLabel}
            aria-expanded={open}
            aria-controls="product-minimum-selling-price"
            title={toggleLabel}
            onClick={() => onOpenChange(!open)}
        >
            {open ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
    ) : null

    return (
        <>
            {children(toggleButton)}
            {enabled && open ? (
                <div className="space-y-2 pt-2">
                    <Label htmlFor="product-minimum-selling-price" className="flex items-center gap-2 font-bold">
                        <DollarSign className="h-4 w-4 text-primary/60" />
                        {minimumPriceLabel}
                    </Label>
                    <div className="relative">
                        <NumericInput
                            id="product-minimum-selling-price"
                            value={value}
                            onValueChange={onValueChange}
                            maxFractionDigits={4}
                            placeholder="0"
                            readOnly={readOnly}
                            aria-invalid={isInvalid}
                            aria-describedby={isInvalid ? 'product-minimum-selling-price-error' : undefined}
                            className={cn(
                                'h-11 rounded-xl border-border/80 bg-background/80 pe-16 font-bold tabular-nums shadow-sm transition-all hover:border-primary/45 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50',
                                isInvalid && 'border-destructive bg-destructive/5 text-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'
                            )}
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">
                            {currencySymbol}
                        </span>
                    </div>
                    {isInvalid ? (
                        <p id="product-minimum-selling-price-error" role="alert" className="text-xs font-medium text-destructive">
                            {invalidLabel}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </>
    )
}
