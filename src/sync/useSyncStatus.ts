import { useState, useEffect, useCallback, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/local-db/database'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { useAuth } from '@/auth/AuthContext'
import { useWorkspace } from '@/workspace'
import { fullSync, type SyncState } from './syncEngine'
import { isSupabaseConfigured } from '@/auth/supabase'
import { connectionManager } from '@/lib/connectionManager'
import { toast } from '@/ui/components/use-toast'

const LAST_SYNC_KEY = 'atlas_last_sync_time'

export interface UseSyncStatusResult {
    syncState: SyncState
    pendingCount: number
    lastSyncTime: string | null
    lastSyncResult: { pushed: number; pulled: number } | null
    isOnline: boolean
    sync: () => Promise<void>
    isSyncing: boolean
}

export function useSyncStatus(): UseSyncStatusResult {
    const [syncState, setSyncState] = useState<SyncState>('idle')
    const [lastSyncTime, setLastSyncTime] = useState<string | null>(
        localStorage.getItem(LAST_SYNC_KEY)
    )
    const [lastSyncResult, setLastSyncResult] = useState<{
        pushed: number
        pulled: number
    } | null>(null)

    const isOnline = useNetworkStatus()
    const { user, isAuthenticated } = useAuth()
    const { isLocalMode } = useWorkspace()
    const syncInProgress = useRef(false)
    const lastSyncTimeRef = useRef(lastSyncTime)

    // Update ref when state changes
    useEffect(() => {
        lastSyncTimeRef.current = lastSyncTime
    }, [lastSyncTime])

    // Get pending sync count from offline_mutations
    const livePendingCount = useLiveQuery(() => db.offline_mutations.where('status').equals('pending').count(), []) ?? 0
    const pendingCount = isLocalMode ? 0 : livePendingCount

    // Perform sync
    const sync = useCallback(async () => {
        if (!isSupabaseConfigured || !isAuthenticated || !user || syncInProgress.current) {
            return
        }

        if (isLocalMode) {
            setSyncState('idle')
            return
        }

        if (!isOnline) {
            setSyncState('offline')
            return
        }

        syncInProgress.current = true
        setSyncState('syncing')

        try {
            console.log('[SyncHook] Starting sync execution...')
            const result = await fullSync(user.id, user.workspaceId, lastSyncTimeRef.current)
            console.log('[SyncHook] Sync finished with result:', result)

            const now = new Date().toISOString()
            setLastSyncTime(now)
            localStorage.setItem(LAST_SYNC_KEY, now)

            setLastSyncResult({
                pushed: result.pushed,
                pulled: result.pulled
            })

            setSyncState(result.success ? 'idle' : 'error')
        } catch (error) {
            console.error('[SyncHook] UNEXPECTED SYNC ERROR:', error)
            setSyncState('error')
        } finally {
            syncInProgress.current = false
        }
    }, [isLocalMode, isOnline, isAuthenticated, user])

    // ───────────────────────────────────────────────────────
    // RESILIENCE: Auto-sync on reconnect and wake
    // ───────────────────────────────────────────────────────
    useEffect(() => {
        if (!isSupabaseConfigured || !isAuthenticated || !user || isLocalMode) return

        let retryCount = 0
        let retryTimer: ReturnType<typeof setTimeout> | null = null
        const MAX_RETRIES = 3
        const RETRY_DELAYS = [5000, 15000, 30000] // exponential-ish backoff

        const attemptAutoSync = async (reason: string) => {
            if (syncInProgress.current || !isOnline) return

            // Check if there are pending mutations
            const pending = await db.offline_mutations.where('status').equals('pending').count()

            if (pending === 0) {
                // Still do a pull-only sync if last sync was > 10 min ago
                const lastSync = lastSyncTimeRef.current
                if (lastSync) {
                    const timeSinceSync = Date.now() - new Date(lastSync).getTime()
                    if (timeSinceSync < 10 * 60 * 1000) return // <10 min, skip
                }
            }

            console.log(`[SyncHook] Auto-sync triggered: ${reason} (pending: ${pending})`)

            toast({
                title: "Syncing your changes...",
                description: pending > 0 ? `${pending} pending change(s) will be synced.` : "Checking for updates.",
                variant: "default",
            })

            try {
                await sync()
                retryCount = 0 // reset on success
            } catch {
                retryCount++
                if (retryCount <= MAX_RETRIES) {
                    const delay = RETRY_DELAYS[retryCount - 1] || 30000
                    console.log(`[SyncHook] Auto-sync retry ${retryCount}/${MAX_RETRIES} in ${delay / 1000}s`)
                    retryTimer = setTimeout(() => attemptAutoSync('retry'), delay)
                }
            }
        }

        const unsubscribe = connectionManager.subscribe((event) => {
            if (event === 'online') {
                // Delay to let network stabilize
                retryTimer = setTimeout(() => attemptAutoSync('reconnected'), 3000)
            } else if (event === 'wake') {
                attemptAutoSync('wake')
            }
        })

        return () => {
            unsubscribe()
            if (retryTimer) clearTimeout(retryTimer)
        }
    }, [isAuthenticated, isLocalMode, user, isOnline, sync])

    return {
        syncState: isLocalMode ? 'idle' : syncState,
        pendingCount,
        lastSyncTime: isLocalMode ? null : lastSyncTime,
        lastSyncResult,
        isOnline,
        sync,
        isSyncing: !isLocalMode && syncState === 'syncing'
    }
}
