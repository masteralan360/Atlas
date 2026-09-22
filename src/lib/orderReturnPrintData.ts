import type { OrderAdjustment, OrderReturn, OrderReturnItem, SalesOrder } from '@/local-db/models'
import { getOrderLineInventoryQuantity, getOrderLineUnitFactor } from '@/lib/orderLineItems'
import { isPostReturnOrderAdjustment, normalizeOrderAdjustments } from '@/lib/orderAdjustments'
import { roundOrderValue } from '@/lib/orderPrecision'

const RETURN_EPSILON = 0.000001

export type SalesOrderReturnPrintLine = {
    orderItemId: string
    /** Total inventory quantity restored in the base unit. */
    returnedQuantity: number
    /** Total commercial quantity returned in the selling unit, including free bonus units. */
    selectedUnitQuantity: number
    /** Commercial quantity that contributes to the monetary refund. */
    paidSelectedUnitQuantity: number
    refundAmount: number
    unitRefundAmount: number
}

/** Immutable correction linked to one of the return records in this document. */
export type SalesOrderReturnPrintAdjustment = OrderAdjustment

export type SalesOrderReturnPrintData = {
    status: 'partial' | 'full'
    returnedAt?: string | null
    /** Item refunds before post-return corrections. */
    baseRefundAmount: number
    /** Signed effect on the refund: a deduction increases it, an addition reduces it. */
    adjustmentAmount: number
    totalRefundAmount: number
    lines: SalesOrderReturnPrintLine[]
    adjustments: SalesOrderReturnPrintAdjustment[]
}

function positiveNumber(value: unknown) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

/**
 * Produces the immutable data model used by a sales-return document. It only
 * includes items belonging to posted return records, so original order totals
 * and unreturned order lines cannot leak into a return print.
 */
export function createSalesOrderReturnPrintData(
    order: SalesOrder,
    orderReturns: readonly OrderReturn[],
    returnItems: readonly OrderReturnItem[]
): SalesOrderReturnPrintData | null {
    const postedReturns = orderReturns.filter((entry) => !entry.isDeleted && entry.status === 'posted')
    if (postedReturns.length === 0) return null

    const postedReturnIds = new Set(postedReturns.map((entry) => entry.id))
    const knownOrderItemIds = new Set(order.items.map((item) => item.id))
    const linesByOrderItemId = new Map<string, SalesOrderReturnPrintLine>()

    for (const returnItem of returnItems) {
        if (returnItem.isDeleted || !postedReturnIds.has(returnItem.returnId) || !knownOrderItemIds.has(returnItem.orderItemId)) {
            continue
        }

        const returnedQuantity = positiveNumber(returnItem.inventoryQuantity ?? returnItem.quantity)
        if (returnedQuantity <= RETURN_EPSILON) continue
        const orderItem = order.items.find((item) => item.id === returnItem.orderItemId)
        const selectedUnitQuantity = positiveNumber(
            returnItem.selectedUnitQuantity ?? returnedQuantity / getOrderLineUnitFactor(orderItem || {})
        )
        const paidSelectedUnitQuantity = positiveNumber(
            returnItem.paidSelectedUnitQuantity
            ?? (returnItem.paidInventoryQuantity != null
                ? Number(returnItem.paidInventoryQuantity) / getOrderLineUnitFactor(orderItem || {})
                : returnItem.quantityKind === 'free'
                    ? 0
                    : selectedUnitQuantity)
        )

        const existing = linesByOrderItemId.get(returnItem.orderItemId)
        const refundAmount = positiveNumber(returnItem.refundAmount)
        if (existing) {
            existing.returnedQuantity += returnedQuantity
            existing.selectedUnitQuantity += selectedUnitQuantity
            existing.paidSelectedUnitQuantity += paidSelectedUnitQuantity
            existing.refundAmount += refundAmount
            existing.unitRefundAmount = existing.paidSelectedUnitQuantity > RETURN_EPSILON
                ? existing.refundAmount / existing.paidSelectedUnitQuantity
                : 0
        } else {
            linesByOrderItemId.set(returnItem.orderItemId, {
                orderItemId: returnItem.orderItemId,
                returnedQuantity,
                selectedUnitQuantity,
                paidSelectedUnitQuantity,
                refundAmount,
                unitRefundAmount: paidSelectedUnitQuantity > RETURN_EPSILON
                    ? refundAmount / paidSelectedUnitQuantity
                    : 0
            })
        }
    }

    const lines = order.items
        .map((item) => linesByOrderItemId.get(item.id))
        .filter((line): line is SalesOrderReturnPrintLine => Boolean(line))

    if (lines.length === 0) return null

    const returnedQuantityByOrderItemId = new Map(lines.map((line) => [line.orderItemId, line.returnedQuantity]))
    const calculatedFullReturn = order.items.length > 0 && order.items.every((item) =>
        (returnedQuantityByOrderItemId.get(item.id) || 0) + RETURN_EPSILON >= getOrderLineInventoryQuantity(item)
    )
    const latestReturn = postedReturns.reduce<OrderReturn | null>((latest, entry) =>
        !latest || entry.returnedAt > latest.returnedAt ? entry : latest
    , null)

    const adjustments = normalizeOrderAdjustments(order.orderAdjustments, order.currency)
        .filter((adjustment) => isPostReturnOrderAdjustment(adjustment)
            && adjustment.returnId
            && postedReturnIds.has(adjustment.returnId))
    const baseRefundAmount = roundOrderValue(lines.reduce((sum, line) => sum + line.refundAmount, 0))
    const adjustmentAmount = roundOrderValue(adjustments.reduce((sum, adjustment) => (
        sum + (adjustment.type === 'deduction' ? adjustment.convertedAmount : -adjustment.convertedAmount)
    ), 0))

    return {
        status: order.returnStatus === 'full' || calculatedFullReturn ? 'full' : 'partial',
        returnedAt: latestReturn?.returnedAt || null,
        baseRefundAmount,
        adjustmentAmount,
        totalRefundAmount: roundOrderValue(baseRefundAmount + adjustmentAmount),
        lines,
        adjustments
    }
}

/** A representative return is used while a user designs a new return template. */
export function createSampleSalesOrderReturnPrintData(order: SalesOrder): SalesOrderReturnPrintData {
    const firstItem = order.items[0]
    if (!firstItem) {
        return {
            status: 'partial',
            returnedAt: new Date().toISOString(),
            baseRefundAmount: 0,
            adjustmentAmount: 0,
            totalRefundAmount: 0,
            lines: [],
            adjustments: []
        }
    }

    const selectedUnitQuantity = Math.min(1, positiveNumber(firstItem.quantity))
    const returnedQuantity = selectedUnitQuantity * getOrderLineUnitFactor(firstItem)
    const unitRefundAmount = positiveNumber(firstItem.convertedUnitPrice)
    return {
        status: 'partial',
        returnedAt: new Date().toISOString(),
        baseRefundAmount: selectedUnitQuantity * unitRefundAmount,
        adjustmentAmount: 0,
        totalRefundAmount: selectedUnitQuantity * unitRefundAmount,
        lines: [{
            orderItemId: firstItem.id,
            returnedQuantity,
            selectedUnitQuantity,
            paidSelectedUnitQuantity: selectedUnitQuantity,
            refundAmount: selectedUnitQuantity * unitRefundAmount,
            unitRefundAmount
        }],
        adjustments: []
    }
}
