export function resolveWorkspaceUsageOwnerId(
    workspaceId: string,
    sourceByBranchId: ReadonlyMap<string, string>
) {
    let ownerId = workspaceId
    const visited = new Set([ownerId])

    for (let depth = 0; depth < 16; depth++) {
        const sourceId = sourceByBranchId.get(ownerId)
        if (!sourceId || visited.has(sourceId)) break
        ownerId = sourceId
        visited.add(ownerId)
    }

    return ownerId
}
