import type {
    CategoryDiscount,
    CurrencyCode,
    DiscountSource,
    DiscountType,
    Inventory,
    Product,
    ProductDiscount
} from '@/local-db/models'
import { isService } from '@/lib/catalogItem'

type DiscountRecord = ProductDiscount | CategoryDiscount

export type DiscountLifecycleStatus = 'active' | 'scheduled' | 'expired' | 'stock_paused' | 'inactive'

export interface ResolvedActiveDiscount {
    productId: string
    originalPrice: number
    discountPrice: number
    discountType: DiscountType
    discountValue: number
    startsAt: string
    endsAt: string
    minStockThreshold: number | null
    source: DiscountSource
}

export interface DiscountPriceContext {
    /** Null means native/default pricing, including marketplace pricing. */
    priceBookId?: string | null
    basePrice: number
    currency: CurrencyCode
}

function toTimestamp(value: string) {
    const timestamp = new Date(value).getTime()
    return Number.isFinite(timestamp) ? timestamp : 0
}

function pickNewestDiscount<T extends DiscountRecord>(rows: T[]): T | null {
    if (rows.length === 0) {
        return null
    }

    return [...rows].sort((left, right) => {
        const startsDiff = toTimestamp(right.startsAt) - toTimestamp(left.startsAt)
        if (startsDiff !== 0) {
            return startsDiff
        }

        const createdDiff = toTimestamp(right.createdAt) - toTimestamp(left.createdAt)
        if (createdDiff !== 0) {
            return createdDiff
        }

        return right.id.localeCompare(left.id)
    })[0]
}

export function buildInventoryTotalsByProduct(inventoryRows: Inventory[]) {
    const totals = new Map<string, number>()

    for (const row of inventoryRows) {
        if (row.isDeleted) {
            continue
        }

        totals.set(row.productId, (totals.get(row.productId) ?? 0) + (Number(row.quantity) || 0))
    }

    return totals
}

export function computeDiscountPrice(price: number, discountType: DiscountType, discountValue: number) {
    const basePrice = Number.isFinite(price) ? price : 0
    const normalizedValue = Number.isFinite(discountValue) ? discountValue : 0

    if (discountType === 'percentage') {
        const percentage = Math.min(Math.max(normalizedValue, 0), 100)
        return Math.max(Math.round(basePrice * (1 - percentage / 100) * 100) / 100, 0)
    }

    return Math.max(Math.round((basePrice - Math.max(normalizedValue, 0)) * 100) / 100, 0)
}

export function getProductDiscountPriceScope(discount: ProductDiscount) {
    return discount.priceScope ?? 'all'
}

/** Returns whether two active product-discount rules can affect the same price source. */
export function doProductDiscountPriceScopesOverlap(
    left: Pick<ProductDiscount, 'priceScope' | 'priceBookIds'>,
    right: Pick<ProductDiscount, 'priceScope' | 'priceBookIds'>
) {
    const leftScope = left.priceScope ?? 'all'
    const rightScope = right.priceScope ?? 'all'

    if (leftScope === 'all' || rightScope === 'all') {
        return true
    }

    if (leftScope === 'native_only' || rightScope === 'native_only') {
        return leftScope === 'native_only' && rightScope === 'native_only'
    }

    const rightPriceBookIds = new Set(right.priceBookIds ?? [])
    return (left.priceBookIds ?? []).some((priceBookId) => rightPriceBookIds.has(priceBookId))
}

export function doesProductDiscountApplyToPriceContext(
    discount: ProductDiscount,
    priceBookId: string | null | undefined,
    currency: CurrencyCode
) {
    if (
        discount.discountType === 'fixed_amount'
        && discount.discountCurrency
        && discount.discountCurrency !== currency
    ) {
        return false
    }

    switch (getProductDiscountPriceScope(discount)) {
        case 'native_only':
            return !priceBookId
        case 'specific_price_books':
            return !!priceBookId && (discount.priceBookIds ?? []).includes(priceBookId)
        case 'all':
        default:
            return true
    }
}

export function getDiscountStatus(
    discount: Pick<DiscountRecord, 'startsAt' | 'endsAt' | 'isActive' | 'minStockThreshold'>,
    stockTotal: number,
    now = new Date()
): DiscountLifecycleStatus {
    if (!discount.isActive) {
        return 'inactive'
    }

    const nowTimestamp = now.getTime()
    const startsAt = toTimestamp(discount.startsAt)
    const endsAt = toTimestamp(discount.endsAt)

    if (startsAt > nowTimestamp) {
        return 'scheduled'
    }

    if (endsAt < nowTimestamp) {
        return 'expired'
    }

    if (typeof discount.minStockThreshold === 'number' && stockTotal < discount.minStockThreshold) {
        return 'stock_paused'
    }

    return 'active'
}

function toResolvedActiveDiscount(
    productId: string,
    discount: DiscountRecord,
    source: DiscountSource,
    context: DiscountPriceContext
): ResolvedActiveDiscount {
    return {
        productId,
        originalPrice: context.basePrice,
        discountPrice: computeDiscountPrice(context.basePrice, discount.discountType, discount.discountValue),
        discountType: discount.discountType,
        discountValue: discount.discountValue,
        startsAt: discount.startsAt,
        endsAt: discount.endsAt,
        minStockThreshold: discount.minStockThreshold ?? null,
        source
    }
}

/**
 * Resolves a discount for the exact selling-price source in use. A direct
 * product rule applies only when its scope matches; otherwise category rules
 * remain eligible as the fallback.
 */
export function resolveActiveDiscountForPriceContext(input: {
    product: Product
    productDiscounts: ProductDiscount[]
    categoryDiscounts: CategoryDiscount[]
    inventoryRows: Inventory[]
    context: DiscountPriceContext
    stockTotal?: number
    now?: Date
}) {
    const now = input.now ?? new Date()
    const stockTotal = input.stockTotal ?? buildInventoryTotalsByProduct(input.inventoryRows).get(input.product.id) ?? 0
    const productDiscount = pickNewestDiscount(
        input.productDiscounts.filter((discount) => (
            !discount.isDeleted
            && discount.productId === input.product.id
            && doesProductDiscountApplyToPriceContext(discount, input.context.priceBookId, input.context.currency)
            && getDiscountStatus(discount, stockTotal, now) === 'active'
        ))
    )

    if (productDiscount) {
        return toResolvedActiveDiscount(input.product.id, productDiscount, 'product', input.context)
    }

    if (!input.product.categoryId) {
        return null
    }

    const categoryDiscount = pickNewestDiscount(
        input.categoryDiscounts.filter((discount) => (
            !discount.isDeleted
            && discount.categoryId === input.product.categoryId
            // Category fixed amounts predate Price Books and are denominated in
            // the native product currency. Do not reinterpret them in another
            // currency; percentage category rules remain currency-agnostic.
            && (discount.discountType !== 'fixed_amount' || input.product.currency === input.context.currency)
            && getDiscountStatus(discount, stockTotal, now) === 'active'
        ))
    )

    return categoryDiscount
        ? toResolvedActiveDiscount(input.product.id, categoryDiscount, 'category', input.context)
        : null
}

export function resolveActiveDiscountMap(input: {
    products: Product[]
    productDiscounts: ProductDiscount[]
    categoryDiscounts: CategoryDiscount[]
    inventoryRows: Inventory[]
    now?: Date
}) {
    const now = input.now ?? new Date()
    const inventoryTotals = buildInventoryTotalsByProduct(input.inventoryRows)
    const resolved = new Map<string, ResolvedActiveDiscount>()

    for (const product of input.products.filter((entry) => !entry.isDeleted)) {
        const discount = resolveActiveDiscountForPriceContext({
            product,
            productDiscounts: input.productDiscounts,
            categoryDiscounts: input.categoryDiscounts,
            inventoryRows: input.inventoryRows,
            context: {
                priceBookId: null,
                basePrice: product.price,
                currency: product.currency
            },
            stockTotal: isService(product) ? Number.MAX_SAFE_INTEGER : (inventoryTotals.get(product.id) ?? 0),
            now
        })

        if (discount) {
            resolved.set(product.id, discount)
        }
    }

    return resolved
}
