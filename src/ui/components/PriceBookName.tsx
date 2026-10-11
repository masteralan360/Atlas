import { cn } from '@/lib/utils'
import { isValidPriceBookColor } from '@/lib/priceBookColor'

interface PriceBookNameProps {
    name: string
    color?: string | null
    className?: string
    nameClassName?: string
}

export function PriceBookName({ name, color, className, nameClassName }: PriceBookNameProps) {
    return (
        <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
            {isValidPriceBookColor(color) ? (
                <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/15"
                    style={{ backgroundColor: color }}
                />
            ) : null}
            <span className={cn('min-w-0', nameClassName)}>{name}</span>
        </span>
    )
}
