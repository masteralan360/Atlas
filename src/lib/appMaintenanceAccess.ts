import { getActiveBusinessWorkspaceId } from '@/lib/network'
import { getAppMaintenanceSnapshot, isAppMaintenanceBlockingDataAccess } from '@/lib/appMaintenanceState'
import { isCloudWorkspaceMode, isHybridWorkspaceMode } from '@/workspace/workspaceMode'

export function isWorkspaceMaintenanceBlockingDataAccess(workspaceId?: string | null) {
    if (!workspaceId || (!isCloudWorkspaceMode(workspaceId) && !isHybridWorkspaceMode(workspaceId))) {
        return false
    }

    // The table represents a global server state. Once this app has observed
    // maintenance for its active Cloud/Hybrid workspace, every Cloud/Hybrid
    // workspace operation must be deferred until the global state clears.
    return isAppMaintenanceBlockingDataAccess()
}

export function isCurrentWorkspaceMaintenanceBlockingDataAccess() {
    const workspaceId = getActiveBusinessWorkspaceId() ?? getAppMaintenanceSnapshot().workspaceId
    return isWorkspaceMaintenanceBlockingDataAccess(workspaceId)
}
