import type { Sale } from '@/types'

/**
 * Returns the monetary amount shown for a row in Sales History.
 *
 * Sales-order line totals are the pre-order-adjustment values. Their persisted
 * total is therefore the authoritative net amount after the order discount,
 * tax, commercial adjustments, and posted returns have been applied.
 */
export function getSalesHistoryRowTotal(sale: Pick<Sale, 'origin' | 'total_amount' | 'is_returned' | 'items'>): number {
    if (sale.is_returned) return 0

    const persistedTotal = Number(sale.total_amount)
    if (sale.origin === 'sales_order' && Number.isFinite(persistedTotal)) {
        return persistedTotal
    }

    if (sale.items && sale.items.length > 0) {
        const allItemsReturned = sale.items.every((item) =>
            item.is_returned || (item.returned_quantity || 0) >= item.quantity
        )
        if (allItemsReturned) return 0

        return sale.items.reduce((sum, item) => {
            const quantity = item.quantity || 0
            const returnedQuantity = item.returned_quantity || 0
            const remainingQuantity = Math.max(0, quantity - returnedQuantity)
            if (remainingQuantity <= 0) return sum

            const unitPrice = item.converted_unit_price || item.unit_price || 0
            return sum + (unitPrice * remainingQuantity)
        }, 0)
    }

    return Number.isFinite(persistedTotal) ? persistedTotal : 0
}
