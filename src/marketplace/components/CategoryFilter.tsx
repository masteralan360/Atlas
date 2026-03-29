import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import type { MarketplaceCategory } from '../lib/marketplaceApi'

type CategoryFilterProps = {
    categories: MarketplaceCategory[]
    selectedCategoryId: string | null
    onSelect: (categoryId: string | null) => void
}

export function CategoryFilter({ categories, selectedCategoryId, onSelect }: CategoryFilterProps) {
    const { t } = useTranslation()

    return (
        <div className="overflow-x-auto pb-2">
            <div className="flex min-w-max items-center gap-2">
                <button
                    type="button"
                    onClick={() => onSelect(null)}
                    className={cn(
                        'rounded-full border px-4 py-2 text-sm font-semibold transition-colors',
                        selectedCategoryId === null
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border/60 bg-card/70 text-muted-foreground hover:text-foreground'
                    )}
                >
                    {t('marketplace.allCategories', { defaultValue: 'All' })}
                </button>
                {categories.map((category) => (
                    <button
                        key={category.id}
                        type="button"
                        onClick={() => onSelect(category.id)}
                        className={cn(
                            'rounded-full border px-4 py-2 text-sm font-semibold transition-colors',
                            selectedCategoryId === category.id
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border/60 bg-card/70 text-muted-foreground hover:text-foreground'
                        )}
                    >
                        {category.name}
                    </button>
                ))}
            </div>
        </div>
    )
}
