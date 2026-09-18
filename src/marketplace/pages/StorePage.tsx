import { useDeferredValue, useEffect, useState } from 'react'
import { Link } from 'wouter'
import { Banknote, Grid2X2, Minus, Search, Sparkles, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
    Button,
    Card,
    CardContent,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    useToast
} from '@/ui/components'
import { cn, formatCurrency } from '@/lib/utils'

import { CartDrawer } from '../components/CartDrawer'
import { CheckoutForm } from '../components/CheckoutForm'
import { MobileStoreCart } from '../components/MobileStoreCart'
import { MarketplaceVirtualGrid } from '../components/MarketplaceVirtualGrid'
import { OrderConfirmation } from '../components/OrderConfirmation'
import { ProductCard } from '../components/ProductCard'
import { StoreAvatar } from '../components/StoreAvatar'
import { StorefrontLayout } from '../components/StorefrontLayout'
import { StoreQrDialog } from '../components/StoreQrDialog'
import { useCart } from '../hooks/useCart'
import { usePageMeta } from '../hooks/usePageMeta'
import { useStoreCatalog } from '../hooks/useStoreCatalog'
import { getMarketplaceProductImageUrl } from '../lib/assets'
import { placeInquiryOrder, type MarketplaceProduct } from '../lib/marketplaceApi'
import { getEffectiveStorefrontRules } from '../templates/rules'
import type { StorefrontRules } from '../templates/types'

type PriceFilter = 'all' | 'under-threshold'
type SortMode = 'featured' | 'newest'

function normalizeCurrency(currency?: string | null) {
    return (currency || 'usd').trim().toLowerCase()
}

function getUnderPriceThreshold(currency?: string | null) {
    return normalizeCurrency(currency) === 'iqd' ? 50000 : 50
}

function formatThresholdLabel(amount: number, currency?: string | null) {
    const normalizedCurrency = normalizeCurrency(currency)
    if (normalizedCurrency === 'iqd') {
        return formatCurrency(amount, normalizedCurrency, 'IQD')
    }

    if (normalizedCurrency === 'usd') {
        return `$${amount}`
    }

    return `${amount.toLocaleString('en-US')} ${normalizedCurrency.toUpperCase()}`
}

function getInitialSortMode(): SortMode {
    if (typeof window === 'undefined') return 'featured'
    return new URLSearchParams(window.location.search).get('sort') === 'new' ? 'newest' : 'featured'
}

type StorePageProps = {
    storeSlug: string
    rules?: StorefrontRules
}

export function StorePage({ storeSlug, rules = {} }: StorePageProps) {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const [search, setSearch] = useState('')
    const [priceFilter, setPriceFilter] = useState<PriceFilter>('all')
    const [sortMode, setSortMode] = useState<SortMode>(getInitialSortMode)
    const [knownStoreCurrency, setKnownStoreCurrency] = useState('usd')
    const [cartOpen, setCartOpen] = useState(false)
    const [checkoutMode, setCheckoutMode] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [confirmation, setConfirmation] = useState<{ orderNumber: string; phone: string } | null>(null)
    const deferredSearch = useDeferredValue(search.trim().toLowerCase())
    const { catalog, isLoading, isLoadingMore, hasMore, error, loadMoreError, loadMore } = useStoreCatalog(storeSlug, {
        search: deferredSearch,
        sort: sortMode,
        priceMax: priceFilter === 'under-threshold' ? getUnderPriceThreshold(knownStoreCurrency) : undefined,
        currency: priceFilter === 'under-threshold' ? knownStoreCurrency : undefined
    })
    const cart = useCart(storeSlug)
    const syncCatalog = cart.syncCatalog
    const iqdPreference: 'IQD' | 'د.ع' = i18n.language === 'en' ? 'IQD' : 'د.ع'
    const storeCurrency = catalog?.store.currency || knownStoreCurrency
    const underPriceThreshold = getUnderPriceThreshold(storeCurrency)
    const underPriceLabel = formatThresholdLabel(underPriceThreshold, storeCurrency)
    const effectiveRules = getEffectiveStorefrontRules(rules, catalog?.store.workspace_id)
    const hidePrice = effectiveRules.hidePrice === true
    const hideAddToCart = effectiveRules.hideAddToCart === true
    const hideCheckoutEmail = effectiveRules.hideCheckoutEmail === true
    const hideFilters = effectiveRules.hideFilters === true

    useEffect(() => {
        if (catalog) {
            syncCatalog(catalog.products)
            setKnownStoreCurrency(catalog.store.currency || 'usd')
        }
    }, [catalog, syncCatalog])

    useEffect(() => {
        window.scrollTo({ top: 0, behavior: 'auto' })
    }, [deferredSearch, priceFilter, sortMode])

    const closeCart = () => {
        setCartOpen(false)
        setCheckoutMode(false)
    }

    const displayedProducts = catalog?.products ?? []

    const formatMoney = (amount: number, currency: string) => formatCurrency(amount, currency, iqdPreference)

    usePageMeta(
        catalog?.store.name || t('marketplace.title', { defaultValue: 'Atlas Marketplace' }),
        catalog?.store.description || t('marketplace.subtitle', { defaultValue: 'Discover stores across Iraq' })
    )

    const handleShopClick = () => {
        setSortMode('featured')
        setPriceFilter('all')
        window.history.replaceState(null, '', `/s/${storeSlug}`)
    }

    const handleNewArrivalsClick = () => {
        setSortMode('newest')
        window.history.replaceState(null, '', `/s/${storeSlug}?sort=new`)
    }

    const handleAddToCart = (product: MarketplaceProduct) => {
        const result = cart.addItem(product)

        if (!result.ok && result.reason === 'mixed-currency') {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('marketplace.mixedCurrency', {
                    defaultValue: 'This store currently supports inquiry orders with one currency per cart.'
                }),
                variant: 'destructive'
            })
            return
        }

        setCartOpen(true)
    }

    const handleSubmitOrder = async (customer: {
        name: string
        phone: string
        email?: string
        city?: string
        address?: string
        notes?: string
    }) => {
        if (!catalog || cart.items.length === 0) {
            return
        }

        setSubmitting(true)
        try {
            const response = await placeInquiryOrder({
                store_slug: catalog.store.slug,
                customer,
                items: cart.items.map((item) => ({
                    product_id: item.product_id,
                    quantity: item.quantity
                })),
                lang: (i18n.language || 'en') as 'en' | 'ar' | 'ku'
            })

            cart.clearCart()
            closeCart()
            setConfirmation({
                orderNumber: response.order_number,
                phone: customer.phone
            })

            toast({
                title: t('marketplace.confirmation.title', { defaultValue: 'Order Submitted!' }),
                description: response.message
            })
        } catch (submitError) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: submitError instanceof Error ? submitError.message : 'Failed to submit order',
                variant: 'destructive'
            })
        } finally {
            setSubmitting(false)
        }
    }

    const storeName = catalog?.store.name || t('marketplace.storeTitle', { defaultValue: 'Store' })
    const storeDescription = catalog?.store.description || t('marketplace.storeSubtitle', { defaultValue: 'Browse products and send an inquiry order directly to the store.' })

    return (
        <StorefrontLayout
            storeName={storeName}
            storeSlug={storeSlug}
            activeItem={sortMode === 'newest' ? 'new-arrivals' : 'shop'}
            cartCount={cart.itemCount}
            showCart={!hideAddToCart}
            onCartClick={() => setCartOpen(true)}
            onShopClick={handleShopClick}
            onNewArrivalsClick={handleNewArrivalsClick}
        >
            {isLoading ? (
                <div className="mx-auto grid max-w-[1180px] gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
                    <div className="h-[520px] animate-pulse rounded-[2.5rem] border border-[#e3e8ef] bg-white" />
                    <div className="space-y-6">
                        <div className="h-32 animate-pulse rounded-[2.5rem] border border-[#e3e8ef] bg-white" />
                        <div className="h-16 animate-pulse rounded-[2rem] border border-[#e3e8ef] bg-white" />
                        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                            {Array.from({ length: 6 }).map((_, index) => (
                                <div key={index} className="h-[360px] animate-pulse rounded-[2.5rem] border border-[#e3e8ef] bg-white" />
                            ))}
                        </div>
                    </div>
                </div>
            ) : error || !catalog ? (
                <Card className="mx-auto max-w-2xl border-destructive/20 bg-destructive/5">
                    <CardContent className="space-y-4 p-6">
                        <div className="flex items-center gap-3 text-destructive">
                            <Store className="h-5 w-5" />
                            <h2 className="text-xl font-black">
                                {t('marketplace.storeNotFound', { defaultValue: 'Store not found' })}
                            </h2>
                        </div>
                        <p className="text-sm text-muted-foreground">{error || t('marketplace.storeNotFoundHint', { defaultValue: 'This store may be private or the link may be incorrect.' })}</p>
                        <Link href="/" className="inline-flex text-sm font-semibold text-primary hover:underline">
                            {t('marketplace.backToMarketplace', { defaultValue: 'Back to Marketplace' })}
                        </Link>
                    </CardContent>
                </Card>
            ) : (
                <div className={cn(
                    'mx-auto max-w-[1180px] gap-6 max-sm:pb-40',
                    hideFilters ? 'w-full' : 'grid lg:grid-cols-[220px_minmax(0,1fr)]'
                )}>
                    {!hideFilters && <aside className="rounded-[2.5rem] border border-[#e3e8ef] bg-[#fbfbfd] p-6 lg:min-h-[660px]">
                        <div className="flex h-full flex-col">
                            <div>
                                <h2 className="text-xl font-bold text-[#151b28]">
                                    {t('marketplace.filters', { defaultValue: 'Filters' })}
                                </h2>
                                <p className="mt-1 text-sm text-[#4d5856]">
                                    {t('marketplace.refineSelection', { defaultValue: 'Refine your selection' })}
                                </p>
                            </div>

                            <div className="mt-8 space-y-3">
                                <button
                                    type="button"
                                    onClick={() => setPriceFilter('all')}
                                    className={cn(
                                        'flex h-12 w-full items-center gap-4 rounded-full px-5 text-left text-sm font-black tracking-wide transition-colors',
                                        priceFilter === 'all'
                                            ? 'bg-[#d9e8e2] text-[#5e6b68]'
                                            : 'text-[#4d5856] hover:bg-[#eef4f2]'
                                    )}
                                >
                                    <Grid2X2 className="h-5 w-5" />
                                    {t('marketplace.allProducts', { defaultValue: 'All Products' })}
                                </button>

                                {!hidePrice && (
                                    <button
                                        type="button"
                                        onClick={() => setPriceFilter('under-threshold')}
                                        className={cn(
                                            'flex h-12 w-full items-center gap-4 rounded-full px-5 text-left text-sm font-black tracking-wide transition-colors',
                                            priceFilter === 'under-threshold'
                                                ? 'bg-[#d9e8e2] text-[#5e6b68]'
                                                : 'text-[#4d5856] hover:bg-[#eef4f2]'
                                        )}
                                    >
                                        <Banknote className="h-5 w-5" />
                                        {t('marketplace.underAmount', {
                                            defaultValue: 'Under {{amount}}',
                                            amount: underPriceLabel
                                        })}
                                    </button>
                                )}
                            </div>
                        </div>
                    </aside>}

                    <section className={cn('space-y-6', hideFilters && 'mx-auto w-full')}>
                        {confirmation && (
                            <OrderConfirmation
                                orderNumber={confirmation.orderNumber}
                                storeName={catalog.store.name}
                                phone={confirmation.phone}
                                onBackToStore={() => setConfirmation(null)}
                            />
                        )}

                        <div className="rounded-[2.5rem] border border-[#e3e8ef] bg-[#fbfbfd] p-8">
                            <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
                                <div className="flex min-w-0 items-center gap-5">
                                    {catalog.store.logo_url ? (
                                        <StoreAvatar
                                            logoUrl={catalog.store.logo_url}
                                            name={catalog.store.name}
                                            className="h-16 w-16 shrink-0 rounded-full"
                                            imageClassName="p-3"
                                            iconClassName="h-7 w-7"
                                        />
                                    ) : (
                                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[#dceaf4] text-[#00756f]">
                                            <Sparkles className="h-8 w-8" />
                                        </div>
                                    )}

                                    <div className="min-w-0">
                                        <h1 className="truncate text-4xl font-black leading-tight tracking-tight text-[#111827]">
                                            {catalog.store.name}
                                        </h1>
                                        <p className="mt-1 max-w-3xl text-sm leading-6 text-[#4d5856]">
                                            {storeDescription}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-3">
                                    <StoreQrDialog
                                        name={catalog.store.name}
                                        slug={catalog.store.slug}
                                        logoUrl={catalog.store.logo_url}
                                        className="h-10 rounded-full bg-[#f1f4fb] px-5 shadow-none"
                                    />

                                    <Select value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)}>
                                        <SelectTrigger className="h-10 w-[174px] rounded-full border-[#d5dce4] bg-[#fbfbfd] px-4 text-xs shadow-none focus:ring-0 focus:ring-offset-0">
                                            <span className="mr-1 text-[#4d5856]">
                                                {t('marketplace.sortBy', { defaultValue: 'Sort By:' })}
                                            </span>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className="rounded-xl">
                                            <SelectItem value="featured">
                                                {t('marketplace.featured', { defaultValue: 'Featured' })}
                                            </SelectItem>
                                            <SelectItem value="newest">
                                                {t('marketplace.newArrivals', { defaultValue: 'New Arrivals' })}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-[2rem] border border-[#e3e8ef] bg-[#fbfbfd] p-4 shadow-[0_3px_10px_rgba(15,23,42,0.03)]">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#4d5856]" />
                                <Input
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder={t('marketplace.searchCollection', { defaultValue: 'Search our collection...' })}
                                    className="h-12 rounded-2xl border-0 bg-transparent pl-12 text-base shadow-none placeholder:text-[#273141] focus-visible:ring-0 focus-visible:ring-offset-0"
                                />
                            </div>
                        </div>

                        {displayedProducts.length === 0 ? (
                            <Card className="rounded-[2.5rem] border-[#e3e8ef] bg-[#fbfbfd]">
                                <CardContent className="p-10 text-center">
                                    <h3 className="text-xl font-black">
                                        {t('marketplace.noProducts', { defaultValue: 'No products match this filter yet' })}
                                    </h3>
                                </CardContent>
                            </Card>
                        ) : (
                            <>
                                <MarketplaceVirtualGrid
                                    items={displayedProducts}
                                    itemKey={(product) => product.id}
                                    renderItem={(product) => (
                                        <ProductCard
                                            product={product}
                                            iqdPreference={iqdPreference}
                                            showPrice={!hidePrice}
                                            showAddToCart={!hideAddToCart}
                                            addToCartLabel={hideAddToCart ? undefined : t('marketplace.addToCart', { defaultValue: 'Add to Cart' })}
                                            onAdd={hideAddToCart ? undefined : handleAddToCart}
                                        />
                                    )}
                                    listClassName="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
                                    rowClassName="pb-6"
                                    gridColumns={[
                                        { minWidth: 0, columns: 1 },
                                        { minWidth: 640, columns: 2 },
                                        { minWidth: 1280, columns: 3 }
                                    ]}
                                    onEndReached={loadMore}
                                    hasMore={hasMore}
                                    isLoadingMore={isLoadingMore}
                                />
                                {isLoadingMore && <p className="py-5 text-center text-sm text-muted-foreground">{t('marketplace.loadingMore')}</p>}
                                {loadMoreError && (
                                    <div className="flex flex-col items-center gap-3 py-5 text-center">
                                        <p className="text-sm text-destructive">{t('marketplace.loadingMoreFailed')}</p>
                                        <Button variant="outline" onClick={loadMore}>{t('common.retry')}</Button>
                                    </div>
                                )}
                            </>
                        )}

                        {!hideAddToCart && (
                            <MobileStoreCart
                                cart={cart}
                                items={cart.items}
                                total={cart.total}
                                currency={cart.currency || catalog.store.currency}
                                iqdPreference={iqdPreference}
                                checkoutMode={checkoutMode}
                                submitting={submitting}
                                setCheckoutMode={setCheckoutMode}
                                onSubmit={handleSubmitOrder}
                                collectEmail={!hideCheckoutEmail}
                            />
                        )}

                        {!hideAddToCart && <CartDrawer
                            className="max-sm:hidden"
                            open={cartOpen || checkoutMode}
                            title={t('marketplace.cart.title', { defaultValue: 'Your Order' })}
                            subtitle={`${cart.itemCount} ${t('marketplace.cart.items', { defaultValue: 'items' })}`}
                            onClose={closeCart}
                        >
                            {!checkoutMode ? (
                                <div className="space-y-4">
                                    {cart.items.length === 0 ? (
                                        <Card className="border-border/60 bg-card/60">
                                            <CardContent className="p-6 text-center text-sm text-muted-foreground">
                                                {t('marketplace.cart.empty', { defaultValue: 'Your cart is empty' })}
                                            </CardContent>
                                        </Card>
                                    ) : (
                                        <>
                                            <div className="space-y-3">
                                                {cart.items.map((item) => {
                                                    const itemImageUrl = getMarketplaceProductImageUrl(item.image_url)

                                                    return (
                                                        <Card key={item.product_id} className="border-border/60 bg-card/70">
                                                            <CardContent className="space-y-3 p-4">
                                                                <div className="flex gap-3">
                                                                    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted/40">
                                                                        {itemImageUrl ? (
                                                                            <img src={itemImageUrl} alt={item.name} className="h-full w-full object-cover" loading="lazy" />
                                                                        ) : (
                                                                            <Store className="h-5 w-5 text-muted-foreground" />
                                                                        )}
                                                                    </div>
                                                                    <div className="min-w-0 flex-1">
                                                                        <h3 className="truncate font-bold">{item.name}</h3>
                                                                        <div className="space-y-0.5">
                                                                            {item.unit_price < item.original_unit_price && (
                                                                                <p className="text-xs text-muted-foreground line-through">
                                                                                    {formatMoney(item.original_unit_price * item.quantity, item.currency)}
                                                                                </p>
                                                                            )}
                                                                            <p className="text-sm text-muted-foreground">
                                                                                {formatMoney(item.unit_price * item.quantity, item.currency)}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                    <Button variant="ghost" size="icon" onClick={() => cart.removeItem(item.product_id)}>
                                                                        <Minus className="h-4 w-4" />
                                                                    </Button>
                                                                </div>
                                                                <div className="flex items-center justify-between gap-3">
                                                                    <div className="inline-flex items-center rounded-full border border-border/60 bg-background/80">
                                                                        <button
                                                                            type="button"
                                                                            className="px-3 py-2 text-sm font-bold"
                                                                            onClick={() => cart.setQuantity(item.product_id, item.quantity - 1)}
                                                                        >
                                                                            -
                                                                        </button>
                                                                        <span className="px-3 text-sm font-semibold">{item.quantity}</span>
                                                                        <button
                                                                            type="button"
                                                                            className="px-3 py-2 text-sm font-bold"
                                                                            onClick={() => cart.setQuantity(item.product_id, item.quantity + 1)}
                                                                        >
                                                                            +
                                                                        </button>
                                                                    </div>
                                                                    <div className="text-sm text-muted-foreground">
                                                                        {item.unit_price < item.original_unit_price ? (
                                                                            <span className="flex flex-col items-end">
                                                                                <span className="text-xs line-through opacity-70">
                                                                                    {formatMoney(item.original_unit_price, item.currency)}
                                                                                </span>
                                                                                <span>{formatMoney(item.unit_price, item.currency)} / {item.unit}</span>
                                                                            </span>
                                                                        ) : (
                                                                            <span>{formatMoney(item.unit_price, item.currency)} / {item.unit}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </CardContent>
                                                        </Card>
                                                    )
                                                })}
                                            </div>

                                            <Card className="border-border/60 bg-primary/5">
                                                <CardContent className="flex items-center justify-between gap-4 p-4">
                                                    <div>
                                                        <p className="text-sm text-muted-foreground">
                                                            {t('marketplace.cart.total', { defaultValue: 'Total' })}
                                                        </p>
                                                        <p className="text-2xl font-black">
                                                            {formatMoney(cart.total, cart.currency || catalog.store.currency)}
                                                        </p>
                                                    </div>
                                                    <Button className="rounded-2xl" onClick={() => setCheckoutMode(true)}>
                                                        {t('marketplace.cart.checkout', { defaultValue: 'Continue to Checkout' })}
                                                    </Button>
                                                </CardContent>
                                            </Card>
                                        </>
                                    )}
                                </div>
                            ) : (
                                <CheckoutForm
                                    submitting={submitting}
                                    onCancel={() => setCheckoutMode(false)}
                                    onSubmit={handleSubmitOrder}
                                    collectEmail={!hideCheckoutEmail}
                                />
                            )}
                        </CartDrawer>}
                    </section>
                </div>
            )}
        </StorefrontLayout>
    )
}
