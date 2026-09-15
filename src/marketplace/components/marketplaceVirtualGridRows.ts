export type MarketplaceGridRow<Item> = {
    key: string
    items: Array<{
        item: Item
        index: number
    }>
}

export function createMarketplaceGridRows<Item>(
    items: Item[],
    itemKey: (item: Item) => string,
    columnCount: number
) {
    const rows: MarketplaceGridRow<Item>[] = []

    for (let index = 0; index < items.length; index += columnCount) {
        const rowItems = items.slice(index, index + columnCount).map((item, itemOffset) => ({
            item,
            index: index + itemOffset
        }))

        rows.push({
            key: rowItems.map(({ item }) => itemKey(item)).join('|'),
            items: rowItems
        })
    }

    return rows
}
