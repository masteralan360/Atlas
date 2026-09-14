import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { ArrowLeft, ChevronRight, MapPin, Minus, Phone, Plus, Search, ShoppingCart, Store, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button, useToast } from '@/ui/components'
import { cn, formatCurrency } from '@/lib/utils'

import { CartDrawer } from '../../components/CartDrawer'
import { CheckoutForm } from '../../components/CheckoutForm'
import { OrderConfirmation } from '../../components/OrderConfirmation'
import { useCart } from '../../hooks/useCart'
import { usePageMeta } from '../../hooks/usePageMeta'
import { useStoreCatalog } from '../../hooks/useStoreCatalog'
import { getMarketplaceAssetUrl } from '../../lib/assets'
import { getEffectiveStorefrontRules } from '../rules'
import {
    placeInquiryOrder,
    type MarketplaceCategory,
    type MarketplaceProduct,
    type MarketplaceStoreContact
} from '../../lib/marketplaceApi'
import type { StorefrontTemplate, StorefrontTemplatePageProps } from '../types'

function normalizeCurrency(currency?: string | null) {
    return (currency || 'usd').trim().toLowerCase()
}

function getEffectiveProductPrice(product: MarketplaceProduct) {
    return typeof product.discount_price === 'number' && product.discount_price < product.price
        ? product.discount_price
        : product.price
}

function formatStorePrice(amount: number, currency: string, iqdPreference: 'IQD' | 'د.ع') {
    if (normalizeCurrency(currency) === 'iqd') {
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(amount)
    }

    return formatCurrency(amount, currency, iqdPreference)
}

function StoreLogo({ storeName, logoUrl, className }: { storeName: string; logoUrl: string | null; className?: string }) {
    return (
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-muted text-sm font-black text-primary', className)}>
            {logoUrl ? (
                <img src={logoUrl} alt="" className="h-full w-full object-contain" />
            ) : (
                storeName.slice(0, 1).toUpperCase()
            )}
        </div>
    )
}

type PosHeaderProps = {
    storeName: string
    logoUrl: string | null
    cartCount: number
    showCart: boolean
    onCartClick: () => void
    showSearch: boolean
    search: string
    onSearchChange: (value: string) => void
    trailingAction?: ReactNode
}

function PosHeader({ storeName, logoUrl, cartCount, showCart, onCartClick, showSearch, search, onSearchChange, trailingAction }: PosHeaderProps) {
    const { t } = useTranslation()
    const [mobileSearchActive, setMobileSearchActive] = useState(false)

    return (
        <header
            className="fixed inset-x-0 top-0 z-50 bg-card shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
            style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
            <div className="flex h-14 items-center gap-2 px-3 md:h-[52px] md:px-6">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className={cn('flex min-w-0 items-center gap-2.5 md:gap-3', mobileSearchActive && 'hidden min-[992px]:flex')}>
                        <StoreLogo storeName={storeName} logoUrl={logoUrl} className="h-[38px] w-[38px] md:h-9 md:w-9" />
                        <h1 className="min-w-0 truncate text-[17px] font-bold text-foreground md:text-lg">
                            {storeName}
                        </h1>
                    </div>

                    {showSearch && (
                        <label className="hidden min-[992px]:flex h-8 flex-1 max-w-[600px] items-center gap-2 rounded-full bg-muted px-3 text-muted-foreground transition-shadow focus-within:ring-2 focus-within:ring-primary/25">
                            <Search className="h-4 w-4 shrink-0" />
                            <span className="sr-only">{t('marketplace.searchCollection', { defaultValue: 'Search collection' })}</span>
                            <input
                                value={search}
                                onChange={(event) => onSearchChange(event.target.value)}
                                placeholder={t('marketplace.searchCollection', { defaultValue: 'Search products...' })}
                                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                            />
                        </label>
                    )}

                    {showSearch && (
                        <div className={cn('flex min-[992px]:hidden flex-1 items-center gap-2 transition-opacity duration-200', mobileSearchActive ? 'opacity-100' : 'pointer-events-none opacity-0')}>
                            <div className={cn('relative flex-1 transition-transform duration-200', mobileSearchActive ? 'translate-y-0 scale-100' : '-translate-y-[3px] scale-[0.985]')}>
                                <label className="flex h-8 items-center gap-2 rounded-full bg-muted px-3 text-muted-foreground">
                                    <Search className="h-4 w-4 shrink-0" />
                                    <span className="sr-only">{t('marketplace.searchCollection', { defaultValue: 'Search collection' })}</span>
                                    <input
                                        value={search}
                                        onChange={(event) => onSearchChange(event.target.value)}
                                        placeholder={t('marketplace.searchCollection', { defaultValue: 'Search products...' })}
                                        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                                    />
                                </label>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {showSearch && (
                        <button
                            type="button"
                            onClick={() => setMobileSearchActive((active) => !active)}
                            aria-label={t('marketplace.searchCollection', { defaultValue: 'Search collection' })}
                            className={cn(
                                'flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-primary min-[992px]:hidden',
                                mobileSearchActive && 'text-primary'
                            )}
                        >
                            {mobileSearchActive ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
                        </button>
                    )}

                    {trailingAction}

                    {showCart && (
                        <button
                            type="button"
                            onClick={onCartClick}
                            aria-label={t('marketplace.cart.title', { defaultValue: 'Your Order' })}
                            className="relative hidden h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:text-primary md:flex"
                        >
                            <ShoppingCart className="h-[18px] w-[18px]" />
                            {cartCount > 0 && (
                                <span className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-destructive px-0.5 text-[9px] font-bold text-destructive-foreground">
                                    {cartCount}
                                </span>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </header>
    )
}

function PosCategoryCard({
    id,
    name,
    coverUrl,
    isActive,
    onSelect
}: {
    id: string | null
    name: string
    coverUrl: string | null
    isActive: boolean
    onSelect: (categoryId: string | null) => void
}) {
    const [hasImageError, setHasImageError] = useState(false)

    useEffect(() => {
        setHasImageError(false)
    }, [coverUrl])

    return (
        <button
            type="button"
            onClick={() => onSelect(id)}
            aria-pressed={isActive}
            className={cn(
                'group flex flex-col overflow-hidden rounded-lg border bg-card transition-[transform,box-shadow,border-color] duration-300 hover:scale-[1.02]',
                isActive
                    ? 'border-primary shadow-md shadow-primary/25 ring-2 ring-primary/25'
                    : 'border-border/60 shadow-[0_1px_4px_rgba(0,0,0,0.06)] hover:border-border hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)]'
            )}
        >
            <span className="relative aspect-[3/4] w-full overflow-hidden bg-secondary">
                {coverUrl && !hasImageError ? (
                    <img
                        src={coverUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={() => setHasImageError(true)}
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                ) : (
                    <span className="flex h-full w-full items-center justify-center">
                        <Store className="h-4 w-4 text-muted-foreground md:h-5 md:w-5" />
                    </span>
                )}
            </span>
            <span className="mt-auto border-t border-border px-1 py-1">
                <span className="line-clamp-1 block text-center text-[10px] font-semibold leading-[1.3] text-foreground md:text-[11px]">
                    {name}
                </span>
            </span>
        </button>
    )
}

function PosCategoryGrid({
    categories,
    coverUrls,
    activeCategoryId,
    onSelect
}: {
    categories: MarketplaceCategory[]
    coverUrls: Map<string | null, string>
    activeCategoryId: string | null
    onSelect: (categoryId: string | null) => void
}) {
    const { t } = useTranslation()

    if (categories.length === 0) {
        return null
    }

    return (
        <nav aria-label={t('marketplace.categories', { defaultValue: 'Categories' })} className="mb-5">
            <div className="grid grid-cols-[repeat(10,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(14,minmax(0,1fr))] sm:gap-1.5 md:grid-cols-[repeat(20,minmax(0,1fr))] lg:grid-cols-[repeat(24,minmax(0,1fr))] lg:gap-2">
                <PosCategoryCard
                    id={null}
                    name={t('common.all', { defaultValue: 'All' })}
                    coverUrl={coverUrls.get(null) ?? null}
                    isActive={activeCategoryId === null}
                    onSelect={onSelect}
                />
                {categories.map((category) => (
                    <PosCategoryCard
                        key={category.id}
                        id={category.id}
                        name={category.name}
                        coverUrl={coverUrls.get(category.id) ?? null}
                        isActive={category.id === activeCategoryId}
                        onSelect={onSelect}
                    />
                ))}
            </div>
        </nav>
    )
}

function PosProductCard({
    product,
    iqdPreference,
    hidePrice,
    onAdd
}: {
    product: MarketplaceProduct
    iqdPreference: 'IQD' | 'د.ع'
    hidePrice: boolean
    onAdd?: (product: MarketplaceProduct) => void
}) {
    const { t } = useTranslation()
    const imageUrl = getMarketplaceAssetUrl(product.image_url)
    const [hasImageError, setHasImageError] = useState(false)
    const hasDiscount = typeof product.discount_price === 'number' && product.discount_price < product.price

    useEffect(() => {
        setHasImageError(false)
    }, [imageUrl])

    const discountPercent = hasDiscount && product.discount_price
        ? Math.round(((product.price - product.discount_price) / product.price) * 100)
        : 0

    return (
        <article className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-[transform,box-shadow,border-color] duration-300 hover:scale-[1.012] hover:border-border hover:shadow-[0_6px_16px_rgba(0,0,0,0.1)]">
            <div className="relative aspect-square overflow-hidden bg-secondary">
                {imageUrl && !hasImageError ? (
                    <img
                        src={imageUrl}
                        alt={product.name}
                        loading="lazy"
                        decoding="async"
                        onError={() => setHasImageError(true)}
                        className="h-full w-full object-cover"
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center">
                        <Store className="h-12 w-12 text-muted-foreground" />
                    </div>
                )}
                {hasDiscount && discountPercent > 0 && (
                    <span className="absolute right-2 top-2 z-10 rounded-full bg-destructive px-2.5 py-1 text-[11px] font-semibold text-destructive-foreground">
                        -{discountPercent}%
                    </span>
                )}
            </div>

            <div className="flex flex-1 flex-col p-3 pb-0">
                <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-[1.4] text-foreground">
                    {product.name}
                </h3>

                {onAdd && (
                    <div className="-mx-3 mt-3 flex h-[45px] border-t border-border md:h-10">
                        {!hidePrice && (
                            <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 bg-secondary px-2">
                                {hasDiscount && (
                                    <del className="text-[13px] font-normal text-muted-foreground">
                                        {formatStorePrice(product.price, product.currency, iqdPreference)}
                                    </del>
                                )}
                                <span className="truncate text-[15px] font-bold whitespace-nowrap text-primary md:text-sm">
                                    {formatStorePrice(getEffectiveProductPrice(product), product.currency, iqdPreference)}
                                </span>
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => onAdd(product)}
                            aria-label={`${t('marketplace.addToCart', { defaultValue: 'Add to Cart' })} ${product.name}`}
                            className="flex h-full w-[58px] shrink-0 items-center justify-center border-s border-border bg-secondary text-primary transition-colors hover:bg-primary hover:text-primary-foreground active:bg-primary/90 md:w-[46px]"
                        >
                            <Plus className="h-5 w-5 md:h-[17px] md:w-[17px]" />
                        </button>
                    </div>
                )}
            </div>
        </article>
    )
}

function PosLoadingGrid() {
    return (
        <div className="space-y-6">
            <div className="grid grid-cols-[repeat(10,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(14,minmax(0,1fr))] sm:gap-1.5 md:grid-cols-[repeat(20,minmax(0,1fr))] lg:grid-cols-[repeat(24,minmax(0,1fr))] lg:gap-2">
                {Array.from({ length: 12 }).map((_, index) => (
                    <div key={index} className="overflow-hidden rounded-lg border border-border/60 bg-card shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
                        <div className="aspect-[3/4] animate-pulse bg-muted" />
                        <div className="flex items-center justify-center border-t border-border px-1 py-1.5">
                            <div className="h-2 w-3/4 animate-pulse rounded bg-muted" />
                        </div>
                    </div>
                ))}
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 min-[1200px]:grid-cols-8">
            {Array.from({ length: 16 }).map((_, index) => (
                <div key={index} className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)]">
                    <div className="aspect-square animate-pulse bg-muted" />
                    <div className="space-y-2 p-3">
                        <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted" />
                        <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    </div>
                </div>
            ))}
            </div>
        </div>
    )
}

function PosErrorState({ message }: { message?: string }) {
    const { t } = useTranslation()

    return (
        <div className="flex justify-center px-3">
            <div className="w-full max-w-md rounded-xl border border-destructive/30 bg-card p-8 text-center shadow-[0_2px_8px_rgba(0,0,0,0.08)]">
                <Store className="mx-auto h-8 w-8 text-primary" />
                <h1 className="mt-4 text-xl font-bold text-foreground">
                    {t('marketplace.storeNotFound', { defaultValue: 'Store not found' })}
                </h1>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    {message || t('marketplace.storeNotFoundHint', { defaultValue: 'This store is currently unavailable.' })}
                </p>
                <Link href="/" className="mt-5 inline-flex text-sm font-semibold text-primary hover:underline">
                    {t('marketplace.backToMarketplace', { defaultValue: 'Back to Marketplace' })}
                </Link>
            </div>
        </div>
    )
}

type PosCartContentProps = {
    cart: ReturnType<typeof useCart>
    storeCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
    checkoutMode: boolean
    setCheckoutMode: (mode: boolean) => void
    submitting: boolean
    collectEmail: boolean
    onSubmit: (customer: {
        name: string
        phone: string
        email?: string
        city?: string
        address?: string
        notes?: string
    }) => Promise<void>
}

function PosCartContent({ cart, storeCurrency, iqdPreference, checkoutMode, setCheckoutMode, submitting, collectEmail, onSubmit }: PosCartContentProps) {
    const { t } = useTranslation()
    const currency = cart.currency || storeCurrency
    const formatMoney = (amount: number) => formatCurrency(amount, currency, iqdPreference)

    if (checkoutMode) {
        return (
            <div className="space-y-4">
                <CheckoutForm
                    submitting={submitting}
                    onCancel={() => setCheckoutMode(false)}
                    onSubmit={onSubmit}
                    collectEmail={collectEmail}
                />
                <button
                    type="button"
                    onClick={() => setCheckoutMode(false)}
                    className="mx-auto flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-primary"
                >
                    <ChevronRight className="h-4 w-4 rtl:rotate-180" />
                    {t('marketplace.cart.back', { defaultValue: 'Back to cart' })}
                </button>
            </div>
        )
    }

    if (cart.items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-16 text-center text-muted-foreground">
                <ShoppingCart className="h-12 w-12 opacity-20" />
                <p className="text-sm">{t('marketplace.cart.empty', { defaultValue: 'Your cart is empty' })}</p>
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <div className="space-y-3">
                {cart.items.map((item) => {
                    const itemImageUrl = getMarketplaceAssetUrl(item.image_url)

                    return (
                        <div key={item.product_id} className="flex gap-4 rounded-xl border border-border bg-card p-3">
                            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary">
                                {itemImageUrl ? (
                                    <img src={itemImageUrl} alt={item.name} className="h-full w-full object-cover" loading="lazy" />
                                ) : (
                                    <Store className="h-6 w-6 text-muted-foreground" />
                                )}
                            </div>
                            <div className="flex min-w-0 flex-1 flex-col justify-center">
                                <div className="flex items-start justify-between gap-2">
                                    <h3 className="truncate text-[14px] font-semibold leading-tight text-foreground">
                                        {item.name}
                                    </h3>
                                    <button
                                        type="button"
                                        onClick={() => cart.removeItem(item.product_id)}
                                        aria-label={t('marketplace.cart.removeItem', { defaultValue: 'Remove item' })}
                                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                                <div className="mt-1.5">
                                    <span className="text-[15px] font-bold text-primary">
                                        {formatMoney(item.unit_price * item.quantity)}
                                    </span>
                                </div>
                                <div className="mt-2 flex items-center justify-end">
                                    <div className="flex items-center gap-3 rounded-lg bg-muted p-1">
                                        <button
                                            type="button"
                                            onClick={() => cart.setQuantity(item.product_id, item.quantity - 1)}
                                            aria-label={t('marketplace.cart.decrease', { defaultValue: 'Decrease quantity' })}
                                            className="p-1.5 text-muted-foreground transition-colors hover:text-primary"
                                        >
                                            <Minus className="h-3.5 w-3.5" />
                                        </button>
                                        <span className="min-w-4 text-center text-sm font-bold text-foreground">{item.quantity}</span>
                                        <button
                                            type="button"
                                            onClick={() => cart.setQuantity(item.product_id, item.quantity + 1)}
                                            aria-label={t('marketplace.cart.increase', { defaultValue: 'Increase quantity' })}
                                            className="rounded p-1.5 text-primary transition-colors hover:bg-card hover:text-primary/90"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>

            <div className="pt-3">
                <div className="flex items-center justify-between border-y border-border bg-secondary px-4 py-3">
                    <span className="text-base text-foreground">
                        {t('marketplace.cart.total', { defaultValue: 'Total' })}
                    </span>
                    <span className="text-lg font-black text-primary">
                        {formatMoney(cart.total)}
                    </span>
                </div>
                <Button
                    className="mt-3 h-12 w-full rounded-xl bg-primary text-[15px] font-bold text-primary-foreground hover:bg-primary/90"
                    onClick={() => setCheckoutMode(true)}
                >
                    {t('marketplace.cart.checkout', { defaultValue: 'Checkout' })}
                </Button>
            </div>
        </div>
    )
}

function PosShopPage({ slug, rules }: StorefrontTemplatePageProps) {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { catalog, isLoading, error } = useStoreCatalog(slug)
    const cart = useCart(slug)
    const [search, setSearch] = useState('')
    const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)
    const [cartOpen, setCartOpen] = useState(false)
    const [checkoutMode, setCheckoutMode] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [confirmation, setConfirmation] = useState<{ orderNumber: string; phone: string } | null>(null)
    const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase())
    const iqdPreference: 'IQD' | 'د.ع' = i18n.language === 'en' ? 'IQD' : 'د.ع'
    const effectiveRules = getEffectiveStorefrontRules(rules, catalog?.store.workspace_id)
    const hidePrice = effectiveRules.hidePrice === true
    const hideAddToCart = effectiveRules.hideAddToCart === true
    const hideCheckoutEmail = effectiveRules.hideCheckoutEmail === true

    useEffect(() => {
        if (catalog) {
            cart.syncCatalog(catalog.products)
        }
    }, [catalog])

    const categories = useMemo<MarketplaceCategory[]>(() => catalog?.categories ?? [], [catalog?.categories])

    const categoryCoverUrls = useMemo(() => {
        const productsWithImages = (catalog?.products ?? []).filter((product) => product.image_url)
        const covers = new Map<string | null, string>()

        if (productsWithImages.length === 0) {
            return covers
        }

        const pickRandomCover = (pool: MarketplaceProduct[]) => {
            const picked = pool[Math.floor(Math.random() * pool.length)]
            return picked ? getMarketplaceAssetUrl(picked.image_url) : null
        }

        const allCover = pickRandomCover(productsWithImages)

        if (allCover) {
            covers.set(null, allCover)
        }

        for (const category of categories) {
            const pool = productsWithImages.filter((product) => product.category_id === category.id)
            const cover = pickRandomCover(pool)

            if (cover) {
                covers.set(category.id, cover)
            }
        }

        return covers
    }, [categories, catalog?.products])

    useEffect(() => {
        setActiveCategoryId((currentCategoryId) => {
            if (currentCategoryId && categories.some((category) => category.id === currentCategoryId)) {
                return currentCategoryId
            }

            return null
        })
    }, [categories])

    const displayedProducts = useMemo(() => {
        const products = catalog?.products ?? []

        return products.filter((product) => {
            if (activeCategoryId && product.category_id !== activeCategoryId) {
                return false
            }

            if (!deferredSearch) {
                return true
            }

            return `${product.name} ${product.description} ${product.category_name ?? ''}`
                .toLocaleLowerCase()
                .includes(deferredSearch)
        })
    }, [activeCategoryId, catalog?.products, deferredSearch])

    const storeName = catalog?.store.name || t('marketplace.storeTitle', { defaultValue: 'Store' })
    const storeDescription = catalog?.store.description || t('marketplace.storeSubtitle', { defaultValue: 'Browse products and send an inquiry order directly to the store.' })

    usePageMeta(storeName, storeDescription)

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

    const handleCloseCart = () => {
        setCartOpen(false)
        setCheckoutMode(false)
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
            handleCloseCart()
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

    return (
        <div className="min-h-dvh bg-muted">
            <PosHeader
                storeName={storeName}
                logoUrl={getMarketplaceAssetUrl(catalog?.store.logo_url)}
                cartCount={cart.itemCount}
                showCart={!hideAddToCart}
                onCartClick={() => setCartOpen(true)}
                showSearch
                search={search}
                onSearchChange={setSearch}
                trailingAction={(
                    <Link
                        href={`/s/${slug}/contact`}
                        className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-primary hover:bg-accent"
                    >
                        {t('marketplace.contactStore', { defaultValue: 'Contact' })}
                    </Link>
                )}
            />
            <main className="px-3 pb-16 pt-[70px] md:px-6 md:pt-[66px]">
                {confirmation ? (
                    <div className="mx-auto max-w-2xl">
                        <OrderConfirmation
                            orderNumber={confirmation.orderNumber}
                            storeName={storeName}
                            phone={confirmation.phone}
                            onBackToStore={() => setConfirmation(null)}
                        />
                    </div>
                ) : isLoading ? (
                    <PosLoadingGrid />
                ) : error || !catalog ? (
                    <PosErrorState message={error || undefined} />
                ) : (
                    <>
                        <PosCategoryGrid
                            categories={categories}
                            coverUrls={categoryCoverUrls}
                            activeCategoryId={activeCategoryId}
                            onSelect={setActiveCategoryId}
                        />
                        {displayedProducts.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center text-muted-foreground">
                                <Search className="mx-auto h-8 w-8 opacity-25" />
                                <p className="mt-3 text-sm font-semibold">
                                    {search
                                        ? t('marketplace.noProducts', { defaultValue: 'No products match your search.' })
                                        : t('marketplace.noProducts', { defaultValue: 'No products in this catalog yet.' })}
                                </p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 min-[1200px]:grid-cols-8">
                                {displayedProducts.map((product) => (
                                    <PosProductCard
                                        key={product.id}
                                        product={product}
                                        iqdPreference={iqdPreference}
                                        hidePrice={hidePrice}
                                        onAdd={hideAddToCart ? undefined : handleAddToCart}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                )}
            </main>

            {!hideAddToCart && cart.itemCount > 0 && (
                <button
                    type="button"
                    onClick={() => setCartOpen(true)}
                    aria-label={t('marketplace.cart.title', { defaultValue: 'Your Order' })}
                    className="fixed bottom-4 end-4 z-[60] flex h-[50px] w-[50px] items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/40 transition-colors hover:bg-primary/90 active:scale-95 md:hidden"
                >
                    <ShoppingCart className="h-5 w-5" />
                    <span className="absolute -left-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-white bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                        {cart.itemCount}
                    </span>
                </button>
            )}

            {!hideAddToCart && (
                <CartDrawer
                    open={cartOpen || checkoutMode}
                    title={t('marketplace.cart.title', { defaultValue: 'Your Order' })}
                    subtitle={`${cart.itemCount} ${t('marketplace.cart.items', { defaultValue: 'items' })}`}
                    onClose={handleCloseCart}
                >
                    <PosCartContent
                        cart={cart}
                        storeCurrency={catalog?.store.currency || 'usd'}
                        iqdPreference={iqdPreference}
                        checkoutMode={checkoutMode}
                        setCheckoutMode={setCheckoutMode}
                        submitting={submitting}
                        collectEmail={!hideCheckoutEmail}
                        onSubmit={handleSubmitOrder}
                    />
                </CartDrawer>
            )}
        </div>
    )
}

function getContactsOfType(contacts: MarketplaceStoreContact[], type: 'phone' | 'address') {
    return contacts
        .filter((contact) => contact.type.toLowerCase() === type && contact.value.trim().length > 0)
        .sort((left, right) => Number(right.is_primary) - Number(left.is_primary))
}

function PosContactPage({ slug, rules }: StorefrontTemplatePageProps) {
    const { t } = useTranslation()
    const { catalog, isLoading, error } = useStoreCatalog(slug)
    const cart = useCart(slug)
    const storeName = catalog?.store.name || t('marketplace.storeTitle', { defaultValue: 'Store' })
    const phoneContacts = getContactsOfType(catalog?.store.contacts ?? [], 'phone')
    const addressContacts = getContactsOfType(catalog?.store.contacts ?? [], 'address')

    usePageMeta(
        t('marketplace.contactPageTitle', {
            defaultValue: '{{storeName}} Contact',
            storeName
        }),
        catalog?.store.description || t('marketplace.storeSubtitle', { defaultValue: 'Browse products and send an inquiry order directly to the store.' })
    )

    return (
        <div className="min-h-dvh bg-muted">
            <PosHeader
                storeName={storeName}
                logoUrl={getMarketplaceAssetUrl(catalog?.store.logo_url)}
                cartCount={cart.itemCount}
                showCart={!rules.hideAddToCart}
                onCartClick={() => {
                    window.location.href = `/s/${slug}`
                }}
                showSearch={false}
                search=""
                onSearchChange={() => undefined}
                trailingAction={(
                    <Link
                        href={`/s/${slug}`}
                        className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-primary hover:bg-accent"
                    >
                        <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
                        {t('marketplace.backToStore', { defaultValue: 'Back to Store' })}
                    </Link>
                )}
            />

            <main className="px-3 pb-16 pt-[70px] md:px-6 md:pt-[66px]">
                {isLoading ? (
                    <div className="space-y-4">
                        <div className="h-24 animate-pulse rounded-xl bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)]" />
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="h-72 animate-pulse rounded-xl bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)]" />
                            <div className="h-72 animate-pulse rounded-xl bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)]" />
                        </div>
                    </div>
                ) : error || !catalog ? (
                    <PosErrorState message={error || undefined} />
                ) : (
                    <div className="mx-auto max-w-5xl space-y-4">
                        <div className="rounded-xl border border-border/60 bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.08)] md:p-8">
                            <h1 className="text-2xl font-bold text-foreground">
                                {t('marketplace.contactStore', {
                                    defaultValue: 'Contact {{storeName}}',
                                    storeName: catalog.store.name
                                })}
                            </h1>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">
                                {catalog.store.description || t('marketplace.storeSubtitle', { defaultValue: 'Browse products and send an inquiry order directly to the store.' })}
                            </p>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                            <section className="rounded-xl border border-border/60 bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.08)]">
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-primary">
                                        <Phone className="h-5 w-5" />
                                    </div>
                                    <h2 className="text-lg font-bold text-foreground">
                                        {t('marketplace.phoneNumbers', { defaultValue: 'Phone Numbers' })}
                                    </h2>
                                </div>
                                <div className="mt-5 space-y-3">
                                    {phoneContacts.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">
                                            {t('marketplace.noPhoneContacts', { defaultValue: 'No phone numbers available.' })}
                                        </p>
                                    ) : phoneContacts.map((contact, index) => (
                                        <a
                                            key={`phone-${contact.value}-${index}`}
                                            href={`tel:${contact.value}`}
                                            className="flex items-center gap-3 rounded-lg border border-border bg-secondary px-4 py-3 text-[15px] font-semibold text-foreground transition-colors hover:border-primary hover:text-primary"
                                        >
                                            {contact.is_primary && (
                                                <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                                                    {t('marketplace.primaryContact', { defaultValue: 'Primary' })}
                                                </span>
                                            )}
                                            {contact.value}
                                        </a>
                                    ))}
                                </div>
                            </section>

                            <section className="rounded-xl border border-border/60 bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.08)]">
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-primary">
                                        <MapPin className="h-5 w-5" />
                                    </div>
                                    <h2 className="text-lg font-bold text-foreground">
                                        {t('marketplace.addresses', { defaultValue: 'Addresses' })}
                                    </h2>
                                </div>
                                <div className="mt-5 space-y-3">
                                    {addressContacts.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">
                                            {t('marketplace.noAddressContacts', { defaultValue: 'No addresses available.' })}
                                        </p>
                                    ) : addressContacts.map((contact, index) => (
                                        <div
                                            key={`address-${contact.value}-${index}`}
                                            className="flex items-start gap-3 rounded-lg border border-border bg-secondary px-4 py-3 text-[15px] font-semibold leading-6 text-foreground"
                                        >
                                            {contact.is_primary && (
                                                <span className="mt-0.5 shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                                                    {t('marketplace.primaryContact', { defaultValue: 'Primary' })}
                                                </span>
                                            )}
                                            {contact.value}
                                        </div>
                                    ))}
                                </div>
                            </section>
                        </div>
                    </div>
                )}
            </main>
        </div>
    )
}

export const posStorefrontTemplate = {
    id: 'pos',
    label: 'POS storefront',
    ShopPage: PosShopPage,
    ContactPage: PosContactPage
} satisfies StorefrontTemplate
