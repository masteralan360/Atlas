export type LiveCollection<T> = T[] & {
    readonly isLoading: boolean
}

export function toLiveCollection<T>(items: T[] | undefined, isLoading: boolean): LiveCollection<T> {
    return Object.assign([...(items ?? [])], { isLoading }) as LiveCollection<T>
}
