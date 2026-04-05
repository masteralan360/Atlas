import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronUp, ChevronDown, ShoppingCart, Minus, Plus, Trash2, ChevronRight, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button, Card, CardContent } from '@/ui/components'
import { cn, formatCurrency } from '@/lib/utils'
import { getMarketplaceAssetUrl } from '../lib/assets'
import { CheckoutForm } from './CheckoutForm'
import type { MarketplaceOrderCustomer } from '../lib/marketplaceApi'

type MobileStoreCartProps = {
    cart: any
    items: any[]
    total: number
    currency: string
    iqdPreference: 'IQD' | 'د.ع'
    checkoutMode: boolean
    submitting: boolean
    setCheckoutMode: (mode: boolean) => void
    onSubmit: (payload: MarketplaceOrderCustomer) => Promise<void>
}

export function MobileStoreCart({
    cart,
    items,
    total,
    currency,
    iqdPreference,
    checkoutMode,
    submitting,
    setCheckoutMode,
    onSubmit
}: MobileStoreCartProps) {
    const { t } = useTranslation()
    const [isExpanded, setIsExpanded] = useState(false)
    const [isDragging, setIsDragging] = useState(false)
    const [startY, setStartY] = useState<number | null>(null)
    const [currentY, setCurrentY] = useState(0)
    const panelRef = useRef<HTMLDivElement>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const [canScrollUp, setCanScrollUp] = useState(false)
    const [canScrollDown, setCanScrollDown] = useState(false)

    const formatMoney = (amount: number, curr: string) => formatCurrency(amount, curr, iqdPreference)

    const checkScroll = useCallback(() => {
        if (!scrollContainerRef.current) return
        const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
        setCanScrollUp(scrollTop > 10)
        setCanScrollDown(scrollTop + clientHeight < scrollHeight - 10)
    }, [])

    useEffect(() => {
        const container = scrollContainerRef.current
        if (!container) return

        const handleScroll = () => checkScroll()
        container.addEventListener('scroll', handleScroll)

        const observer = new ResizeObserver(() => checkScroll())
        observer.observe(container)

        // Initial and on cart change
        checkScroll()

        return () => {
            container.removeEventListener('scroll', handleScroll)
            observer.disconnect()
        }
    }, [items.length, checkScroll])

    const handleTouchStart = (e: React.TouchEvent) => {
        setStartY(e.touches[0].clientY)
        setIsDragging(true)
    }

    const handleTouchMove = (e: React.TouchEvent) => {
        if (startY === null) return
        const touchY = e.touches[0].clientY
        let deltaY = touchY - startY

        // Rubber-banding logic
        if (isExpanded) {
            // Dragging down is normal, dragging up rubber-bands
            if (deltaY < 0) deltaY = deltaY * 0.2
            setCurrentY(deltaY)
        } else {
            // Dragging up is normal, dragging down rubber-bands
            if (deltaY > 0) deltaY = deltaY * 0.2
            setCurrentY(deltaY)
        }
    }

    const handleTouchEnd = () => {
        const totalTravel = window.innerHeight * 0.94 - collapsedHeight
        const currentRelativeY = isExpanded ? currentY : totalTravel + currentY

        if (currentRelativeY < totalTravel / 2) {
            setIsExpanded(true)
        } else {
            setIsExpanded(false)
        }
        setIsDragging(false)
        setStartY(null)
        setCurrentY(0)
    }

    const collapsedHeight = 110
    const totalTravelHeight = typeof window !== 'undefined' ? window.innerHeight * 0.94 - collapsedHeight : 0
    const progress = isDragging
        ? Math.min(1, Math.max(0, 1 - (isExpanded ? currentY : totalTravelHeight + currentY) / totalTravelHeight))
        : isExpanded ? 1 : 0

    // Only render the component at all if cart has items OR it's currently expanded (prevent sudden pop outs)
    // Actually we want it to stay visible if cart is empty so user can still see it while it fades. 
    // Usually POS is always visible, but for store, maybe hide when cart empty?
    if (items.length === 0 && !isExpanded) {
        return null;
    }

    return (
        <div className="fixed inset-0 z-40 pointer-events-none sm:hidden flex flex-col h-full animate-in fade-in duration-300">
            {/* Scroll Indicators (Mobile) */}
            {isExpanded && canScrollUp && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 bg-background/80 backdrop-blur-sm p-1.5 rounded-full border border-border shadow-sm animate-bounce pointer-events-none">
                    <ChevronUp className="w-4 h-4 text-primary" />
                </div>
            )}
            {isExpanded && canScrollDown && (
                <div className="absolute bottom-40 left-1/2 -translate-x-1/2 z-50 bg-background/80 backdrop-blur-sm p-1.5 rounded-full border border-border shadow-sm animate-bounce pointer-events-none">
                    <ChevronDown className="w-4 h-4 text-primary" />
                </div>
            )}

            {/* Collapsible Bottom Panel */}
            <div
                ref={panelRef}
                className={cn(
                    "absolute bottom-0 left-0 right-0 pointer-events-auto bg-card border-t border-border shadow-[0_-10px_40px_rgba(0,0,0,0.1)] z-50 transition-[transform,border-radius] duration-500 ease-in-out px-5 pt-1 flex flex-col",
                    "h-[94vh]", // Constant height for the sheet
                    isExpanded ? "rounded-t-[2.5rem]" : "rounded-t-[2rem]",
                    isDragging && "duration-0 transition-none will-change-transform"
                )}
                style={{
                    transform: isDragging
                        ? `translateY(calc(${isExpanded ? '0px' : `94vh - ${collapsedHeight}px`} + ${currentY}px))`
                        : isExpanded ? 'none' : `translateY(calc(94vh - ${collapsedHeight}px))`
                }}
            >
                {/* Drag Handle */}
                <div
                    className="flex flex-col items-center gap-1.5 cursor-grab active:cursor-grabbing py-3 group touch-none"
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                    <div className="w-12 h-1.5 bg-muted-foreground/30 rounded-full group-hover:bg-primary/40 transition-colors" />
                </div>

                {/* Collapsed/Header View - touch-none to prevent background scroll */}
                <div className="flex items-center justify-between pb-4 touch-none shrink-0" onClick={() => !isExpanded && setIsExpanded(true)}>
                    <div className="flex flex-col cursor-pointer" >
                        <div className="flex items-baseline gap-1.5">
                            <span className="text-2xl font-black text-primary">
                                {formatMoney(total, currency)}
                            </span>
                        </div>
                        <span className="text-xs text-muted-foreground font-medium mt-0.5">
                            {items.length} {t('marketplace.cart.items', { defaultValue: 'items' })}
                        </span>
                    </div>

                    <div
                        className="transition-opacity duration-300"
                        style={{
                            opacity: Math.max(0, 1 - progress * 2), // Fade out faster
                            pointerEvents: progress > 0.3 ? 'none' : 'auto'
                        }}
                    >
                        <Button
                            className="h-12 px-5 rounded-2xl font-bold shadow-lg shadow-primary/20 active:scale-95 transition-all text-primary-foreground"
                            onClick={(e) => {
                                e.stopPropagation();
                                setIsExpanded(true); // Always expand to review cart first? Or go straight to checkout?
                                // If they click on the collapsed state button, let's open it. But maybe if cart is fine, go to checkout.
                                // Actually, typical bottom sheets expand on interaction. Let's just expand it.
                                setIsExpanded(true);
                            }}
                        >
                            <div className="flex items-center gap-2">
                                <span>{t('marketplace.cart.title', { defaultValue: 'Your Order' })}</span>
                                <ChevronUp className="w-4 h-4" />
                            </div>
                        </Button>
                    </div>
                </div>

                {/* Expanded Content View - Scrollable area */}
                <div
                    ref={scrollContainerRef}
                    className={cn(
                        "flex-1 overflow-y-auto overscroll-contain touch-auto transition-all duration-300 relative",
                        !isDragging && !isExpanded && "pointer-events-none invisible"
                    )}
                    style={{
                        opacity: progress,
                        transform: `translateY(${(1 - progress) * 20}px)` // Subtle slide up
                    }}
                >
                    <div className="space-y-4 pb-12 pt-2">
                        {checkoutMode ? (
                            <div className="px-1">
                                <CheckoutForm
                                    submitting={submitting}
                                    onCancel={() => setCheckoutMode(false)}
                                    onSubmit={onSubmit}
                                    isMobile={true}
                                />
                            </div>
                        ) : items.length === 0 ? (
                            <Card className="border-border/60 bg-card/60">
                                <CardContent className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-4">
                                    <ShoppingCart className="w-12 h-12 opacity-20" />
                                    {t('marketplace.cart.empty', { defaultValue: 'Your cart is empty' })}
                                </CardContent>
                            </Card>
                        ) : (
                            <div className="space-y-3">
                                {items.map((item) => {
                                    const itemImageUrl = getMarketplaceAssetUrl(item.image_url)

                                    return (
                                        <Card key={item.product_id} className="border-border/60 bg-card/70 shadow-sm rounded-3xl overflow-hidden">
                                            <CardContent className="space-y-3 p-4">
                                                <div className="flex gap-4">
                                                    <div className="w-16 h-16 shrink-0 rounded-2xl bg-muted/40 overflow-hidden flex items-center justify-center">
                                                        {itemImageUrl ? (
                                                            <img src={itemImageUrl} alt={item.name} className="h-full w-full object-cover" loading="lazy" />
                                                        ) : (
                                                            <Store className="h-6 w-6 text-muted-foreground opacity-50" />
                                                        )}
                                                    </div>
                                                    <div className="min-w-0 flex-1 flex flex-col justify-center">
                                                        <div className="flex justify-between items-start gap-2">
                                                            <h3 className="truncate font-bold text-base leading-tight">{item.name}</h3>
                                                            <Button 
                                                                variant="ghost" 
                                                                size="icon" 
                                                                className="h-7 w-7 rounded-lg text-destructive bg-destructive/10 border border-destructive/20 -mt-1 -mr-1"
                                                                onClick={() => cart.removeItem(item.product_id)}
                                                            >
                                                                <Trash2 className="h-3.5 w-3.5" />
                                                            </Button>
                                                        </div>
                                                        <div className="text-sm font-bold text-primary mt-1">
                                                            {formatMoney(item.unit_price * item.quantity, item.currency)}
                                                        </div>
                                                        <div className="text-[11px] text-muted-foreground">
                                                            {formatMoney(item.unit_price, item.currency)} / {item.unit}
                                                        </div>
                                                    </div>
                                                </div>
                                                
                                                <div className="flex justify-end pt-1">
                                                    <div className="flex items-center gap-3 bg-muted/50 rounded-xl p-1 border border-border/50">
                                                        <button
                                                            type="button"
                                                            className="p-1.5 hover:bg-background rounded-lg transition-colors"
                                                            onClick={() => cart.setQuantity(item.product_id, item.quantity - 1)}
                                                        >
                                                            <Minus className="h-3.5 w-3.5" />
                                                        </button>
                                                        <span className="font-bold text-sm min-w-[1rem] text-center">{item.quantity}</span>
                                                        <button
                                                            type="button"
                                                            className="p-1.5 hover:bg-background rounded-lg transition-colors text-primary"
                                                            onClick={() => cart.setQuantity(item.product_id, item.quantity + 1)}
                                                        >
                                                            <Plus className="h-3.5 w-3.5" />
                                                        </button>
                                                    </div>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    )
                                })}

                                <div className="pt-4 border-t border-border/50">
                                    <Button 
                                        className="w-full h-14 rounded-2xl text-lg font-black shadow-xl shadow-primary/20"
                                        onClick={() => setCheckoutMode(true)}
                                        disabled={items.length === 0}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span>{t('marketplace.cart.checkout', { defaultValue: 'Checkout' })}</span>
                                            <ChevronRight className="w-5 h-5" />
                                        </div>
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Backdrop for expanded state */}
            {isExpanded && (
                <div
                    className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40 pointer-events-auto transition-opacity duration-300"
                    style={{ opacity: progress }}
                    onClick={() => setIsExpanded(false)}
                />
            )}
        </div>
    )
}
