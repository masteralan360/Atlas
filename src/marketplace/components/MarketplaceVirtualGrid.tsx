import { useCallback, type ReactNode } from 'react'
import { VirtuosoGrid } from 'react-virtuoso'

type MarketplaceVirtualGridProps<Item> = {
    items: Item[]
    itemKey: (item: Item) => string
    renderItem: (item: Item, index: number) => ReactNode
    listClassName: string
    itemClassName?: string
    onEndReached: () => void
    hasMore: boolean
    isLoadingMore: boolean
    useWindowScroll?: boolean
    customScrollParent?: HTMLElement | null
}

export function MarketplaceVirtualGrid<Item>({
    items,
    itemKey,
    renderItem,
    listClassName,
    itemClassName,
    onEndReached,
    hasMore,
    isLoadingMore,
    useWindowScroll = true,
    customScrollParent
}: MarketplaceVirtualGridProps<Item>) {
    const handleEndReached = useCallback(() => {
        if (hasMore && !isLoadingMore) {
            onEndReached()
        }
    }, [hasMore, isLoadingMore, onEndReached])

    return (
        <VirtuosoGrid
            data={items}
            useWindowScroll={useWindowScroll}
            customScrollParent={customScrollParent ?? undefined}
            computeItemKey={(_, item) => itemKey(item)}
            itemContent={(index, item) => renderItem(item, index)}
            listClassName={listClassName}
            itemClassName={itemClassName}
            increaseViewportBy={{ top: 480, bottom: 960 }}
            overscan={360}
            endReached={handleEndReached}
        />
    )
}
