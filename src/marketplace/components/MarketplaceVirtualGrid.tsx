import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtuoso, type Components } from 'react-virtuoso'

import { createMarketplaceGridRows, type MarketplaceGridRow } from './marketplaceVirtualGridRows'

export type MarketplaceGridBreakpoint = {
    minWidth: number
    columns: number
}

const defaultGridColumns: readonly MarketplaceGridBreakpoint[] = [
    { minWidth: 0, columns: 1 },
    { minWidth: 640, columns: 2 },
    { minWidth: 1280, columns: 3 }
]

function getColumnCount(breakpoints: readonly MarketplaceGridBreakpoint[]) {
    if (typeof window === 'undefined') {
        return breakpoints[0]?.columns ?? 1
    }

    return breakpoints.reduce((columnCount, breakpoint) => (
        window.matchMedia(`(min-width: ${breakpoint.minWidth}px)`).matches
            ? breakpoint.columns
            : columnCount
    ), breakpoints[0]?.columns ?? 1)
}

function useResponsiveColumnCount(breakpoints: readonly MarketplaceGridBreakpoint[]) {
    const breakpointKey = breakpoints.map(({ minWidth, columns }) => `${minWidth}:${columns}`).join('|')
    const stableBreakpoints = useMemo(() => (
        breakpointKey.split('|').map((breakpoint) => {
            const [minWidth = 0, columns = 1] = breakpoint.split(':').map(Number)
            return { minWidth, columns }
        })
    ), [breakpointKey])
    const [columnCount, setColumnCount] = useState(() => getColumnCount(stableBreakpoints))

    useEffect(() => {
        const updateColumnCount = () => setColumnCount(getColumnCount(stableBreakpoints))
        const mediaQueries = stableBreakpoints.map(({ minWidth }) => window.matchMedia(`(min-width: ${minWidth}px)`))

        updateColumnCount()
        mediaQueries.forEach((mediaQuery) => mediaQuery.addEventListener('change', updateColumnCount))

        return () => {
            mediaQueries.forEach((mediaQuery) => mediaQuery.removeEventListener('change', updateColumnCount))
        }
    }, [stableBreakpoints])

    return columnCount
}

function findScrollParent(element: HTMLElement | null) {
    let parent = element?.parentElement ?? null

    while (parent) {
        const overflowY = window.getComputedStyle(parent).overflowY
        if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
            return parent
        }

        parent = parent.parentElement
    }

    return null
}

type MarketplaceVirtualGridProps<Item> = {
    items: Item[]
    itemKey: (item: Item) => string
    renderItem: (item: Item, index: number) => ReactNode
    listClassName: string
    itemClassName?: string
    rowClassName?: string
    gridColumns?: readonly MarketplaceGridBreakpoint[]
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
    rowClassName = 'pb-6',
    gridColumns = defaultGridColumns,
    onEndReached,
    hasMore,
    isLoadingMore,
    useWindowScroll = true,
    customScrollParent
}: MarketplaceVirtualGridProps<Item>) {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const [detectedScrollParent, setDetectedScrollParent] = useState<HTMLElement | null>(null)
    const columnCount = useResponsiveColumnCount(gridColumns)
    const handleEndReached = useCallback(() => {
        if (hasMore && !isLoadingMore) {
            onEndReached()
        }
    }, [hasMore, isLoadingMore, onEndReached])

    const rows = useMemo(
        () => createMarketplaceGridRows(items, itemKey, columnCount),
        [columnCount, itemKey, items]
    )
    const components = useMemo<Components<MarketplaceGridRow<Item>>>(() => ({
        Item: ({ children, item: _item, ...itemProps }) => (
            <div {...itemProps} className={rowClassName}>
                {children}
            </div>
        )
    }), [rowClassName])
    const resolvedScrollParent = customScrollParent ?? detectedScrollParent

    useLayoutEffect(() => {
        if (customScrollParent) {
            setDetectedScrollParent(null)
            return
        }

        setDetectedScrollParent(findScrollParent(hostRef.current))
    }, [customScrollParent])

    return (
        <div ref={hostRef}>
            <Virtuoso
                key={resolvedScrollParent ? 'element-scroll' : 'window-scroll'}
                data={rows}
                useWindowScroll={useWindowScroll && !resolvedScrollParent}
                customScrollParent={resolvedScrollParent ?? undefined}
                components={components}
                computeItemKey={(_, row) => row.key}
                itemContent={(_, row) => (
                    <div className={listClassName}>
                        {row.items.map(({ item, index }) => (
                            <div key={itemKey(item)} className={itemClassName}>
                                {renderItem(item, index)}
                            </div>
                        ))}
                    </div>
                )}
                increaseViewportBy={{ top: 480, bottom: 960 }}
                overscan={360}
                endReached={handleEndReached}
            />
        </div>
    )
}
