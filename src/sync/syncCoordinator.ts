import type { SyncResult } from './syncEngine'
import { fullSync } from './syncEngine'

let activeSyncPromise: Promise<SyncResult> | null = null

export function runManagedFullSync(
    userId: string,
    workspaceId: string,
    lastSyncTime: string | null
): Promise<SyncResult> {
    if (activeSyncPromise) {
        return activeSyncPromise
    }

    activeSyncPromise = fullSync(userId, workspaceId, lastSyncTime).finally(() => {
        activeSyncPromise = null
    })

    return activeSyncPromise
}
