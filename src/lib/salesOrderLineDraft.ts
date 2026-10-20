export type SalesOrderLineDraftIdentity = {
    clientId: string
    seq: number
}

/**
 * Existing sales-order line IDs include the insertion sequence as their final
 * field. Keep a fallback for older/imported IDs that do not use that format.
 */
export function getSalesOrderLineSequence(id: string, fallback: number) {
    const match = /-(\d+)$/.exec(id)
    const separatorCount = (id.match(/-/g) ?? []).length
    return match && separatorCount >= 7 ? Number(match[1]) : fallback
}

/** Sort only the view; the draft array keeps its original persistence order. */
export function getSalesOrderLinesNewestFirst<T extends SalesOrderLineDraftIdentity>(items: readonly T[]): T[] {
    return items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => right.item.seq - left.item.seq || left.index - right.index)
        .map(({ item }) => item)
}

export function appendSalesOrderLineDraft<T extends SalesOrderLineDraftIdentity>(
    items: readonly T[],
    createItem: (seq: number) => T
): T[] {
    const nextSeq = items.reduce((max, item) => Math.max(max, item.seq), 0) + 1
    return [...items, createItem(nextSeq)]
}

export function updateSalesOrderLineDraft<T extends SalesOrderLineDraftIdentity>(
    items: T[],
    clientId: string,
    updateItem: (item: T) => Partial<T>
): T[] {
    let found = false
    const next = items.map((item) => {
        if (item.clientId !== clientId) return item
        found = true
        return {
            ...item,
            ...updateItem(item),
            clientId: item.clientId,
            seq: item.seq
        }
    })
    return found ? next : items
}

export function removeSalesOrderLineDraft<T extends SalesOrderLineDraftIdentity>(
    items: T[],
    clientId: string
): T[] {
    const next = items.filter((item) => item.clientId !== clientId)
    return next.length === items.length ? items : next
}

export function shouldInitializeSalesOrderDraft(initializedOrderId: string | null, orderId: string | undefined) {
    return Boolean(orderId && initializedOrderId !== orderId)
}

export function getSalesOrderLineIdForSave(persistedId: string | undefined, createNewId: () => string) {
    return persistedId ?? createNewId()
}
