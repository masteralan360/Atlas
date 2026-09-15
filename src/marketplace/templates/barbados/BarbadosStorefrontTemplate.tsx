import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Coffee, Search, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn, formatCurrency } from '@/lib/utils'

import { usePageMeta } from '../../hooks/usePageMeta'
import { MarketplaceVirtualGrid } from '../../components/MarketplaceVirtualGrid'
import { useStoreCatalog } from '../../hooks/useStoreCatalog'
import { getMarketplaceAssetUrl } from '../../lib/assets'
import { StoreQrDialog } from '../../components/StoreQrDialog'
import type { MarketplaceCategory, MarketplaceProduct } from '../../lib/marketplaceApi'
import type { StorefrontTemplate, StorefrontTemplatePageProps } from '../types'

function getProductPrice(product: MarketplaceProduct) {
    return typeof product.discount_price === 'number' && product.discount_price < product.price
        ? product.discount_price
        : product.price
}

function BarbadosLoadingState() {
    return (
        <div
            className="h-dvh overflow-x-hidden overflow-y-auto overscroll-y-contain bg-[#1c0e07] text-[#fff4e9]"
            style={{ colorScheme: 'dark' }}
        >
            <header className="border-b border-[#f5bc24]/55 bg-[#2a160d]">
                <div className="mx-auto flex max-w-[1640px] items-center gap-4 px-5 py-5 sm:px-8 lg:px-10">
                    <div className="h-12 w-12 animate-pulse rounded-full bg-[#563222]" />
                    <div className="space-y-2">
                        <div className="h-4 w-24 animate-pulse rounded bg-[#563222]" />
                        <div className="h-3 w-16 animate-pulse rounded bg-[#563222]" />
                    </div>
                    <div className="ms-auto hidden h-11 w-[42%] animate-pulse rounded-xl bg-[#3b2116] md:block" />
                </div>
            </header>
            <main className="mx-auto max-w-[1640px] px-5 py-8 sm:px-8 lg:px-10">
                <div className="h-[246px] animate-pulse rounded-[2rem] bg-[#382015]" />
                <div className="mt-8 flex gap-3 overflow-hidden">
                    {Array.from({ length: 6 }).map((_, index) => (
                        <div key={index} className="h-12 w-32 shrink-0 animate-pulse rounded-2xl bg-[#382015]" />
                    ))}
                </div>
                <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {Array.from({ length: 12 }).map((_, index) => (
                        <div key={index} className="overflow-hidden rounded-[1.5rem] border border-[#623926] bg-[#331b10]">
                            <div className="aspect-[1.34] animate-pulse bg-[#563222]" />
                            <div className="space-y-3 p-5">
                                <div className="h-5 w-2/3 animate-pulse rounded bg-[#563222]" />
                                <div className="h-4 w-full animate-pulse rounded bg-[#563222]" />
                                <div className="h-4 w-20 animate-pulse rounded bg-[#563222]" />
                            </div>
                        </div>
                    ))}
                </div>
            </main>
        </div>
    )
}

function BarbadosMenuCard({
    product,
    iqdPreference,
    hidePrice
}: {
    product: MarketplaceProduct
    hidePrice: boolean
    iqdPreference: 'IQD' | 'د.ع'
}) {
    const imageUrl = getMarketplaceAssetUrl(product.image_url)
    const [hasImageError, setHasImageError] = useState(false)
    const hasDiscount = typeof product.discount_price === 'number' && product.discount_price < product.price

    useEffect(() => {
        setHasImageError(false)
    }, [imageUrl])

    return (
        <article className="group overflow-hidden rounded-[1.5rem] border border-[#623926] bg-[#331b10] shadow-[0_18px_30px_rgba(8,3,1,0.18)] transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-1 hover:border-[#bd7c35] hover:shadow-[0_26px_44px_rgba(8,3,1,0.32)]">
            <div className="relative aspect-[1.34] overflow-hidden bg-[#563222]">
                {imageUrl && !hasImageError ? (
                    <img
                        src={imageUrl}
                        alt={product.name}
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                        loading="lazy"
                        onError={() => setHasImageError(true)}
                    />
                ) : (
                    <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_50%_25%,#86512d,transparent_28%),linear-gradient(145deg,#4e2a1a,#241109)] text-[#f4bb24]">
                        <Coffee className="h-12 w-12 opacity-85" />
                    </div>
                )}
            </div>

            <div className="p-3 sm:p-5">
                <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <h2 className="line-clamp-2 text-[13px] font-bold leading-[1.35] tracking-[-0.01em] text-[#fff4e9] sm:text-[17px] sm:leading-6">
                        {product.name}
                    </h2>
                    {!hidePrice && <div className="shrink-0 text-right">
                        {hasDiscount && (
                            <p className="mb-1 text-[11px] text-[#b99e89] line-through">
                                {formatCurrency(product.price, product.currency, iqdPreference)}
                            </p>
                        )}
                        <p className="text-[13px] font-extrabold text-[#f5bc24] sm:text-[14px]">
                            {formatCurrency(getProductPrice(product), product.currency, iqdPreference)}
                        </p>
                    </div>}
                </div>
                {product.description && (
                    <p className="mt-2 line-clamp-2 min-h-8 text-[12px] leading-[1.35] text-[#cdb8a7] sm:mt-3 sm:min-h-10 sm:text-[13px] sm:leading-5">
                        {product.description}
                    </p>
                )}
            </div>
        </article>
    )
}

function BarbadosMenuPage({ slug, rules }: StorefrontTemplatePageProps) {
    const { t, i18n } = useTranslation()
    const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [hasHeroImageError, setHasHeroImageError] = useState(false)
    const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null)
    const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase())
    const { catalog, isLoading, isLoadingMore, hasMore, error, loadMoreError, loadMore } = useStoreCatalog(slug, {
        search: deferredSearch,
        categoryId: activeCategoryId
    })
    const iqdPreference: 'IQD' | 'د.ع' = i18n.language === 'en' ? 'IQD' : 'د.ع'

    const hidePrice = rules.hidePrice === true
    const categories = useMemo<MarketplaceCategory[]>(() => catalog?.categories ?? [], [catalog?.categories])

    useEffect(() => {
        setActiveCategoryId((currentCategoryId) => {
            if (currentCategoryId && categories.some((category) => category.id === currentCategoryId)) {
                return currentCategoryId
            }

            return null
        })
    }, [categories])

    const displayedProducts = catalog?.products ?? []

    const storeName = catalog?.store.name || 'Barbados'
    const storeDescription = catalog?.store.description || t('marketplace.storeSubtitle', {
        defaultValue: 'Browse the menu and find something you will enjoy.'
    })
    const logoUrl = getMarketplaceAssetUrl(catalog?.store.logo_url)
    const heroImageUrl = getMarketplaceAssetUrl(catalog?.products.find((product) => product.image_url)?.image_url)
    const activeCategoryName = activeCategoryId
        ? categories.find((category) => category.id === activeCategoryId)?.name
        : undefined

    useEffect(() => {
        setHasHeroImageError(false)
    }, [heroImageUrl])

    useEffect(() => {
        scrollParent?.scrollTo({ top: 0, behavior: 'auto' })
    }, [activeCategoryId, deferredSearch, scrollParent])

    usePageMeta(storeName, storeDescription)

    if (isLoading) {
        return <BarbadosLoadingState />
    }

    if (error || !catalog) {
        return (
            <div
                className="flex h-dvh overflow-x-hidden overflow-y-auto overscroll-y-contain bg-[#1c0e07] px-5 text-center text-[#fff4e9]"
                style={{ colorScheme: 'dark' }}
            >
                <div className="max-w-md rounded-[1.5rem] border border-[#623926] bg-[#331b10] p-8 shadow-2xl shadow-black/25">
                    <Store className="mx-auto h-8 w-8 text-[#f5bc24]" />
                    <h1 className="mt-4 text-2xl font-bold">
                        {t('marketplace.storeNotFound', { defaultValue: 'Store not found' })}
                    </h1>
                    <p className="mt-3 text-sm leading-6 text-[#cdb8a7]">
                        {error || t('marketplace.storeNotFoundHint', { defaultValue: 'This menu is currently unavailable.' })}
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div
            ref={setScrollParent}
            className="h-dvh overflow-x-hidden overflow-y-auto overscroll-y-contain bg-[#1c0e07] text-[#fff4e9]"
            style={{ colorScheme: 'dark', fontFamily: 'Geist Variable, Inter, sans-serif' }}
        >
            <header className="sticky top-0 z-20 border-b border-[#f5bc24]/65 bg-[#2a160d] shadow-[0_8px_22px_rgba(15,5,1,0.22)]">
                <div className="mx-auto flex max-w-[1640px] flex-wrap items-center gap-4 px-5 py-4 sm:px-8 lg:flex-nowrap lg:px-10">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#f5bc24]/75 bg-[#1b0d07] text-sm font-black text-[#f5bc24]">
                            {logoUrl ? (
                                <img src={logoUrl} alt="" className="h-full w-full object-contain p-1" />
                            ) : (
                                storeName.slice(0, 1).toUpperCase()
                            )}
                        </div>
                        <div className="min-w-0">
                            <p className="truncate text-lg font-extrabold tracking-[-0.02em]">{storeName}</p>
                            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#f5bc24]">
                                {t('marketplace.menu', { defaultValue: 'Menu' })}
                            </p>
                        </div>
                    </div>

                    <label className="order-3 flex h-12 w-full items-center gap-3 rounded-xl border border-[#623926] bg-[#3a2116] px-4 text-[#f5bc24] transition-colors focus-within:border-[#d99a35] lg:order-none lg:mx-auto lg:max-w-[670px]">
                        <Search className="h-5 w-5 shrink-0" />
                        <span className="sr-only">{t('marketplace.searchCollection', { defaultValue: 'Search menu' })}</span>
                        <input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('marketplace.searchCollection', { defaultValue: 'Search the menu...' })}
                            className="h-full min-w-0 flex-1 bg-transparent text-sm text-[#fff4e9] outline-none placeholder:text-[#a98f7e]"
                        />
                    </label>

                    <StoreQrDialog
                        name={storeName}
                        slug={slug}
                        logoUrl={logoUrl}
                        tone="dark"
                        className="ms-auto h-12 shrink-0 rounded-xl border-[#623926] bg-[#3a2116] text-[#f5bc24] hover:bg-[#4a2a1a] hover:text-[#f5bc24] lg:ms-0"
                    />
                </div>
            </header>

            <main className="mx-auto max-w-[1640px] px-5 py-8 pb-16 sm:px-8 lg:px-10 lg:py-9">
                <section className="relative overflow-hidden rounded-[2rem] border border-[#623926] bg-[#331b10]">
                    <div className="relative z-10 grid min-h-[254px] items-stretch lg:grid-cols-[minmax(0,1.3fr)_minmax(330px,0.7fr)]">
                        <div className="flex flex-col justify-center p-7 sm:p-10">
                            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#f5bc24]">
                                {t('marketplace.menu', { defaultValue: 'Menu' })}
                            </p>
                            <h1 className="mt-4 max-w-xl font-serif text-4xl font-semibold leading-[1.05] tracking-[-0.03em] text-[#fff4e9] sm:text-5xl">
                                {t('marketplace.browseMenuTitle', { defaultValue: 'Good drinks, simply listed.' })}
                            </h1>
                            <p className="mt-4 max-w-xl text-sm leading-6 text-[#cdb8a7] sm:text-base">
                                {storeDescription}
                            </p>

                        </div>

                        <div className="relative min-h-[190px] border-t border-[#623926] lg:border-s lg:border-t-0">
                            {heroImageUrl && !hasHeroImageError ? (
                                <img
                                    src={heroImageUrl}
                                    alt=""
                                    className="absolute inset-0 h-full w-full object-cover"
                                    onError={() => setHasHeroImageError(true)}
                                />
                            ) : (
                                <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_25%,#86512d,transparent_22%),linear-gradient(140deg,#5a301c,#271208)]" />
                            )}
                            <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(51,27,16,0.12),rgba(29,14,7,0.32))]" />
                        </div>
                    </div>
                </section>

                {categories.length > 0 && (
                    <nav aria-label={t('marketplace.categories', { defaultValue: 'Menu catalogs' })} className="-mx-5 mt-7 flex gap-3 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
                        <button
                            type="button"
                            onClick={() => setActiveCategoryId(null)}
                            aria-pressed={activeCategoryId === null}
                            className={cn(
                                'h-12 shrink-0 rounded-2xl border px-5 text-sm font-bold transition-colors',
                                activeCategoryId === null
                                    ? 'border-[#f5bc24] bg-[#f5bc24] text-[#261206]'
                                    : 'border-[#623926] bg-[#331b10] text-[#e8d6c7] hover:border-[#bd7c35] hover:text-[#fff4e9]'
                            )}
                        >
                            {t('common.all', { defaultValue: 'All' })}
                        </button>
                        {categories.map((category) => {
                            const isActive = category.id === activeCategoryId

                            return (
                                <button
                                    key={category.id}
                                    type="button"
                                    onClick={() => setActiveCategoryId(category.id)}
                                    aria-pressed={isActive}
                                    className={cn(
                                        'h-12 shrink-0 rounded-2xl border px-5 text-sm font-bold transition-colors',
                                        isActive
                                            ? 'border-[#f5bc24] bg-[#f5bc24] text-[#261206]'
                                            : 'border-[#623926] bg-[#331b10] text-[#e8d6c7] hover:border-[#bd7c35] hover:text-[#fff4e9]'
                                    )}
                                >
                                    {category.name}
                                </button>
                            )
                        })}
                    </nav>
                )}

                <section className="mt-10">
                    <div className="mb-6 flex items-end justify-between gap-5">
                        <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#f5bc24]">
                                {activeCategoryName || t('marketplace.menu', { defaultValue: 'Menu' })}
                            </p>
                            <h2 className="mt-2 font-serif text-3xl font-semibold tracking-[-0.02em] text-[#fff4e9] sm:text-4xl">
                                {activeCategoryName || t('marketplace.menuitems', { defaultValue: 'All Menu Items' })}
                            </h2>
                        </div>
                        <p className="hidden text-sm text-[#b99e89] sm:block">
                            {catalog.total_products} {t('marketplace.products', { defaultValue: 'items' }).toLowerCase()}
                        </p>
                    </div>

                    {displayedProducts.length === 0 ? (
                        <div className="rounded-[1.5rem] border border-dashed border-[#79452d] bg-[#331b10] px-6 py-16 text-center text-[#cdb8a7]">
                            <Coffee className="mx-auto h-8 w-8 text-[#f5bc24]" />
                            <p className="mt-3 text-sm font-semibold">
                                {search
                                    ? t('marketplace.noProducts', { defaultValue: 'No menu items match your search.' })
                                    : t('marketplace.noProducts', { defaultValue: 'No menu items in this catalog yet.' })}
                            </p>
                        </div>
                    ) : (
                        <>
                            {scrollParent && (
                                <MarketplaceVirtualGrid
                                    items={displayedProducts}
                                    itemKey={(product) => product.id}
                                    renderItem={(product) => (
                                        <BarbadosMenuCard
                                            product={product}
                                            iqdPreference={iqdPreference}
                                            hidePrice={hidePrice}
                                        />
                                    )}
                                    listClassName="mx-auto grid w-full max-w-md grid-cols-1 gap-3 sm:mx-0 sm:max-w-none sm:grid-cols-2 sm:gap-5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                                    rowClassName="pb-3 sm:pb-5"
                                    gridColumns={[
                                        { minWidth: 0, columns: 1 },
                                        { minWidth: 640, columns: 2 },
                                        { minWidth: 768, columns: 3 },
                                        { minWidth: 1024, columns: 4 },
                                        { minWidth: 1280, columns: 5 }
                                    ]}
                                    onEndReached={loadMore}
                                    hasMore={hasMore}
                                    isLoadingMore={isLoadingMore}
                                    useWindowScroll={false}
                                    customScrollParent={scrollParent}
                                />
                            )}
                            {isLoadingMore && <p className="py-5 text-center text-sm text-[#b99e89]">{t('marketplace.loadingMore')}</p>}
                            {loadMoreError && (
                                <div className="flex flex-col items-center gap-3 py-5 text-center">
                                    <p className="text-sm text-[#f8b4a8]">{t('marketplace.loadingMoreFailed')}</p>
                                    <button
                                        type="button"
                                        onClick={loadMore}
                                        className="rounded-xl border border-[#bd7c35] px-4 py-2 text-sm font-semibold text-[#f5bc24] hover:bg-[#3a2116]"
                                    >
                                        {t('common.retry')}
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </section>
            </main>
        </div>
    )
}

export const barbadosStorefrontTemplate = {
    id: 'barbados',
    label: 'Barbados menu',
    ShopPage: BarbadosMenuPage,
    ContactPage: BarbadosMenuPage
} satisfies StorefrontTemplate
