export interface AppMaintenanceSnapshot {
    workspaceId: string | null
    eligible: boolean
    active: boolean
    checking: boolean
}

const listeners = new Set<() => void>()
let snapshot: AppMaintenanceSnapshot = {
    workspaceId: null,
    eligible: false,
    active: false,
    checking: false
}

function publish(next: AppMaintenanceSnapshot) {
    if (
        snapshot.workspaceId === next.workspaceId
        && snapshot.eligible === next.eligible
        && snapshot.active === next.active
        && snapshot.checking === next.checking
    ) return

    snapshot = next
    listeners.forEach((listener) => listener())
}

export function subscribeAppMaintenance(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function getAppMaintenanceSnapshot(): AppMaintenanceSnapshot {
    return snapshot
}

export function beginAppMaintenanceCheck(workspaceId: string, eligible: boolean) {
    publish({
        workspaceId: eligible ? workspaceId : null,
        eligible,
        active: false,
        checking: eligible
    })
}

export function setAppMaintenanceStatus(workspaceId: string, active: boolean) {
    if (!snapshot.eligible || snapshot.workspaceId !== workspaceId) return false
    publish({ ...snapshot, active, checking: false })
    return true
}

export function finishAppMaintenanceCheck(workspaceId: string) {
    if (!snapshot.eligible || snapshot.workspaceId !== workspaceId) return false
    publish({ ...snapshot, checking: false })
    return true
}

export function clearAppMaintenanceState(workspaceId?: string | null) {
    if (workspaceId && snapshot.workspaceId !== workspaceId) return false
    publish({ workspaceId: null, eligible: false, active: false, checking: false })
    return true
}

export function isAppMaintenanceActive(workspaceId?: string | null) {
    return snapshot.eligible
        && snapshot.active
        && (!workspaceId || snapshot.workspaceId === workspaceId)
}

export function isAppMaintenanceBlockingDataAccess(workspaceId?: string | null) {
    return snapshot.eligible
        && (snapshot.active || snapshot.checking)
        && (!workspaceId || snapshot.workspaceId === workspaceId)
}
