import type { WorkspaceDataMode } from '@/local-db/models'

const WORKSPACE_MODE_PREFIX = 'asaas_workspace_mode:'

export interface WorkspaceModeSnapshot {
    workspaceId: string
    dataMode: WorkspaceDataMode
}

const defaultSnapshot: Omit<WorkspaceModeSnapshot, 'workspaceId'> = {
    dataMode: 'cloud'
}

const inMemorySnapshots = new Map<string, WorkspaceModeSnapshot>()

function canUseLocalStorage() {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function getWorkspaceModeKey(workspaceId: string) {
    return `${WORKSPACE_MODE_PREFIX}${workspaceId}`
}

function normalizeWorkspaceModeSnapshot(
    workspaceId: string,
    input?: Partial<Omit<WorkspaceModeSnapshot, 'workspaceId'>> | null
): WorkspaceModeSnapshot {
    return {
        workspaceId,
        dataMode: input?.dataMode === 'local' ? 'local' : 'cloud'
    }
}

function parseWorkspaceModeSnapshot(value: string, workspaceId: string): WorkspaceModeSnapshot | null {
    try {
        const parsed = JSON.parse(value) as Partial<WorkspaceModeSnapshot>
        if (!parsed || parsed.workspaceId !== workspaceId) {
            return null
        }

        return normalizeWorkspaceModeSnapshot(workspaceId, {
            dataMode: parsed.dataMode
        })
    } catch {
        return null
    }
}

export function readWorkspaceModeSnapshot(workspaceId?: string | null): WorkspaceModeSnapshot | null {
    if (!workspaceId) return null

    const inMemory = inMemorySnapshots.get(workspaceId)
    if (inMemory) {
        return inMemory
    }

    if (!canUseLocalStorage()) {
        return null
    }

    const raw = localStorage.getItem(getWorkspaceModeKey(workspaceId))
    if (!raw) {
        return null
    }

    const snapshot = parseWorkspaceModeSnapshot(raw, workspaceId)
    if (!snapshot) {
        localStorage.removeItem(getWorkspaceModeKey(workspaceId))
        return null
    }

    inMemorySnapshots.set(workspaceId, snapshot)
    return snapshot
}

export function writeWorkspaceModeSnapshot(
    snapshot: {
        workspaceId: string
        dataMode?: WorkspaceDataMode | null
    }
) {
    const normalized = normalizeWorkspaceModeSnapshot(snapshot.workspaceId, {
        dataMode: snapshot.dataMode ?? undefined
    })

    inMemorySnapshots.set(normalized.workspaceId, normalized)

    if (canUseLocalStorage()) {
        localStorage.setItem(getWorkspaceModeKey(normalized.workspaceId), JSON.stringify(normalized))
    }

    return normalized
}

export function clearWorkspaceModeSnapshot(workspaceId?: string | null) {
    if (workspaceId) {
        inMemorySnapshots.delete(workspaceId)
        if (canUseLocalStorage()) {
            localStorage.removeItem(getWorkspaceModeKey(workspaceId))
        }
        return
    }

    inMemorySnapshots.clear()

    if (!canUseLocalStorage()) {
        return
    }

    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key?.startsWith(WORKSPACE_MODE_PREFIX)) {
            keysToRemove.push(key)
        }
    }

    keysToRemove.forEach((key) => localStorage.removeItem(key))
}

export function getWorkspaceDataMode(workspaceId?: string | null): WorkspaceDataMode {
    return readWorkspaceModeSnapshot(workspaceId)?.dataMode ?? defaultSnapshot.dataMode
}

export function isLocalWorkspaceMode(workspaceId?: string | null) {
    return getWorkspaceDataMode(workspaceId) === 'local'
}

export function isCloudWorkspaceMode(workspaceId?: string | null) {
    return getWorkspaceDataMode(workspaceId) === 'cloud'
}
