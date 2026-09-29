import { isSupabaseConfigured, supabase, createAppMaintenanceRealtimeChannel } from '@/auth/supabase'
import { WORKSPACE_USAGE_SKIP_HEADER } from '@/lib/workspaceUsageFetch'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { connectionManager } from '@/lib/connectionManager'
import {
    beginAppMaintenanceCheck,
    clearAppMaintenanceState,
    isAppMaintenanceBlockingDataAccess,
    setAppMaintenanceStatus
} from '@/lib/appMaintenanceState'
import type { WorkspaceDataMode } from '@/local-db/models'

type MaintenanceMonitor = {
    workspaceId: string
    channel: ReturnType<typeof createAppMaintenanceRealtimeChannel>
    cancelled: boolean
    realtimeRevision: number
    realtimeUnavailable: boolean
    fallbackTimer: ReturnType<typeof setTimeout> | null
    retryTimer: ReturnType<typeof setTimeout> | null
}

let currentMonitor: MaintenanceMonitor | null = null

function isEligibleMode(dataMode?: string | null) {
    return dataMode === 'cloud' || dataMode === 'hybrid'
}

function updateBlockingState(update: () => void) {
    const wasBlocked = isAppMaintenanceBlockingDataAccess()
    update()
    const isBlocked = isAppMaintenanceBlockingDataAccess()
    connectionManager.notifyMaintenanceAvailabilityChanged(wasBlocked, isBlocked)
}

export function stopAppMaintenanceMonitoring(workspaceId?: string | null) {
    if (workspaceId && currentMonitor?.workspaceId !== workspaceId) return

    const monitor = currentMonitor
    currentMonitor = null
    if (monitor) {
        monitor.cancelled = true
        if (monitor.fallbackTimer) clearTimeout(monitor.fallbackTimer)
        if (monitor.retryTimer) clearTimeout(monitor.retryTimer)
        void supabase.removeChannel(monitor.channel)
    }

    clearAppMaintenanceState(workspaceId)
}

/**
 * Starts the one global maintenance listener for Cloud/Hybrid workspaces.
 * The checking state is set synchronously so normal Supabase traffic is gated
 * before the initial read or other workspace effects can run.
 */
export function ensureAppMaintenanceMonitoring(
    workspaceId: string | null | undefined,
    dataMode: WorkspaceDataMode | string | null | undefined
) {
    if (!workspaceId || !isEligibleMode(dataMode) || !isSupabaseConfigured) {
        stopAppMaintenanceMonitoring()
        return
    }

    if (currentMonitor?.workspaceId === workspaceId && !currentMonitor.cancelled) return
    stopAppMaintenanceMonitoring()

    updateBlockingState(() => beginAppMaintenanceCheck(workspaceId, true))

    const monitor: MaintenanceMonitor = {
        workspaceId,
        channel: createAppMaintenanceRealtimeChannel(),
        cancelled: false,
        realtimeRevision: 0,
        realtimeUnavailable: false,
        fallbackTimer: null,
        retryTimer: null
    }
    currentMonitor = monitor

    let readFinished = false
    let readAttempt = 0
    function scheduleReadRetry() {
        if (monitor.retryTimer) clearTimeout(monitor.retryTimer)
        monitor.retryTimer = setTimeout(() => {
            monitor.retryTimer = null
            readCurrentState()
        }, 5000)
    }

    const readCurrentState = () => {
        if (monitor.cancelled || currentMonitor !== monitor) return
        const attempt = ++readAttempt
        const readRevision = monitor.realtimeRevision

        void runSupabaseAction(
            'appMaintenance.readState',
            () => supabase
                .from('app_maintenance')
                .select('maintenance')
                .eq('id', true)
                .setHeader(WORKSPACE_USAGE_SKIP_HEADER, '1')
                .maybeSingle(),
            { timeoutMs: 8000, platform: 'all' }
        )
            .then(({ data, error }) => {
                if (monitor.cancelled || currentMonitor !== monitor || attempt !== readAttempt) return
                readFinished = true
                if (monitor.fallbackTimer) clearTimeout(monitor.fallbackTimer)
                if (error) {
                    console.warn('[Maintenance] Could not read the current maintenance state:', error)
                    scheduleReadRetry()
                    return
                }

                if (monitor.realtimeUnavailable) {
                    scheduleReadRetry()
                } else {
                    if (monitor.retryTimer) clearTimeout(monitor.retryTimer)
                    monitor.retryTimer = null
                }

                if (monitor.realtimeRevision === readRevision) {
                    const maintenance = (data as { maintenance?: unknown } | null)?.maintenance
                    if (typeof maintenance !== 'boolean') {
                        console.warn('[Maintenance] The maintenance state row is missing or invalid; keeping cloud access gated.')
                        scheduleReadRetry()
                        return
                    }
                    updateBlockingState(() => setAppMaintenanceStatus(workspaceId, maintenance))
                }
            })
            .catch((error: unknown) => {
                if (monitor.cancelled || currentMonitor !== monitor || attempt !== readAttempt) return
                readFinished = true
                if (monitor.fallbackTimer) clearTimeout(monitor.fallbackTimer)
                console.warn('[Maintenance] Could not read the current maintenance state:', error)
                scheduleReadRetry()
            })
    }

    monitor.fallbackTimer = setTimeout(() => {
        monitor.fallbackTimer = null
        if (!readFinished) readCurrentState()
    }, 3000)

    monitor.channel
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'app_maintenance'
        }, (payload: { new?: unknown }) => {
            if (monitor.cancelled || currentMonitor !== monitor) return
            const maintenance = (payload.new as { maintenance?: unknown } | undefined)?.maintenance
            if (typeof maintenance !== 'boolean') {
                readCurrentState()
                return
            }
            monitor.realtimeRevision += 1
            updateBlockingState(() => setAppMaintenanceStatus(workspaceId, maintenance))
        })
        .subscribe((status: string) => {
            if (status === 'SUBSCRIBED') {
                monitor.realtimeUnavailable = false
                if (monitor.retryTimer) clearTimeout(monitor.retryTimer)
                monitor.retryTimer = null
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                monitor.realtimeUnavailable = true
            }
            if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                readCurrentState()
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.warn(`[Maintenance] Realtime subscription: ${status}`)
                scheduleReadRetry()
            }
        })
}
