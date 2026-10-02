export interface InstantPosServiceLine {
    productId: string
    quantity: number
    uomId?: string
    note?: string
}

export function coalesceInstantPosServiceItems<T extends InstantPosServiceLine>(
    items: T[],
    isService: (item: T) => boolean,
): T[] {
    const result: T[] = []
    const serviceIndexByProductId = new Map<string, number>()

    for (const item of items) {
        if (!isService(item)) {
            result.push(item)
            continue
        }

        const existingIndex = serviceIndexByProductId.get(item.productId)
        if (existingIndex === undefined) {
            serviceIndexByProductId.set(item.productId, result.length)
            result.push({ ...item, uomId: undefined })
            continue
        }

        const existing = result[existingIndex]
        const notes = [...new Set([existing.note, item.note].filter((note): note is string => Boolean(note?.trim())))]
        result[existingIndex] = {
            ...existing,
            quantity: existing.quantity + item.quantity,
            uomId: undefined,
            note: notes.length > 0 ? notes.join('\n') : undefined,
        }
    }

    return result
}

export function addInstantPosServiceItem<T extends InstantPosServiceLine>(items: T[], item: T): T[] {
    const serviceItem = { ...item, uomId: undefined }
    return coalesceInstantPosServiceItems(
        [...items, serviceItem],
        (candidate) => candidate.productId === serviceItem.productId,
    )
}
