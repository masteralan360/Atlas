import type { SyncResult } from './syncEngine'
import { fullSync } from './syncEngine'
import {
    subscribeAppMaintenance
} from '@/lib/appMaintenanceState'
import { isWorkspaceMaintenanceBlockingDataAccess } from '@/lib/appMaintenanceAccess'

interface ActiveSync {
    key: string
    workspaceId: string
    isFullPull: boolean
    maintenanceInterrupted: boolean
    promise: Promise<SyncResult>
}

let activeSync: ActiveSync | null = null
let queuedFullSync: { key: string; promise: Promise<SyncResult> } | null = null
let queuedMaintenanceSync: { key: string; promise: Promise<SyncResult> } | null = null

subscribeAppMaintenance(() => {
    if (activeSync && isWorkspaceMaintenanceBlockingDataAccess(activeSync.workspaceId)) {
        activeSync.maintenanceInterrupted = true
    }
})

function startManagedSync(
    userId: string,
    workspaceId: string,
    lastSyncTime: string | null
): Promise<SyncResult> {
    if (isWorkspaceMaintenanceBlockingDataAccess(workspaceId)) {
        return Promise.resolve({
            success: false,
            pushed: 0,
            pulled: 0,
            errors: [],
            maintenanceDeferred: true
        })
    }

    const key = `${userId}:${workspaceId}`
    const promise = fullSync(userId, workspaceId, lastSyncTime).finally(() => {
        if (activeSync?.promise === promise) activeSync = null
    })
    activeSync = {
        key,
        workspaceId,
        isFullPull: lastSyncTime === null,
        maintenanceInterrupted: false,
        promise
    }
    return promise
}

export function runManagedFullSync(
    userId: string,
    workspaceId: string,
    lastSyncTime: string | null
): Promise<SyncResult> {
    if (isWorkspaceMaintenanceBlockingDataAccess(workspaceId)) {
        return Promise.resolve({
            success: false,
            pushed: 0,
            pulled: 0,
            errors: [],
            maintenanceDeferred: true
        })
    }

    const key = `${userId}:${workspaceId}`
    const requiresFullPull = lastSyncTime === null

    if (!activeSync) {
        return startManagedSync(userId, workspaceId, lastSyncTime)
    }

    if (activeSync.key === key && activeSync.maintenanceInterrupted) {
        if (queuedMaintenanceSync?.key === key) return queuedMaintenanceSync.promise

        const waitForActive = activeSync.promise.catch(() => undefined)
        const promise = waitForActive
            .then(() => runManagedFullSync(userId, workspaceId, lastSyncTime))
            .finally(() => {
                if (queuedMaintenanceSync?.promise === promise) queuedMaintenanceSync = null
            })
        queuedMaintenanceSync = { key, promise }
        return promise
    }

    if (activeSync.key === key && (!requiresFullPull || activeSync.isFullPull)) {
        return activeSync.promise
    }

    // Offline preparation must never mistake an in-flight incremental sync for
    // a complete workspace download. Queue one full pull immediately behind it.
    if (requiresFullPull) {
        if (queuedFullSync?.key === key) return queuedFullSync.promise

        const waitForActive = activeSync.promise.catch(() => undefined)
        const promise = waitForActive
            .then(() => startManagedSync(userId, workspaceId, null))
            .finally(() => {
                if (queuedFullSync?.promise === promise) queuedFullSync = null
            })
        queuedFullSync = { key, promise }
        return promise
    }

    // Preserve the existing single-flight behavior for ordinary automatic
    // syncs. A later full pull will queue if it needs stronger guarantees.
    return activeSync.promise
}
