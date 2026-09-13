import type { MarketplaceOrderItemRecord } from './MarketplaceOrderTypes'

export function getMarketplaceDisplayItems(items: MarketplaceOrderItemRecord[]) {
    const groupedItems = new Map<string, MarketplaceOrderItemRecord>()

    for (const [index, item] of items.entries()) {
        // A Jumla storefront product may be stored as multiple immutable lines
        // when it is fulfilled by more than one storage. Show it once to the
        // operator while retaining those individual storage lines for delivery
        // and ERP sales-order deduction.
        const key = item.allocation_group_id
            ? `allocation:${item.allocation_group_id}`
            : `line:${index}`
        const existing = groupedItems.get(key)

        if (!existing) {
            groupedItems.set(key, { ...item })
            continue
        }

        existing.quantity += Number(item.quantity ?? 0)
        existing.line_total += Number(item.line_total ?? 0)
    }

    return Array.from(groupedItems.values())
}
