// Application connectivity status. The ConnectionManager updates this only after
// a user confirms offline mode, or when the browser reports connectivity restored.
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

let isActuallyOnline = true;
let activeBusinessWorkspaceId: string | null = null;
let activeBusinessUserId: string | null = null;
const outboxOnlyWorkspaceIds = new Set<string>();

// Update the global state
export function setNetworkStatus(online: boolean) {
    isActuallyOnline = online;
}

export function setActiveBusinessWorkspace(workspaceId: string | null | undefined) {
    activeBusinessWorkspaceId = workspaceId ?? null;
}

export function setActiveBusinessUser(userId: string | null | undefined) {
    activeBusinessUserId = userId ?? null;
}

export function getActiveBusinessUserId() {
    return activeBusinessUserId;
}

export function getActiveBusinessWorkspaceId() {
    return activeBusinessWorkspaceId;
}

function getWorkspaceIdForBusinessData(workspaceId?: string | null) {
    return workspaceId ?? activeBusinessWorkspaceId;
}

/** Protocol-v1 workspaces commit every business mutation to SQLite first. */
export function setWorkspaceSyncProtocolVersion(
    workspaceId: string | null | undefined,
    version: number | null | undefined,
) {
    if (!workspaceId) return;
    if ((version ?? 0) >= 1) outboxOnlyWorkspaceIds.add(workspaceId);
    else outboxOnlyWorkspaceIds.delete(workspaceId);
}

export function isWorkspaceOutboxOnly(workspaceId?: string | null) {
    const resolvedWorkspaceId = getWorkspaceIdForBusinessData(workspaceId);
    return !!resolvedWorkspaceId && outboxOnlyWorkspaceIds.has(resolvedWorkspaceId);
}

export function isBusinessDataOnline(workspaceId?: string | null): boolean {
    const resolvedWorkspaceId = getWorkspaceIdForBusinessData(workspaceId);
    if (resolvedWorkspaceId && isLocalWorkspaceMode(resolvedWorkspaceId)) {
        return false;
    }

    if (resolvedWorkspaceId && outboxOnlyWorkspaceIds.has(resolvedWorkspaceId)) {
        return false;
    }

    return isActuallyOnline;
}

// Get the current robust status
export function isOnline(workspaceId?: string | null): boolean {
    return isBusinessDataOnline(workspaceId);
}
