import { useState } from 'react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { usePendingSyncMutations } from '@/local-db/hooks'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { useWorkspace } from '@/workspace'
import { ManualSyncModal } from './ManualSyncModal'
import { cn } from '@/lib/utils'
import { CloudOff, Check, AlertCircle, Loader2, TriangleAlert } from 'lucide-react'
import { useTheme } from './theme-provider'
import { useSyncProgress } from '@/sync/syncProgress'
import { isSyncIntegrityError } from '@/sync/syncErrors'
import { getAppMaintenanceSnapshot, subscribeAppMaintenance } from '@/lib/appMaintenanceState'
import { isMaintenanceModeActive } from '@/lib/network'

export function SyncStatusIndicator({ maintenanceOnly = false }: { maintenanceOnly?: boolean }) {
    const { t } = useTranslation()
    const pendingMutations = usePendingSyncMutations()
    const pendingCount = pendingMutations.length
    const integrityIssueCount = pendingMutations.filter((mutation) => isSyncIntegrityError(mutation.error)).length
    const isOnline = useNetworkStatus()
    const { isLocalMode } = useWorkspace()
    const syncProgress = useSyncProgress()
    const [isModalOpen, setIsModalOpen] = useState(false)
    const { style } = useTheme()
    const maintenanceActive = useSyncExternalStore(
        subscribeAppMaintenance,
        () => getAppMaintenanceSnapshot().active && isMaintenanceModeActive(),
        () => false
    )
    const maintenanceChecking = useSyncExternalStore(
        subscribeAppMaintenance,
        () => getAppMaintenanceSnapshot().eligible && getAppMaintenanceSnapshot().checking,
        () => false
    )

    if (maintenanceOnly && (isLocalMode || !maintenanceActive)) return null

    let status = {
        icon: Check,
        label: 'Synced',
        color: 'text-emerald-500',
        bgColor: 'bg-emerald-500/10',
        dotColor: 'bg-emerald-500',
        clickable: false
    }

    if (isLocalMode) {
        status = {
            icon: Check,
            label: 'Local Mode',
            color: 'text-sky-600',
            bgColor: 'bg-sky-500/10',
            dotColor: 'bg-sky-500',
            clickable: false
        }
    } else if (maintenanceActive) {
        status = {
            icon: TriangleAlert,
            label: pendingCount > 0
                ? t('sync.maintenanceActiveWithCount', { count: pendingCount, defaultValue: 'Maintenance Active ({{count}})' })
                : t('sync.maintenanceActive', { defaultValue: 'Maintenance Active' }),
            color: 'text-yellow-800 dark:text-yellow-200',
            bgColor: 'bg-yellow-300/70 dark:bg-yellow-900/70',
            dotColor: 'bg-yellow-500',
            clickable: false
        }
    } else if (maintenanceChecking) {
        status = {
            icon: Loader2,
            label: t('sync.checkingMaintenance', { defaultValue: 'Checking server status' }),
            color: 'text-yellow-800 dark:text-yellow-200',
            bgColor: 'bg-yellow-100 dark:bg-yellow-950/50',
            dotColor: 'bg-yellow-500',
            clickable: false
        }
    } else if (syncProgress.isSyncing) {
        const isPushingChanges = syncProgress.phase === 'pushing' && syncProgress.total > 0
        const isPullingUpdates = syncProgress.phase === 'pulling' && syncProgress.total > 0

        status = {
            icon: Loader2,
            label: isPushingChanges
                ? `Syncing ${syncProgress.completed}/${syncProgress.total}`
                : isPullingUpdates
                    ? `Checking ${syncProgress.completed}/${syncProgress.total}`
                    : 'Syncing...',
            color: 'text-primary',
            bgColor: 'bg-primary/10',
            dotColor: 'bg-primary',
            clickable: false
        }
    } else if (!isOnline) {
        status = {
            icon: CloudOff,
            label: pendingCount > 0 ? `Offline (${pendingCount})` : 'Offline',
            color: 'text-red-500',
            bgColor: 'bg-red-500/10',
            dotColor: 'bg-red-500',
            clickable: false
        }
    } else if (integrityIssueCount > 0) {
        status = {
            icon: AlertCircle,
            label: `Sync issue (${integrityIssueCount})`,
            color: 'text-red-500',
            bgColor: 'bg-red-500/10',
            dotColor: 'bg-red-500',
            clickable: true
        }
    } else if (pendingCount > 0) {
        status = {
            icon: AlertCircle,
            label: `Sync Needed (${pendingCount})`,
            color: 'text-amber-500',
            bgColor: 'bg-amber-500/10',
            dotColor: 'bg-amber-500',
            clickable: true
        }
    }

    const { icon: Icon, label, color, bgColor, dotColor, clickable } = status
    const isMaintenanceStatus = maintenanceActive || maintenanceChecking

    return (
        <>
            <button
                onClick={() => isOnline && pendingCount > 0 && setIsModalOpen(true)}
                disabled={isLocalMode || !isOnline || pendingCount === 0}
                className={cn(
                    'flex items-center gap-2 px-3 py-1.5 transition-all text-xs font-bold',
                    style === 'neo-orange' && !isMaintenanceStatus ? 'neo-indicator' : cn(bgColor, 'rounded-full'),
                    clickable ? 'hover:opacity-80 cursor-pointer' : 'cursor-default opacity-80'
                )}
                title={clickable
                    ? integrityIssueCount > 0
                        ? "A queued change needs attention. Click to review and retry it."
                        : "Click to sync changes"
                    : undefined}
            >
                <div className={cn(
                    'w-2 h-2',
                    style === 'neo-orange' ? "rounded-none" : "rounded-full",
                    dotColor
                )} />
                <Icon className={cn('w-4 h-4', syncProgress.isSyncing && 'animate-spin', style === 'neo-orange' && !isMaintenanceStatus ? 'text-current' : color)} />
                <span className={cn(style === 'neo-orange' && !isMaintenanceStatus ? 'text-current' : color)}>{label}</span>
            </button>

            <ManualSyncModal
                open={isModalOpen}
                onOpenChange={setIsModalOpen}
            />
        </>
    )
}
