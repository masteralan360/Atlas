import { useEffect, useState } from 'react'
import { Package2, Plus } from 'lucide-react'

import { Button, Card, CardContent } from '@/ui/components'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { MarketplaceProduct } from '../lib/marketplaceApi'
import { getMarketplaceProductImageUrl } from '../lib/assets'

type ProductCardProps = {
    product: MarketplaceProduct
    iqdPreference: 'IQD' | 'د.ع'
    addToCartLabel?: string
    onAdd?: (product: MarketplaceProduct) => void
    showPrice?: boolean
    showAddToCart?: boolean
}

export function ProductCard({
    product,
    iqdPreference,
    addToCartLabel,
    onAdd,
    showPrice = true,
    showAddToCart = true
}: ProductCardProps) {
    const resolvedImageUrl = getMarketplaceProductImageUrl(product.image_url)
    const [hasImageError, setHasImageError] = useState(false)
    const hasDiscount = typeof product.discount_price === 'number' && product.discount_price < product.price
    const endsAt = product.discount_ends_at ? new Date(product.discount_ends_at) : null
    const endsSoon = !!endsAt
        && Number.isFinite(endsAt.getTime())
        && endsAt.getTime() > Date.now()
        && endsAt.getTime() - Date.now() <= 7 * 24 * 60 * 60 * 1000
    const discountBadge = hasDiscount
        ? (product.discount_type === 'percentage'
            ? `-${Number(product.discount_value ?? 0)}%`
            : `-${formatCurrency(Number(product.discount_value ?? 0), product.currency, iqdPreference)}`)
        : null

    useEffect(() => {
        setHasImageError(false)
    }, [resolvedImageUrl])

    return (
        <Card className="group h-full overflow-hidden rounded-[2.5rem] border-[#e3e8ef] bg-[#fbfbfd] transition-all duration-300 hover:-translate-y-1 hover:border-[#c9ded9] hover:shadow-[0_24px_60px_rgba(15,23,42,0.10)]">
            <CardContent className="flex h-full flex-col p-4">
                <div className="relative overflow-hidden bg-[#f1f2f4]">
                    <div className="aspect-square">
                        {resolvedImageUrl && !hasImageError ? (
                            <img
                                src={resolvedImageUrl}
                                alt={product.name}
                                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                                loading="lazy"
                                onError={() => setHasImageError(true)}
                            />
                        ) : (
                            <div className="flex h-full items-center justify-center text-muted-foreground">
                                <Package2 className="h-10 w-10 opacity-40" />
                            </div>
                        )}
                    </div>
                    {discountBadge && (
                        <div className="absolute left-3 top-3 rounded-full bg-emerald-500 px-3 py-1 text-xs font-black text-white shadow-md">
                            {discountBadge}
                        </div>
                    )}
                </div>

                <div className="flex flex-1 flex-col border-t border-[#edf0f4] pt-4">
                    <p className="min-h-4 text-[11px] font-black uppercase tracking-[0.18em] text-[#4c5857]">
                        {product.category_name || ''}
                    </p>
                    <h3 className="mt-2 line-clamp-2 min-h-[3.25rem] text-lg font-semibold leading-snug text-[#151b28]">
                        {product.name}
                    </h3>

                    {(showPrice || (showAddToCart && onAdd && addToCartLabel)) && (
                        <div className="mt-auto flex items-end justify-between gap-3 pt-8">
                        {showPrice ? (
                            <div>
                            {hasDiscount ? (
                                <>
                                    <div className="text-xs font-semibold text-muted-foreground line-through">
                                        {formatCurrency(product.price, product.currency, iqdPreference)}
                                    </div>
                                    <div className="text-lg font-black text-emerald-600">
                                        {formatCurrency(product.discount_price!, product.currency, iqdPreference)}
                                    </div>
                                </>
                            ) : (
                                <div className="text-lg font-black text-[#151b28]">
                                    {formatCurrency(product.price, product.currency, iqdPreference)}
                                </div>
                            )}
                                {endsSoon && endsAt && (
                                    <div className="mt-1 text-[11px] font-medium text-amber-600">
                                        Ends {formatDate(endsAt)}
                                    </div>
                                )}
                            </div>
                        ) : <span />}
                        {showAddToCart && onAdd && addToCartLabel && (
                            <Button
                            className="h-9 rounded-full bg-[#d3e7e1] px-5 text-sm font-black text-[#00756f] shadow-none hover:bg-[#c4ded7]"
                                onClick={() => onAdd(product)}
                        >
                            <Plus className="h-4 w-4" />
                            {addToCartLabel}
                            </Button>
                        )}
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}
