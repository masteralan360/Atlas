import type {
    CategoryDiscount,
    DiscountSource,
    DiscountType,
    Inventory,
    Product,
    ProductDiscount
} from '@/local-db/models'

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

    const latestProductDiscountByProduct = new Map<string, ProductDiscount>()
    for (const discount of input.productDiscounts.filter((entry) => !entry.isDeleted)) {
        const existing = latestProductDiscountByProduct.get(discount.productId)
        latestProductDiscountByProduct.set(
            discount.productId,
            pickNewestDiscount([discount, ...(existing ? [existing] : [])]) ?? discount
        )
    }

    const latestCategoryDiscountByCategory = new Map<string, CategoryDiscount>()
    for (const discount of input.categoryDiscounts.filter((entry) => !entry.isDeleted)) {
        const existing = latestCategoryDiscountByCategory.get(discount.categoryId)
        latestCategoryDiscountByCategory.set(
            discount.categoryId,
            pickNewestDiscount([discount, ...(existing ? [existing] : [])]) ?? discount
        )
    }

    for (const product of input.products.filter((entry) => !entry.isDeleted)) {
        const stockTotal = inventoryTotals.get(product.id) ?? 0
        const productDiscount = latestProductDiscountByProduct.get(product.id)
        const categoryDiscount = product.categoryId
            ? latestCategoryDiscountByCategory.get(product.categoryId)
            : undefined

        const winner = productDiscount ?? categoryDiscount
        const source: DiscountSource = productDiscount ? 'product' : 'category'

        if (!winner) {
            continue
        }

        if (getDiscountStatus(winner, stockTotal, now) !== 'active') {
            continue
        }

        resolved.set(product.id, {
            productId: product.id,
            originalPrice: product.price,
            discountPrice: computeDiscountPrice(product.price, winner.discountType, winner.discountValue),
            discountType: winner.discountType,
            discountValue: winner.discountValue,
            startsAt: winner.startsAt,
            endsAt: winner.endsAt,
            minStockThreshold: winner.minStockThreshold ?? null,
            source
        })
    }

    return resolved
}
