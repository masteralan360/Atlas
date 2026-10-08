import { useMemo } from 'react'

export type LiveCollection<T> = T[] & {
    readonly isLoading: boolean
    readonly isHydrating: boolean
    readonly hydrationFailed: boolean
}

export function useLiveCollection<T>(
    items: T[] | undefined,
    isLoading: boolean,
    hydration: { isHydrating?: boolean; hydrationFailed?: boolean } = {}
): LiveCollection<T> {
    const isHydrating = hydration.isHydrating ?? false
    const hydrationFailed = hydration.hydrationFailed ?? false
    return useMemo(
        () => toLiveCollection(items, isLoading, { isHydrating, hydrationFailed }),
        [hydrationFailed, isHydrating, isLoading, items]
    )
}

export function toLiveCollection<T>(
    items: T[] | undefined,
    isLoading: boolean,
    hydration: { isHydrating?: boolean; hydrationFailed?: boolean } = {}
): LiveCollection<T> {
    return Object.assign([...(items ?? [])], {
        isLoading,
        isHydrating: hydration.isHydrating ?? false,
        hydrationFailed: hydration.hydrationFailed ?? false,
    }) as LiveCollection<T>
}

export function sortLiveCollection<T>(
    items: LiveCollection<T>,
    compare: (left: T, right: T) => number
): LiveCollection<T> {
    return toLiveCollection([...items].sort(compare), items.isLoading, {
        isHydrating: items.isHydrating,
        hydrationFailed: items.hydrationFailed,
    })
}
