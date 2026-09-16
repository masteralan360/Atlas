import type { WorkspaceDataMode } from '@/local-db/models'

const WORKSPACE_DATA_FETCH_PREFIX = 'atlas_workspace_data_fetch:v2:'
const WORKSPACE_TABLE_HYDRATION_FETCH_PREFIX = 'atlas_workspace_table_hydration_fetch:v1:'

export const WORKSPACE_DATA_FETCH_EVENT = 'atlas:workspace-data-fetch'
export const WORKSPACE_DATA_HYDRATION_EVENT = 'atlas:workspace-data-hydration'

export type WorkspaceDataFetchSource = 'local' | 'supabase'

export interface WorkspaceDataFetchSnapshot {
    workspaceId: string
    source: WorkspaceDataFetchSource
    fetchedAt: string
    tableName?: string
}

/**
 * Internal cache freshness for a precise remote table read. Unlike the UI
 * freshness indicator, this must distinguish an active-rows snapshot from a
 * tombstone-inclusive snapshot so reconciliation is never skipped incorrectly.
 */
export interface WorkspaceTableHydrationFetchSnapshot {
    workspaceId: string
    source: WorkspaceDataFetchSource
    tableName: string
    scope: 'active' | 'all'
    fetchedAt: string
}

/**
 * The short-lived status of a remote data read. This deliberately lives in
 * memory rather than localStorage: a read that was in progress before a page
 * reload is not still in progress after it.
 */
export interface WorkspaceDataHydrationSnapshot {
    workspaceId: string
    source: WorkspaceDataFetchSource
    isLoading: boolean
    activeTableNames: string[]
    recordsFetched: number
    lastResult: {
        state: 'complete' | 'error'
        at: string
    } | null
}

type ActiveWorkspaceDataHydration = {
    workspaceId: string
    source: WorkspaceDataFetchSource
    tableName: string
    operationId: string
    recordsFetched: number
}

const activeHydrations = new Map<string, ActiveWorkspaceDataHydration>()
const lastHydrationResults = new Map<
    string,
    NonNullable<WorkspaceDataHydrationSnapshot['lastResult']>
>()

function canUseLocalStorage() {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function getWorkspaceDataFetchKey(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName?: string
) {
    return `${WORKSPACE_DATA_FETCH_PREFIX}${source}:${workspaceId}${tableName ? `:${tableName}` : ''}`
}

function getWorkspaceTableHydrationFetchKey(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    scope: WorkspaceTableHydrationFetchSnapshot['scope']
) {
    return `${WORKSPACE_TABLE_HYDRATION_FETCH_PREFIX}${source}:${workspaceId}:${tableName}:${scope}`
}

function getWorkspaceDataHydrationKey(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    operationId = 'default'
) {
    return `${source}:${workspaceId}:${tableName}:${operationId}`
}

function getWorkspaceDataHydrationResultKey(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string
) {
    return `${source}:${workspaceId}:${tableName}`
}

function isValidTimestamp(value: unknown): value is string {
    return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

function parseSnapshot(
    value: string,
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName?: string
): WorkspaceDataFetchSnapshot | null {
    try {
        const parsed = JSON.parse(value) as Partial<WorkspaceDataFetchSnapshot>
        if (
            parsed?.workspaceId !== workspaceId
            || parsed.source !== source
            || parsed.tableName !== tableName
            || !isValidTimestamp(parsed.fetchedAt)
        ) {
            return null
        }

        return {
            workspaceId,
            source,
            fetchedAt: new Date(parsed.fetchedAt).toISOString(),
            tableName
        }
    } catch {
        return null
    }
}

export function getWorkspaceDataFetchSource(dataMode?: WorkspaceDataMode | null): WorkspaceDataFetchSource {
    return dataMode === 'local' || dataMode === 'demo' ? 'local' : 'supabase'
}

export function readWorkspaceDataFetch(
    workspaceId?: string | null,
    source: WorkspaceDataFetchSource = 'supabase',
    tableNames?: readonly string[]
): WorkspaceDataFetchSnapshot | null {
    if (!workspaceId || !canUseLocalStorage()) return null

    const relevantTableNames = tableNames?.filter(Boolean) ?? []
    if (relevantTableNames.length > 0) {
        const snapshots = relevantTableNames
            .map((tableName) => {
                const key = getWorkspaceDataFetchKey(workspaceId, source, tableName)
                const value = localStorage.getItem(key)
                if (!value) return null
                const snapshot = parseSnapshot(value, workspaceId, source, tableName)
                if (!snapshot) localStorage.removeItem(key)
                return snapshot
            })
            .filter((snapshot): snapshot is WorkspaceDataFetchSnapshot => Boolean(snapshot))

        return snapshots.sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0] ?? null
    }

    const key = getWorkspaceDataFetchKey(workspaceId, source)
    const value = localStorage.getItem(key)
    if (!value) return null
    const snapshot = parseSnapshot(value, workspaceId, source)
    if (!snapshot) {
        localStorage.removeItem(key)
    }

    return snapshot
}

export function readWorkspaceTableHydrationFetch(
    workspaceId: string | undefined | null,
    source: WorkspaceDataFetchSource,
    tableName: string,
    scope: WorkspaceTableHydrationFetchSnapshot['scope']
): WorkspaceTableHydrationFetchSnapshot | null {
    if (!workspaceId || !tableName || !canUseLocalStorage()) return null

    const key = getWorkspaceTableHydrationFetchKey(workspaceId, source, tableName, scope)
    const value = localStorage.getItem(key)
    if (!value) return null

    try {
        const parsed = JSON.parse(value) as Partial<WorkspaceTableHydrationFetchSnapshot>
        if (
            parsed.workspaceId !== workspaceId
            || parsed.source !== source
            || parsed.tableName !== tableName
            || parsed.scope !== scope
            || !isValidTimestamp(parsed.fetchedAt)
        ) {
            localStorage.removeItem(key)
            return null
        }

        return {
            workspaceId,
            source,
            tableName,
            scope,
            fetchedAt: new Date(parsed.fetchedAt).toISOString()
        }
    } catch {
        localStorage.removeItem(key)
        return null
    }
}

export function readWorkspaceDataHydration(
    workspaceId?: string | null,
    source: WorkspaceDataFetchSource = 'supabase',
    tableNames?: readonly string[]
): WorkspaceDataHydrationSnapshot | null {
    if (!workspaceId) return null

    const relevantTableNames = tableNames?.filter(Boolean) ?? []
    const includesTable = (tableName: string) => (
        relevantTableNames.length === 0 || relevantTableNames.includes(tableName)
    )
    const active = Array.from(activeHydrations.values())
        .filter((entry) => entry.workspaceId === workspaceId && entry.source === source && includesTable(entry.tableName))
    const results = relevantTableNames.length === 0
        ? Array.from(lastHydrationResults.entries())
            .filter(([key]) => key.startsWith(`${source}:${workspaceId}:`))
            .map(([, result]) => result)
        : relevantTableNames
            .map((tableName) => lastHydrationResults.get(getWorkspaceDataHydrationResultKey(workspaceId, source, tableName)))
            .filter((result): result is NonNullable<WorkspaceDataHydrationSnapshot['lastResult']> => Boolean(result))
    const latestFailure = results
        .filter((result) => result.state === 'error')
        .sort((left, right) => right.at.localeCompare(left.at))[0] ?? null
    const latestCompletion = results
        .filter((result) => result.state === 'complete')
        .sort((left, right) => right.at.localeCompare(left.at))[0] ?? null

    return {
        workspaceId,
        source,
        isLoading: active.length > 0,
        activeTableNames: Array.from(new Set(active.map((entry) => entry.tableName))).sort(),
        recordsFetched: active.reduce((total, entry) => total + entry.recordsFetched, 0),
        // A successful table must not conceal a failure from another table in
        // the same module refresh. The user can then retry knowing that the
        // shown cached data may still be incomplete.
        lastResult: latestFailure ?? latestCompletion
    }
}

function publishWorkspaceDataHydration(workspaceId: string, source: WorkspaceDataFetchSource) {
    const snapshot = readWorkspaceDataHydration(workspaceId, source)
    if (!snapshot) return

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent<WorkspaceDataHydrationSnapshot>(WORKSPACE_DATA_HYDRATION_EVENT, {
            detail: snapshot
        }))
    }
}

/** Records that a paginated data reader has begun checking the remote source. */
export function startWorkspaceDataHydration(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    operationId?: string
) {
    activeHydrations.set(getWorkspaceDataHydrationKey(workspaceId, source, tableName, operationId), {
        workspaceId,
        source,
        tableName,
        operationId: operationId ?? 'default',
        recordsFetched: 0
    })
    lastHydrationResults.delete(getWorkspaceDataHydrationResultKey(workspaceId, source, tableName))
    publishWorkspaceDataHydration(workspaceId, source)
}

/** Updates the non-blocking progress indicator after a page is received. */
export function updateWorkspaceDataHydrationProgress(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    recordsFetched: number,
    operationId?: string
) {
    const hydration = activeHydrations.get(getWorkspaceDataHydrationKey(workspaceId, source, tableName, operationId))
    if (!hydration) return

    hydration.recordsFetched = Math.max(0, Math.trunc(recordsFetched))
    publishWorkspaceDataHydration(workspaceId, source)
}

function finishWorkspaceDataHydration(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    state: NonNullable<WorkspaceDataHydrationSnapshot['lastResult']>['state'],
    at = new Date().toISOString(),
    operationId?: string
) {
    activeHydrations.delete(getWorkspaceDataHydrationKey(workspaceId, source, tableName, operationId))
    const resultAt = isValidTimestamp(at) ? new Date(at).toISOString() : new Date().toISOString()
    lastHydrationResults.set(getWorkspaceDataHydrationResultKey(workspaceId, source, tableName), { state, at: resultAt })
    publishWorkspaceDataHydration(workspaceId, source)
}

/** Marks a reader as having reached its final page: the server has no more rows for this read. */
export function completeWorkspaceDataHydration(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    completedAt?: string,
    operationId?: string
) {
    finishWorkspaceDataHydration(workspaceId, source, tableName, 'complete', completedAt, operationId)
}

/** Makes a failed background check visible without removing usable cached rows. */
export function failWorkspaceDataHydration(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    failedAt?: string,
    operationId?: string
) {
    finishWorkspaceDataHydration(workspaceId, source, tableName, 'error', failedAt, operationId)
}

/** Stops an abandoned read without presenting it as either complete or failed. */
export function cancelWorkspaceDataHydration(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    operationId?: string
) {
    activeHydrations.delete(getWorkspaceDataHydrationKey(workspaceId, source, tableName, operationId))
    publishWorkspaceDataHydration(workspaceId, source)
}

export function recordWorkspaceDataFetch(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    fetchedAt = new Date().toISOString(),
    tableName?: string
): WorkspaceDataFetchSnapshot {
    const snapshot: WorkspaceDataFetchSnapshot = {
        workspaceId,
        source,
        fetchedAt: isValidTimestamp(fetchedAt) ? new Date(fetchedAt).toISOString() : new Date().toISOString(),
        tableName
    }

    if (canUseLocalStorage()) {
        if (tableName) {
            localStorage.setItem(getWorkspaceDataFetchKey(workspaceId, source, tableName), JSON.stringify(snapshot))
        }
        // Preserve the existing workspace-wide freshness timestamp for pages
        // that have not yet declared their data tables.
        localStorage.setItem(
            getWorkspaceDataFetchKey(workspaceId, source),
            JSON.stringify({ ...snapshot, tableName: undefined })
        )
    }

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent<WorkspaceDataFetchSnapshot>(WORKSPACE_DATA_FETCH_EVENT, {
            detail: snapshot
        }))
    }

    return snapshot
}

export function recordWorkspaceTableHydrationFetch(
    workspaceId: string,
    source: WorkspaceDataFetchSource,
    tableName: string,
    scope: WorkspaceTableHydrationFetchSnapshot['scope'],
    fetchedAt = new Date().toISOString()
): WorkspaceTableHydrationFetchSnapshot {
    const snapshot: WorkspaceTableHydrationFetchSnapshot = {
        workspaceId,
        source,
        tableName,
        scope,
        fetchedAt: isValidTimestamp(fetchedAt) ? new Date(fetchedAt).toISOString() : new Date().toISOString()
    }

    if (canUseLocalStorage()) {
        localStorage.setItem(
            getWorkspaceTableHydrationFetchKey(workspaceId, source, tableName, scope),
            JSON.stringify(snapshot)
        )
    }

    return snapshot
}
