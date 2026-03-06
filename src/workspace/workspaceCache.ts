const LEGACY_WORKSPACE_CACHE_KEY = 'asaas_workspace_cache'
const WORKSPACE_CACHE_VERSION = 2
const WORKSPACE_CACHE_PREFIX = `${LEGACY_WORKSPACE_CACHE_KEY}:v${WORKSPACE_CACHE_VERSION}:`

export interface WorkspaceCacheSnapshot<TFeatures = Record<string, unknown>> {
    version: number
    workspaceId: string
    workspaceName: string | null
    updatedAt: string
    features: TFeatures
}

function canUseLocalStorage() {
    return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function getWorkspaceCacheKey(workspaceId: string) {
    return `${WORKSPACE_CACHE_PREFIX}${workspaceId}`
}

function isValidSnapshot<TFeatures>(
    snapshot: unknown,
    workspaceId: string
): snapshot is WorkspaceCacheSnapshot<TFeatures> {
    if (!snapshot || typeof snapshot !== 'object') return false

    const candidate = snapshot as Partial<WorkspaceCacheSnapshot<TFeatures>>

    return (
        candidate.version === WORKSPACE_CACHE_VERSION &&
        typeof candidate.workspaceId === 'string' &&
        candidate.workspaceId.length > 0 &&
        candidate.workspaceId === workspaceId &&
        'features' in candidate
    )
}

export function clearLegacyWorkspaceCache() {
    if (!canUseLocalStorage()) return
    localStorage.removeItem(LEGACY_WORKSPACE_CACHE_KEY)
}

export function readWorkspaceCache<TFeatures>(workspaceId: string): WorkspaceCacheSnapshot<TFeatures> | null {
    if (!canUseLocalStorage() || !workspaceId) return null

    clearLegacyWorkspaceCache()

    const cacheKey = getWorkspaceCacheKey(workspaceId)
    const rawValue = localStorage.getItem(cacheKey)

    if (!rawValue) return null

    try {
        const parsed = JSON.parse(rawValue) as unknown
        if (!isValidSnapshot<TFeatures>(parsed, workspaceId)) {
            localStorage.removeItem(cacheKey)
            return null
        }

        return parsed
    } catch {
        localStorage.removeItem(cacheKey)
        return null
    }
}

export function writeWorkspaceCache<TFeatures>(
    snapshot: Omit<WorkspaceCacheSnapshot<TFeatures>, 'version' | 'updatedAt'> & { updatedAt?: string }
): WorkspaceCacheSnapshot<TFeatures> {
    const normalizedSnapshot: WorkspaceCacheSnapshot<TFeatures> = {
        version: WORKSPACE_CACHE_VERSION,
        workspaceId: snapshot.workspaceId,
        workspaceName: snapshot.workspaceName,
        updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
        features: snapshot.features
    }

    if (!canUseLocalStorage() || !snapshot.workspaceId) {
        return normalizedSnapshot
    }

    clearLegacyWorkspaceCache()
    localStorage.setItem(getWorkspaceCacheKey(snapshot.workspaceId), JSON.stringify(normalizedSnapshot))

    return normalizedSnapshot
}

export function clearWorkspaceCache(workspaceId?: string) {
    if (!canUseLocalStorage()) return

    clearLegacyWorkspaceCache()

    if (workspaceId) {
        localStorage.removeItem(getWorkspaceCacheKey(workspaceId))
        return
    }

    const keysToDelete: string[] = []

    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (key?.startsWith(WORKSPACE_CACHE_PREFIX)) {
            keysToDelete.push(key)
        }
    }

    for (const key of keysToDelete) {
        localStorage.removeItem(key)
    }
}
