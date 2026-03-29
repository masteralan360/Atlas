import { useDeferredValue, useState } from 'react'
import { Search, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent, Input } from '@/ui/components'

import { MarketplaceLayout } from '../components/MarketplaceLayout'
import { StoreCard } from '../components/StoreCard'
import { useMarketplaceStores } from '../hooks/useMarketplaceStores'
import { usePageMeta } from '../hooks/usePageMeta'

export function MarketplaceGallery() {
    const { t } = useTranslation()
    const { stores, isLoading, error } = useMarketplaceStores()
    const [search, setSearch] = useState('')
    const deferredSearch = useDeferredValue(search.trim().toLowerCase())

    const filteredStores = deferredSearch
        ? stores.filter((store) => `${store.name} ${store.description || ''}`.toLowerCase().includes(deferredSearch))
        : stores

    usePageMeta(
        t('marketplace.title', { defaultValue: 'Atlas Marketplace' }),
        t('marketplace.subtitle', { defaultValue: 'Discover stores across Iraq' })
    )

    return (
        <MarketplaceLayout
            title={t('marketplace.title', { defaultValue: 'Atlas Marketplace' })}
            subtitle={t('marketplace.subtitle', { defaultValue: 'Discover stores across Iraq' })}
        >
            <section className="space-y-6">
                <Card className="border-border/60 bg-card/80 shadow-[0_24px_80px_rgba(15,23,42,0.06)]">
                    <CardContent className="p-4 sm:p-5">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={t('marketplace.searchStores', { defaultValue: 'Search stores...' })}
                                className="h-12 rounded-2xl border-border/60 bg-background/80 pl-11"
                            />
                        </div>
                    </CardContent>
                </Card>

                {isLoading ? (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {Array.from({ length: 6 }).map((_, index) => (
                            <Card key={index} className="overflow-hidden border-border/60 bg-card/70">
                                <CardContent className="space-y-4 p-5">
                                    <div className="h-16 w-16 animate-pulse rounded-3xl bg-muted" />
                                    <div className="space-y-2">
                                        <div className="h-6 w-3/4 animate-pulse rounded bg-muted" />
                                        <div className="h-4 w-full animate-pulse rounded bg-muted" />
                                        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                ) : error ? (
                    <Card className="border-destructive/20 bg-destructive/5">
                        <CardContent className="p-6 text-sm text-destructive">
                            {error}
                        </CardContent>
                    </Card>
                ) : filteredStores.length === 0 ? (
                    <Card className="border-border/60 bg-card/80">
                        <CardContent className="flex flex-col items-center justify-center gap-3 p-10 text-center">
                            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                                <Store className="h-6 w-6" />
                            </div>
                            <div className="space-y-1">
                                <h2 className="text-xl font-black">
                                    {t('marketplace.noStores', { defaultValue: 'No stores found' })}
                                </h2>
                                <p className="text-sm text-muted-foreground">
                                    {t('marketplace.noStoresHint', { defaultValue: 'Try a different search or check back after more stores publish their catalog.' })}
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {filteredStores.map((store, index) => (
                            <StoreCard key={store.slug} store={store} index={index} />
                        ))}
                    </div>
                )}
            </section>
        </MarketplaceLayout>
    )
}
