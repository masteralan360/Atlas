import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, UploadCloud } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'

import { useAuth } from '@/auth'
import { isSupabaseConfigured } from '@/auth/supabase'
import { db } from '@/local-db/database'
import { connectionManager } from '@/lib/connectionManager'
import { useWorkspace } from '@/workspace'
import { useToast } from '@/ui/components/use-toast'
import { LAST_SYNC_KEY } from '@/sync/constants'
import { isRecoverablePriceBookMutation } from '@/sync/syncEngine'
import { runManagedFullSync } from '@/sync/syncCoordinator'
import { useSyncProgress } from '@/sync/syncProgress'

const MIN_OVERLAY_MS = 800

async function countRecoverableMutations() {
    const [pending, leased, retryWait, syncing, failedSaleCreates, failedPriceBooks] = await Promise.all([
        db.offline_mutations.where('status').equals('pending').count(),
        db.offline_mutations.where('status').equals('leased').count(),
        db.offline_mutations
            .where('status')
            .equals('retry_wait')
            .filter((mutation) => !mutation.nextAttemptAt || mutation.nextAttemptAt <= new Date().toISOString())
            .count(),
        db.offline_mutations.where('status').equals('syncing').count(),
        db.offline_mutations
            .where('status')
            .equals('failed')
            .filter((mutation) => mutation.entityType === 'sales' && mutation.operation === 'create')
            .count(),
        db.offline_mutations
            .where('status')
            .equals('failed')
            .filter(isRecoverablePriceBookMutation)
            .count()
    ])
    return pending + leased + retryWait + syncing + failedSaleCreates + failedPriceBooks
}

export function AutoSyncOverlay() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user, isAuthenticated } = useAuth()
    const { isLocalMode } = useWorkspace()
    const syncProgress = useSyncProgress()
    const recoverablePendingCount = useLiveQuery(countRecoverableMutations, []) ?? 0
    const pendingCount = isLocalMode ? 0 : recoverablePendingCount

    const [overlayPendingCount, setOverlayPendingCount] = useState(0)
    const [isOverlayVisible, setIsOverlayVisible] = useState(false)

    const isMountedRef = useRef(true)
    const scheduledSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const autoSyncActiveRef = useRef(false)

    useEffect(() => {
        return () => {
            isMountedRef.current = false
            if (scheduledSyncRef.current) {
                clearTimeout(scheduledSyncRef.current)
            }
        }
    }, [])

    const runAutoSync = useCallback(async () => {
        if (!isSupabaseConfigured || !isAuthenticated || !user || isLocalMode || autoSyncActiveRef.current) {
            return
        }

        if (!connectionManager.getState().isOnline) {
            return
        }

        const pending = await countRecoverableMutations()
        if (pending <= 0) {
            return
        }

        autoSyncActiveRef.current = true
        const startedAt = Date.now()

        if (isMountedRef.current) {
            setOverlayPendingCount(pending)
            setIsOverlayVisible(true)
        }

        try {
            const result = await runManagedFullSync(
                user.id,
                user.workspaceId,
                localStorage.getItem(LAST_SYNC_KEY)
            )

            localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString())

            if (!result.success) {
                toast({
                    title: t('sync.toastSyncFailed'),
                    description: t('sync.toastSyncFailedDesc'),
                    variant: 'destructive'
                })
            }
        } catch (error: any) {
            toast({
                title: t('sync.toastSyncError'),
                description: error?.message || t('sync.failed'),
                variant: 'destructive'
            })
        } finally {
            const elapsed = Date.now() - startedAt
            if (elapsed < MIN_OVERLAY_MS) {
                await new Promise((resolve) => setTimeout(resolve, MIN_OVERLAY_MS - elapsed))
            }

            autoSyncActiveRef.current = false

            if (isMountedRef.current) {
                setIsOverlayVisible(false)
                setOverlayPendingCount(0)
            }
        }
    }, [isAuthenticated, isLocalMode, t, toast, user])

    useEffect(() => {
        if (!isSupabaseConfigured || !isAuthenticated || !user || isLocalMode) {
            return
        }

        const scheduleAutoSync = () => {
            if (scheduledSyncRef.current) {
                clearTimeout(scheduledSyncRef.current)
            }

            scheduledSyncRef.current = setTimeout(() => {
                scheduledSyncRef.current = null
                void runAutoSync()
            }, 1500)
        }

        const unsubscribe = connectionManager.subscribe((event) => {
            if (event === 'online') {
                scheduleAutoSync()
            } else if (event === 'wake' && connectionManager.getState().isOnline) {
                scheduleAutoSync()
            }
        })

        return () => {
            unsubscribe()
            if (scheduledSyncRef.current) {
                clearTimeout(scheduledSyncRef.current)
            }
        }
    }, [isAuthenticated, isLocalMode, runAutoSync, user])

    useEffect(() => {
        if (!isSupabaseConfigured || !isAuthenticated || !user || isLocalMode || pendingCount <= 0) {
            return
        }

        if (!connectionManager.getState().isOnline || autoSyncActiveRef.current || scheduledSyncRef.current) {
            return
        }

        scheduledSyncRef.current = setTimeout(() => {
            scheduledSyncRef.current = null
            void runAutoSync()
        }, 1500)

        return () => {
            if (scheduledSyncRef.current) {
                clearTimeout(scheduledSyncRef.current)
                scheduledSyncRef.current = null
            }
        }
    }, [isAuthenticated, isLocalMode, pendingCount, runAutoSync, user])

    const displayCount = syncProgress.isSyncing && syncProgress.phase === 'pushing' && syncProgress.total > 0
        ? syncProgress.total
        : overlayPendingCount > 0 ? overlayPendingCount : pendingCount
    const isPushingChanges = syncProgress.isSyncing && syncProgress.phase === 'pushing' && syncProgress.total > 0
    const isPullingUpdates = syncProgress.isSyncing && syncProgress.phase === 'pulling'
    const progressPercent = syncProgress.total > 0
        ? Math.min(100, Math.round((syncProgress.completed / syncProgress.total) * 100))
        : 0
    const progressLabel = isPushingChanges
        ? `${syncProgress.completed}/${syncProgress.total} changes synced`
        : isPullingUpdates
            ? `Checking data: ${syncProgress.completed}/${syncProgress.total}`
            : t('sync.syncing')

    if (!isOverlayVisible || isLocalMode) {
        return null
    }

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-background/88 backdrop-blur-md p-6">
            <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card/95 shadow-2xl">
                <div className="flex flex-col items-center gap-5 px-6 py-8 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                        <UploadCloud className="h-7 w-7" />
                    </div>

                    <div className="space-y-2">
                        <h2 className="text-2xl font-black tracking-tight text-foreground">
                            {t('sync.title')}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                            {t('sync.pendingCount', { count: displayCount })}
                        </p>
                    </div>

                    <div className="flex items-center gap-3 rounded-2xl bg-muted/60 px-4 py-3 text-sm font-medium text-foreground">
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        <span>{progressLabel}</span>
                    </div>

                    <div className="w-full space-y-2" aria-live="polite">
                        <div
                            className="h-2 w-full overflow-hidden rounded-full bg-muted"
                            role="progressbar"
                            aria-label="Sync progress"
                            aria-valuemin={0}
                            aria-valuemax={syncProgress.total || undefined}
                            aria-valuenow={syncProgress.total > 0 ? syncProgress.completed : undefined}
                        >
                            <div
                                className="h-full rounded-full bg-primary transition-all duration-300"
                                style={{ width: `${progressPercent}%` }}
                            />
                        </div>
                        {syncProgress.total > 0 && (
                            <p className="text-xs font-medium text-muted-foreground">
                                {progressPercent}% complete
                            </p>
                        )}
                    </div>

                    <p className="text-xs text-muted-foreground">
                        {t('sync.connectionNote')}
                    </p>
                </div>
            </div>
        </div>
    )
}
