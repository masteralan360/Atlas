import { roundQuantity } from '@/lib/quantity'
import { getOrderLineInventoryQuantity, getOrderLinePaidQuantity, getOrderLineReturnedPaidInventoryQuantity } from '@/lib/orderLineItems'

const RETURN_EPSILON = 0.000001

export type OrderPrintReturnStatus = 'active' | 'partially-returned' | 'fully-returned'

/** Chooses which version of a returned sales order a print should represent. */
export type OrderPrintVersion = 'adjusted' | 'original' | 'returned'

type OrderPrintLine = {
    quantity?: unknown
    freeBonusQuantity?: unknown
    freeQuantity?: unknown
    returnedQuantity?: unknown
    returnedPaidInventoryQuantity?: unknown
    returnedFreeInventoryQuantity?: unknown
    unitFactor?: unknown
    lineTotal?: unknown
}

type OrderPrintTotal = {
    total?: unknown
    originalTotalAmount?: unknown
    returnedAmount?: unknown
}

type OrderPrintReturnOverrides = {
    returnedQuantity?: unknown
    returnedPaidInventoryQuantity?: unknown
    returnedAmount?: unknown
}

export type OrderPrintReturnState = {
    status: OrderPrintReturnStatus
    originalQuantity: number
    remainingQuantity: number
    originalLineTotal: number
    remainingLineTotal: number
}

type A4OrderPrintReturnRowStyle = {
    backgroundColor: string
    color?: string
    WebkitPrintColorAdjust: 'exact'
    printColorAdjust: 'exact'
}

const A4_RETURN_ROW_COLORS: Record<Exclude<OrderPrintReturnStatus, 'active'>, A4OrderPrintReturnRowStyle> = {
    'partially-returned': {
        backgroundColor: '#fef3c7',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact'
    },
    'fully-returned': {
        backgroundColor: '#fee2e2',
        color: '#991b1b',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact'
    }
}

function normalizeReturnedQuantity(value: unknown) {
    const quantity = Number(value ?? 0)
    return Number.isFinite(quantity) ? roundQuantity(Math.max(0, quantity)) : 0
}

function normalizeAmount(value: unknown) {
    const amount = Number(value ?? 0)
    return Number.isFinite(amount) ? Math.max(0, amount) : 0
}

function roundPrintedAmount(value: number) {
    return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}

/**
 * The order total is reduced after a return. Use its saved original total for
 * an "Original" print, without changing the persisted order.
 */
export function getOrderPrintOriginalTotal(order: OrderPrintTotal) {
    if (order.originalTotalAmount !== null && order.originalTotalAmount !== undefined) {
        const storedOriginalTotal = Number(order.originalTotalAmount)
        if (Number.isFinite(storedOriginalTotal) && storedOriginalTotal >= 0) {
            return storedOriginalTotal
        }
    }

    return normalizeAmount(order.total) + normalizeAmount(order.returnedAmount)
}

/**
 * Produces the original and remaining values shown in an order print row.
 * Returns are stored cumulatively on the sales-order item, while the original
 * line values remain immutable for audit/history purposes.
 */
export function getOrderPrintReturnState(
    item: OrderPrintLine,
    overrides: OrderPrintReturnOverrides = {}
): OrderPrintReturnState {
    const originalQuantity = getOrderLinePaidQuantity(item)
    const inventoryQuantity = getOrderLineInventoryQuantity(item)
    const returnedQuantity = Math.min(
        inventoryQuantity,
        normalizeReturnedQuantity(overrides.returnedQuantity ?? item.returnedQuantity)
    )
    const factor = Number(item.unitFactor ?? 1)
    const normalizedFactor = Number.isFinite(factor) && factor > 0 ? factor : 1
    const returnedPaidQuantity = Math.min(
        originalQuantity,
        roundQuantity(getOrderLineReturnedPaidInventoryQuantity({
            ...item,
            returnedQuantity: overrides.returnedQuantity ?? item.returnedQuantity,
            returnedPaidInventoryQuantity: overrides.returnedPaidInventoryQuantity ?? item.returnedPaidInventoryQuantity
        }) / normalizedFactor)
    )
    const remainingQuantity = roundQuantity(Math.max(0, originalQuantity - returnedPaidQuantity))
    const originalLineTotal = normalizeAmount(item.lineTotal)
    const remainingLineTotal = overrides.returnedAmount !== undefined
        ? roundPrintedAmount(Math.max(0, originalLineTotal - normalizeAmount(overrides.returnedAmount)))
        : originalQuantity > RETURN_EPSILON
            ? roundPrintedAmount(originalLineTotal * (remainingQuantity / originalQuantity))
            : originalLineTotal
    const status: OrderPrintReturnStatus = returnedQuantity <= RETURN_EPSILON
        ? 'active'
        : inventoryQuantity > RETURN_EPSILON && returnedQuantity >= inventoryQuantity - RETURN_EPSILON
            ? 'fully-returned'
            : 'partially-returned'

    return {
        status,
        originalQuantity,
        remainingQuantity,
        originalLineTotal,
        remainingLineTotal
    }
}

export function getA4OrderPrintReturnRowStyle(status: OrderPrintReturnStatus) {
    return status === 'active' ? undefined : A4_RETURN_ROW_COLORS[status]
}
