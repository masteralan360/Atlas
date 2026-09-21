import type { CurrencyCode } from '@/local-db/models'
import type { CartItem } from '@/types'
import type { PosPaymentType } from '@/lib/posPaymentPolicy'
import { getOrderLineFreeBonusQuantity, getOrderLinePaidQuantity } from '@/lib/orderLineItems'
import { inventoryQuantityToSellingAvailability } from '@/lib/unitRelationships'

export interface PosRates {
    usdIqd: { rate: number } | null
    eurIqd: { rate: number } | null
    usdEur: { rate: number } | null
    tryIqd: { rate: number } | null
    usdTry: { rate: number } | null
}

function posConversionFactor(from: CurrencyCode, to: CurrencyCode, rates: PosRates): number | null {
    if (from === to) return 1
    const validRate = (entry: { rate: number } | null) => entry && Number.isFinite(entry.rate) && entry.rate > 0 ? entry.rate / 100 : null
    const pairs: [CurrencyCode, CurrencyCode, { rate: number } | null][] = [
        ['usd', 'iqd', rates.usdIqd], ['eur', 'iqd', rates.eurIqd], ['try', 'iqd', rates.tryIqd],
        ['usd', 'eur', rates.usdEur], ['usd', 'try', rates.usdTry]
    ]
    for (const [base, quote, entry] of pairs) {
        if (from === base && to === quote) return validRate(entry)
        if (from === quote && to === base) { const rate = validRate(entry); return rate ? 1 / rate : null }
    }
    if ((from === 'try' && to === 'eur') || (from === 'eur' && to === 'try')) {
        const eurIqd = validRate(rates.eurIqd), tryIqd = validRate(rates.tryIqd)
        if (eurIqd && tryIqd) return from === 'try' ? tryIqd / eurIqd : eurIqd / tryIqd
    }
    return null
}

export function hasPosConversionRate(from: CurrencyCode, to: CurrencyCode, rates: PosRates) {
    return posConversionFactor(from, to, rates) !== null
}

/** Rates come from the central ExchangeRateContext; no module-specific fetch. */
export function convertPosPrice(amount: number, from: CurrencyCode, to: CurrencyCode, rates: PosRates) {
    if (from === to) return amount
    const factor = posConversionFactor(from, to, rates)
    // While rates load, the display stays readable. Checkout must check availability.
    if (factor === null) return amount
    const converted = amount * factor
    return to === 'iqd' ? Math.round(converted) : Math.round(converted * 100) / 100
}

export function getCartBasePrice(item: CartItem) { return item.discounted_price ?? item.price }
export function getCartEffectivePrice(item: CartItem) { return item.negotiated_price ?? getCartBasePrice(item) }
export function snapshotPosCart(items: CartItem[]) { return items.map(item => ({ ...item })) }

/**
 * Quick Orders cannot persist the selling-unit conversion snapshot required by
 * products with related selling units. Keep those products out of an Order
 * cart instead of silently adding them in their base unit.
 */
export function canAddProductToPosCart(
    paymentType: PosPaymentType,
    hasRelatedSellingUnit: boolean
) {
    return paymentType !== 'order' || !hasRelatedSellingUnit
}

/** A free quantity forces the cart through the Sales Order checkout route. */
export function hasPosOrderFreeBonus(items: readonly CartItem[]) {
    return items.some((item) => getOrderLineFreeBonusQuantity(item) > 0)
}

/** Paid quantity may reach zero only after the line includes a free quantity. */
export function canSetPosPaidQuantity(item: CartItem, quantity: number) {
    return getOrderLinePaidQuantity({ quantity }) > 0
        || getOrderLineFreeBonusQuantity(item) > 0
}

/** Remove a cart line only when it has neither a paid nor a free quantity. */
export function shouldRemovePosCartItem(item: CartItem) {
    return getOrderLinePaidQuantity(item) <= 0
        && getOrderLineFreeBonusQuantity(item) <= 0
}

/**
 * The Quick Order dialog suppresses payment collection only for a genuine
 * free-only cart, never for an unrelated discounted zero-total sale.
 */
export function isFreeOnlyPosQuickOrder(items: readonly CartItem[], totalAmount: number) {
    return Number.isFinite(totalAmount)
        && totalAmount <= 0
        && hasPosOrderFreeBonus(items)
        && items.every((item) => getOrderLinePaidQuantity(item) <= 0)
}

/** Mobile hold-to-add is available only for an uncatalogued in-stock Quick Order product. */
export function canOfferMobileFreeOnlyOrderHold({
    canUseOrderFreeBonus,
    quickOrderEnabled,
    alreadyInCart,
    inventoryQuantity,
    isInfiniteActivity
}: {
    canUseOrderFreeBonus: boolean
    quickOrderEnabled: boolean
    alreadyInCart: boolean
    inventoryQuantity: number
    isInfiniteActivity: boolean
}) {
    return canUseOrderFreeBonus
        && quickOrderEnabled
        && !alreadyInCart
        && !isInfiniteActivity
        && inventoryQuantity > 0
}

/** Refresh stock limits when restoring; checkout revalidates availability. */
export function restorePosCart(items: CartItem[], fallbackStorageId: string,
    findProduct: (id: string, storageId?: string) => { inventoryQuantity: number } | undefined) {
    return items.map(item => {
        const storageId = item.storageId || fallbackStorageId
        const inventoryQuantity = findProduct(item.product_id, storageId)?.inventoryQuantity
        return {
            ...item,
            storageId,
            max_stock: inventoryQuantity === undefined
                ? item.max_stock
                : inventoryQuantityToSellingAvailability(inventoryQuantity, item.unit_factor ?? 1)
        }
    })
}

export function applyPosBulkDiscount(items: CartItem[], value: string, type: 'percent' | 'amount', subtotal: number) {
    const amount = parseFloat(value)
    if (!Number.isFinite(amount) || amount <= 0) return items.map(item => {
        if (item.negotiated_price === undefined) return item
        const next = { ...item }
        delete next.negotiated_price
        return next
    })
    const percent = type === 'percent' ? amount : subtotal > 0 ? amount / subtotal * 100 : 0
    return items.map(item => {
        const price = getCartBasePrice(item) * (1 - Math.min(percent, 100) / 100)
        if (item.negotiated_price !== undefined && Math.abs(item.negotiated_price - price) < 0.001) return item
        return { ...item, negotiated_price: price }
    })
}
