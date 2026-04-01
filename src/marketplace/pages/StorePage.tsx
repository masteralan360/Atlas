import { useDeferredValue, useEffect, useState } from 'react'
import { Link, useRoute } from 'wouter'
import { Mail, MapPin, Minus, Phone, Search, ShoppingCart, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button, Card, CardContent, Input, useToast } from '@/ui/components'
import { formatCurrency } from '@/lib/utils'

import { CartDrawer } from '../components/CartDrawer'
import { CategoryFilter } from '../components/CategoryFilter'
import { CheckoutForm } from '../components/CheckoutForm'
import { MarketplaceLayout } from '../components/MarketplaceLayout'
import { OrderConfirmation } from '../components/OrderConfirmation'
import { ProductCard } from '../components/ProductCard'
import { StoreAvatar } from '../components/StoreAvatar'
import { useCart } from '../hooks/useCart'
import { usePageMeta } from '../hooks/usePageMeta'
import { useStoreCatalog } from '../hooks/useStoreCatalog'
import { getMarketplaceAssetUrl } from '../lib/assets'
import { placeInquiryOrder } from '../lib/marketplaceApi'

function contactIcon(type: string) {
    if (type === 'phone') return Phone
    if (type === 'email') return Mail
    return MapPin
}

export function StorePage() {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const [, params] = useRoute('/s/:slug')
    const storeSlug = params?.slug || ''
    const { catalog, isLoading, error } = useStoreCatalog(storeSlug)
    const cart = useCart(storeSlug)
    const [search, setSearch] = useState('')
    const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
    const [cartOpen, setCartOpen] = useState(false)
    const [checkoutMode, setCheckoutMode] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [confirmation, setConfirmation] = useState<{ orderNumber: string; phone: string } | null>(null)
    const deferredSearch = useDeferredValue(search.trim().toLowerCase())
    const iqdPreference: 'IQD' | 'د.ع' = i18n.language === 'en' ? 'IQD' : 'د.ع'

    useEffect(() => {
        if (catalog) {
            cart.syncCatalog(catalog.products)
        }
    }, [catalog])

    const closeCart = () => {
        setCartOpen(false)
        setCheckoutMode(false)
    }

    const filteredProducts = (catalog?.products ?? []).filter((product) => {
        if (selectedCategoryId && product.category_id !== selectedCategoryId) {
            return false
        }

        if (!deferredSearch) {
            return true
        }

        return `${product.name} ${product.sku} ${product.description} ${product.category_name || ''}`
            .toLowerCase()
            .includes(deferredSearch)
    })

    const formatMoney = (amount: number, currency: string) => formatCurrency(amount, currency, iqdPreference)

    usePageMeta(
        catalog?.store.name || t('marketplace.title', { defaultValue: 'Atlas Marketplace' }),
        catalog?.store.description || t('marketplace.subtitle', { defaultValue: 'Discover stores across Iraq' })
    )

    const handleAddToCart = (product: (typeof filteredProducts)[number]) => {
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

    return (
        <MarketplaceLayout
            title={catalog?.store.name || t('marketplace.storeTitle', { defaultValue: 'Store' })}
            subtitle={catalog?.store.description || t('marketplace.storeSubtitle', { defaultValue: 'Browse products and send an inquiry order directly to the store.' })}
            backHref="/"
            backLabel={t('marketplace.backToMarketplace', { defaultValue: 'Back to Marketplace' })}
            headerLogoUrl={catalog?.store.logo_url}
            headerActions={(
                <Button
                    type="button"
                    className="gap-2 rounded-2xl"
                    onClick={() => setCartOpen(true)}
                >
                    <ShoppingCart className="h-4 w-4" />
                    <span>{cart.itemCount}</span>
                </Button>
            )}
        >
            {isLoading ? (
                <div className="space-y-6">
                    <Card className="border-border/60 bg-card/80">
                        <CardContent className="space-y-4 p-6">
                            <div className="h-6 w-48 animate-pulse rounded bg-muted" />
                            <div className="h-4 w-full animate-pulse rounded bg-muted" />
                            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                        </CardContent>
                    </Card>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {Array.from({ length: 6 }).map((_, index) => (
                            <Card key={index} className="border-border/60 bg-card/80">
                                <CardContent className="space-y-4 p-4">
                                    <div className="aspect-[4/3] animate-pulse rounded-[1.5rem] bg-muted" />
                                    <div className="h-6 w-3/4 animate-pulse rounded bg-muted" />
                                    <div className="h-4 w-full animate-pulse rounded bg-muted" />
                                    <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>
            ) : error || !catalog ? (
                <Card className="border-destructive/20 bg-destructive/5">
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
                <div className="space-y-6">
                    {confirmation && (
                        <OrderConfirmation
                            orderNumber={confirmation.orderNumber}
                            storeName={catalog.store.name}
                            phone={confirmation.phone}
                            onBackToStore={() => setConfirmation(null)}
                        />
                    )}

                    <Card className="overflow-hidden border-border/60 bg-card/80 shadow-[0_24px_80px_rgba(15,23,42,0.06)]">
                        <CardContent className="space-y-5 p-5 sm:p-6">
                            <div className="flex flex-col gap-5 md:flex-row md:items-start">
                                <StoreAvatar
                                    logoUrl={catalog.store.logo_url}
                                    name={catalog.store.name}
                                    className="h-24 w-24 rounded-[2rem]"
                                    imageClassName="p-4"
                                    iconClassName="h-9 w-9"
                                />

                                <div className="flex-1 space-y-3">
                                    <div className="space-y-1">
                                        <h2 className="text-3xl font-black tracking-tight">{catalog.store.name}</h2>
                                        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                                            {catalog.store.description || t('marketplace.storeSubtitle', { defaultValue: 'Browse products and send an inquiry order directly to the store.' })}
                                        </p>
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        {catalog.store.contacts.map((contact, index) => {
                                            const Icon = contactIcon(contact.type)

                                            return (
                                                <div key={`${contact.type}-${contact.value}-${index}`} className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/35 px-3 py-1.5 text-sm text-muted-foreground">
                                                    <Icon className="h-3.5 w-3.5" />
                                                    <span>{contact.value}</span>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            </div>

                            <CategoryFilter
                                categories={catalog.categories}
                                selectedCategoryId={selectedCategoryId}
                                onSelect={setSelectedCategoryId}
                            />
                        </CardContent>
                    </Card>

                    <Card className="border-border/60 bg-card/75">
                        <CardContent className="p-4 sm:p-5">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder={t('marketplace.searchProducts', { defaultValue: 'Search products...' })}
                                    className="h-12 rounded-2xl border-border/60 bg-background/80 pl-11"
                                />
                            </div>
                        </CardContent>
                    </Card>

                    {filteredProducts.length === 0 ? (
                        <Card className="border-border/60 bg-card/80">
                            <CardContent className="p-10 text-center">
                                <h3 className="text-xl font-black">
                                    {t('marketplace.noProducts', { defaultValue: 'No products match this filter yet' })}
                                </h3>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            {filteredProducts.map((product) => (
                                <ProductCard
                                    key={product.id}
                                    product={product}
                                    iqdPreference={iqdPreference}
                                    addToCartLabel={t('marketplace.addToCart', { defaultValue: 'Add to Cart' })}
                                    onAdd={handleAddToCart}
                                />
                            ))}
                        </div>
                    )}

                    <Button
                        type="button"
                        className="fixed bottom-5 end-5 z-30 h-14 rounded-full px-5 shadow-[0_18px_48px_rgba(15,23,42,0.18)] sm:hidden"
                        onClick={() => setCartOpen(true)}
                    >
                        <ShoppingCart className="me-2 h-4 w-4" />
                        {cart.itemCount}
                    </Button>

                    <CartDrawer
                        open={cartOpen}
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
                                                const itemImageUrl = getMarketplaceAssetUrl(item.image_url)

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
                                                                    <p className="text-sm text-muted-foreground">
                                                                        {formatMoney(item.unit_price * item.quantity, item.currency)}
                                                                    </p>
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
                                                                    {formatMoney(item.unit_price, item.currency)} / {item.unit}
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
                            />
                        )}
                    </CartDrawer>
                </div>
            )}
        </MarketplaceLayout>
    )
}
