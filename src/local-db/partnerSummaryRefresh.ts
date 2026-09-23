const pendingRefreshes = new Map<string, Promise<unknown>>()

/** Read the latest records only after the previous summary write has finished. */
export function serializePartnerSummaryRefresh<T>(
    table: 'customers' | 'business_partners',
    workspaceId: string,
    partnerId: string,
    refresh: () => Promise<T>
): Promise<T> {
    const key = `${table}:${workspaceId}:${partnerId}`
    const previous = pendingRefreshes.get(key)
    // A failed refresh must not prevent a later save from repairing the summary.
    const pending = previous
        ? previous.then(refresh, refresh)
        : Promise.resolve().then(refresh)
    pendingRefreshes.set(key, pending)
    const clear = () => {
        if (pendingRefreshes.get(key) === pending) pendingRefreshes.delete(key)
    }
    void pending.then(clear, clear)
    return pending
}
