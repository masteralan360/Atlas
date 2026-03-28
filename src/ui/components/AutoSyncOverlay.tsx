import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, UploadCloud } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { isSupabaseConfigured } from '@/auth/supabase'
import { usePendingSyncCount } from '@/local-db/hooks'
import { db } from '@/local-db/database'
import { connectionManager } from '@/lib/connectionManager'
import { useWorkspace } from '@/workspace'
import { useToast } from '@/ui/components/use-toast'
import { LAST_SYNC_KEY } from '@/sync/constants'
import { runManagedFullSync } from '@/sync/syncCoordinator'

const MIN_OVERLAY_MS = 800

export function AutoSyncOverlay() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user, isAuthenticated } = useAuth()
    const { isLocalMode } = useWorkspace()
    const pendingCount = usePendingSyncCount()

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

        const pending = await db.offline_mutations.where('status').equals('pending').count()
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

    const displayCount = overlayPendingCount > 0 ? overlayPendingCount : pendingCount

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
                        <span>{t('sync.syncing')}</span>
                    </div>

                    <p className="text-xs text-muted-foreground">
                        {t('sync.connectionNote')}
                    </p>
                </div>
            </div>
        </div>
    )
}
