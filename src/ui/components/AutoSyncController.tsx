import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'

import { useAuth } from '@/auth'
import { isSupabaseConfigured } from '@/auth/supabase'
import { db } from '@/local-db/database'
import { connectionManager } from '@/lib/connectionManager'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useToast } from '@/ui/components/use-toast'
import { LAST_SYNC_KEY } from '@/sync/constants'
import { isRecoverablePriceBookMutation } from '@/sync/syncEngine'
import { runManagedFullSync } from '@/sync/syncCoordinator'

async function countRecoverableMutations() {
    const [pending, syncing, failedSaleCreates, failedPriceBooks] = await Promise.all([
        db.offline_mutations.where('status').equals('pending').count(),
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
    return pending + syncing + failedSaleCreates + failedPriceBooks
}

export function AutoSyncController() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user, isAuthenticated } = useAuth()
    const { isLocalMode } = useWorkspace()
    const recoverablePendingCount = useLiveQuery(countRecoverableMutations, []) ?? 0
    const pendingCount = isLocalMode ? 0 : recoverablePendingCount

    const scheduledSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const autoSyncActiveRef = useRef(false)

    useEffect(() => {
        return () => {
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
            autoSyncActiveRef.current = false
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

    return null
}
