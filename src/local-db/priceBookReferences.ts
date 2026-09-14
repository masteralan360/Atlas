import { db } from './database'
import { updateOfflineMutationPayload } from './offlineMutations'

function replacePriceBookItemIdInItems(value: unknown, previousId: string, canonicalId: string) {
    if (!Array.isArray(value)) return { value, changed: false }

    let changed = false
    const items = value.map((item) => {
        if (!item || typeof item !== 'object') return item
        const row = item as Record<string, unknown>
        if (row.priceBookItemId !== previousId && row.price_book_item_id !== previousId) return item

        changed = true
        return {
            ...row,
            ...(row.priceBookItemId === previousId ? { priceBookItemId: canonicalId } : {}),
            ...(row.price_book_item_id === previousId ? { price_book_item_id: canonicalId } : {})
        }
    })

    return { value: items, changed }
}

/** Keep local orders and their queued payloads attached when a natural-key upsert resolves to a server ID. */
export async function rekeyPriceBookItemReferences(previousId: string, canonicalId: string) {
    if (!previousId || previousId === canonicalId) return

    const queuedMutations = await db.offline_mutations
        .filter((mutation) => (
            (mutation.entityType === 'sales_orders' || mutation.entityType === 'purchase_orders')
            && mutation.status !== 'synced'
            && mutation.status !== 'acknowledged'
            && mutation.status !== 'abandoned'
        ))
        .toArray()
    await Promise.all(queuedMutations.map(async (mutation) => {
        const next = replacePriceBookItemIdInItems(mutation.payload.items, previousId, canonicalId)
        if (!next.changed) return
        await updateOfflineMutationPayload(
            mutation,
            { ...mutation.payload, items: next.value },
            { resetToPending: false },
        )
    }))

    await db.transaction(
        'rw',
        [db.sales_orders, db.purchase_orders],
        async () => {
            await db.sales_orders.toCollection().modify((order) => {
                const next = replacePriceBookItemIdInItems(order.items, previousId, canonicalId)
                if (next.changed) order.items = next.value as typeof order.items
            })
            await db.purchase_orders.toCollection().modify((order) => {
                const next = replacePriceBookItemIdInItems(order.items, previousId, canonicalId)
                if (next.changed) order.items = next.value as typeof order.items
            })
        }
    )
}
