import { Link } from 'wouter'
import { ArrowRight, Package2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent } from '@/ui/components'
import type { MarketplaceStoreSummary } from '../lib/marketplaceApi'
import { StoreAvatar } from './StoreAvatar'
import { StoreQrDialog } from './StoreQrDialog'

type StoreCardProps = {
    store: MarketplaceStoreSummary
    index: number
}

export function StoreCard({ store, index }: StoreCardProps) {
    const { t } = useTranslation()
    const storeHref = `/s/${store.slug}`

    return (
        <Card
            className="group h-full overflow-hidden border-border/60 bg-card/85 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_24px_60px_rgba(15,23,42,0.12)]"
            style={{ animationDelay: `${index * 70}ms` }}
        >
            <CardContent className="flex h-full flex-col gap-5 p-5">
                <div className="flex items-start justify-between gap-4">
                    <StoreAvatar
                        logoUrl={store.logo_url}
                        name={store.name}
                        className="h-16 w-16"
                    />
                    <div className="rounded-full border border-border/60 bg-background/80 px-3 py-1 text-xs font-semibold text-muted-foreground">
                        {store.product_count} {t('marketplace.products', { defaultValue: 'products' })}
                    </div>
                </div>

                <div className="space-y-2">
                    <h2 className="text-xl font-black tracking-tight">{store.name}</h2>
                    <p className="line-clamp-3 min-h-[3.75rem] text-sm leading-6 text-muted-foreground">
                        {store.description || t('marketplace.defaultStoreDescription', { defaultValue: 'Browse the public catalog and send an inquiry order directly to this store.' })}
                    </p>
                </div>

                <div className="mt-auto flex items-center justify-between gap-3">
                    <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                        <Package2 className="h-3.5 w-3.5" />
                        {store.category_count} {t('marketplace.categories', { defaultValue: 'categories' })}
                    </div>
                    <div className="flex items-center gap-2">
                        <StoreQrDialog
                            name={store.name}
                            slug={store.slug}
                            logoUrl={store.logo_url}
                        />
                        <Link
                            href={storeHref}
                            className="inline-flex items-center gap-2 text-sm font-semibold text-primary transition-colors hover:text-primary/80"
                        >
                            <span>{t('marketplace.visitStore', { defaultValue: 'Visit Store' })}</span>
                            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                        </Link>
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}
