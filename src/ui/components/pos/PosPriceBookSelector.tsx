import { useTranslation } from 'react-i18next'
import { BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/ui/components/select'
import type { PriceBook } from '@/local-db'
import { PriceBookName } from '@/ui/components/PriceBookName'

interface PosPriceBookSelectorProps {
    priceBooks: PriceBook[]
    selectedPriceBookId: string
    onSelect: (priceBookId: string) => void
    className?: string
}

const NONE_OPTION = '__none__'

/**
 * POS Price Book selector. "Default pricing" means products use their base
 * (storage/batch) price instead of a Price Book override.
 */
export function PosPriceBookSelector({
    priceBooks,
    selectedPriceBookId,
    onSelect,
    className,
}: PosPriceBookSelectorProps) {
    const { t } = useTranslation()

    return (
        <Select value={selectedPriceBookId || NONE_OPTION} onValueChange={(value) => onSelect(value === NONE_OPTION ? '' : value)}>
            <SelectTrigger className={cn("w-[180px] bg-background/50 backdrop-blur-sm", className)}>
                <div className="flex items-center gap-2 truncate">
                    <BookOpen className={cn("w-4 h-4 shrink-0", selectedPriceBookId ? "text-amber-500" : "text-muted-foreground")} />
                    <SelectValue placeholder={t('pos.priceBookSelect') || "Price Book"} />
                </div>
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    <SelectLabel>{t('priceBooks.title', { defaultValue: 'Price Books' })}</SelectLabel>
                    <SelectItem value={NONE_OPTION}>
                        {t('pos.priceBookNone', { defaultValue: 'Default pricing' })}
                    </SelectItem>
                    {priceBooks.map((priceBook) => (
                        <SelectItem key={priceBook.id} value={priceBook.id}>
                            <span className="flex items-center gap-2">
                                <BookOpen className="w-3.5 h-3.5 text-amber-500" />
                                <PriceBookName name={priceBook.name} color={priceBook.color} />
                            </span>
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    )
}
