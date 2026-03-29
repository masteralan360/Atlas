import { Package2, Plus } from 'lucide-react'

import { Button, Card, CardContent } from '@/ui/components'
import { formatCurrency } from '@/lib/utils'
import type { MarketplaceProduct } from '../lib/marketplaceApi'

type ProductCardProps = {
    product: MarketplaceProduct
    iqdPreference: 'IQD' | 'د.ع'
    addToCartLabel: string
    onAdd: (product: MarketplaceProduct) => void
}

export function ProductCard({ product, iqdPreference, addToCartLabel, onAdd }: ProductCardProps) {
    return (
        <Card className="group h-full overflow-hidden border-border/60 bg-card/85 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_24px_60px_rgba(15,23,42,0.12)]">
            <CardContent className="flex h-full flex-col gap-4 p-4">
                <div className="relative overflow-hidden rounded-[1.5rem] bg-muted/40">
                    <div className="aspect-[4/3]">
                        {product.image_url ? (
                            <img
                                src={product.image_url}
                                alt={product.name}
                                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                            />
                        ) : (
                            <div className="flex h-full items-center justify-center text-muted-foreground">
                                <Package2 className="h-10 w-10 opacity-40" />
                            </div>
                        )}
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="space-y-1">
                        <h3 className="line-clamp-2 text-lg font-bold leading-tight">{product.name}</h3>
                        <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                            {product.sku}
                        </p>
                    </div>

                    <p className="line-clamp-3 min-h-[4.25rem] text-sm leading-6 text-muted-foreground">
                        {product.description || product.unit}
                    </p>
                </div>

                <div className="mt-auto flex items-center justify-between gap-3">
                    <div>
                        <div className="text-xl font-black">
                            {formatCurrency(product.price, product.currency, iqdPreference)}
                        </div>
                        <div className="text-xs text-muted-foreground">{product.unit}</div>
                    </div>
                    <Button className="gap-2 rounded-2xl" onClick={() => onAdd(product)}>
                        <Plus className="h-4 w-4" />
                        {addToCartLabel}
                    </Button>
                </div>
            </CardContent>
        </Card>
    )
}
