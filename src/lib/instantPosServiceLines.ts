export interface InstantPosQuantityLine {
    quantity: number
    lineId?: string
}

/**
 * Turns a service quantity into distinct ticket lines while retaining legacy
 * fractional service quantities as a final partial line.
 */
export function splitInstantPosServiceLine<T extends InstantPosQuantityLine>(
    item: T,
    createLineId: () => string,
): T[] {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) return []

    const wholeQuantity = Math.floor(item.quantity)
    const fractionalQuantity = item.quantity - wholeQuantity
    const quantities = [
        ...Array.from({ length: wholeQuantity }, () => 1),
        ...(fractionalQuantity > 0 ? [fractionalQuantity] : []),
    ]

    return quantities.map((quantity, index) => ({
        ...item,
        lineId: index === 0 && item.lineId ? item.lineId : createLineId(),
        quantity,
    }))
}

export function normalizeInstantPosServiceLines<T extends InstantPosQuantityLine>(
    items: T[],
    isServiceLine: (item: T) => boolean,
    createLineId: () => string,
): T[] {
    return items.flatMap((item) => {
        if (!isServiceLine(item)) return [item]
        return splitInstantPosServiceLine(item, createLineId)
    })
}

export function appendInstantPosServiceLine<T extends InstantPosQuantityLine>(
    items: T[],
    item: T,
    createLineId: () => string,
): T[] {
    return [...items, ...splitInstantPosServiceLine({ ...item, quantity: 1 }, createLineId)]
}
