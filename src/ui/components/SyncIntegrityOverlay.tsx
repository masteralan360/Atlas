import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, ListTodo, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { db } from '@/local-db/database'
import { isRentalVehicleYearConstraintError } from '@/local-db/carRental'
import { retrySyncIntegrityMutations } from '@/local-db/offlineMutations'
import type { OfflineMutation } from '@/local-db/models'
import { LAST_SYNC_KEY } from '@/sync/constants'
import { runManagedFullSync } from '@/sync/syncCoordinator'
import { getCapitalPoolConflictFromSyncError, isSyncIntegrityError } from '@/sync/syncErrors'
import { useWorkspace } from '@/workspace'
import { Button } from '@/ui/components/button'

import { ManualSyncModal } from './ManualSyncModal'
import { RentalVehicleYearRecoveryDialog } from './car-rental/RentalVehicleYearRecoveryDialog'

function getEntityLabel(entityType: OfflineMutation['entityType']) {
    return entityType
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter: string) => letter.toUpperCase())
}

/**
 * Stops new work only when Supabase has deterministically rejected a queued
 * mutation. Connection failures remain non-blocking and continue to use the
 * normal offline queue.
 */
export function SyncIntegrityOverlay() {
    const { t } = useTranslation()
    const { user, isAuthenticated } = useAuth()
    const { isLocalMode } = useWorkspace()
    const isOnline = useNetworkStatus()
    const workspaceId = user?.workspaceId
    const [isQueueOpen, setIsQueueOpen] = useState(false)
    const [isYearRecoveryOpen, setIsYearRecoveryOpen] = useState(false)
    const [isRetrying, setIsRetrying] = useState(false)
    const [retryError, setRetryError] = useState<string | null>(null)

    const integrityIssues = useLiveQuery(async () => {
        if (!workspaceId) return []

        const groups = await Promise.all((['failed', 'blocked', 'conflict', 'rejected'] as const).map((status) =>
            db.offline_mutations
                .where('status')
                .equals(status)
                .filter((mutation) => (
                    mutation.workspaceId === workspaceId && (
                        status === 'blocked'
                        || status === 'conflict'
                        || status === 'rejected'
                        || isSyncIntegrityError(mutation.error)
                    )
                ))
                .toArray()
        ))
        return groups.flat().sort((left, right) =>
            (left.localSequence ?? Number.MAX_SAFE_INTEGER) - (right.localSequence ?? Number.MAX_SAFE_INTEGER)
            || left.createdAt.localeCompare(right.createdAt)
        )
    }, [workspaceId]) ?? []

    const firstIssue = integrityIssues[0]
    const capitalPoolConflict = getCapitalPoolConflictFromSyncError(firstIssue?.error)
    const firstIssueMessage = capitalPoolConflict
        ? t('paymentAccounts.capitalPools.errors.accountConflict', {
            account: capitalPoolConflict.accountName,
            pool: capitalPoolConflict.poolName,
        })
        : firstIssue?.error
    const shouldBlock = isAuthenticated && !isLocalMode && Boolean(user && firstIssue)
    const canRepairVehicleYear = firstIssue?.entityType === 'rental_vehicles'
        && isRentalVehicleYearConstraintError(firstIssue.error)

    async function handleRetry() {
        if (!user || !workspaceId || !isOnline || isRetrying) return

        setIsRetrying(true)
        setRetryError(null)

        try {
            await retrySyncIntegrityMutations(workspaceId)
            const result = await runManagedFullSync(
                user.id,
                workspaceId,
                localStorage.getItem(LAST_SYNC_KEY)
            )

            if (result.success) {
                localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString())
            } else {
                setRetryError(result.errors[0] ?? 'Supabase still rejected the queued change.')
            }
        } catch (error: unknown) {
            setRetryError(error instanceof Error ? error.message : 'The retry could not be completed.')
        } finally {
            setIsRetrying(false)
        }
    }

    if (!shouldBlock || !firstIssue) {
        return null
    }

    return (
        <>
            {!isYearRecoveryOpen && (
                <div
                    className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/92 p-6 backdrop-blur-md"
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="sync-integrity-title"
                    aria-describedby="sync-integrity-description"
                >
                    <div className="w-full max-w-xl rounded-3xl border border-destructive/30 bg-card p-7 shadow-2xl">
                        <div className="flex items-start gap-4">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                                <AlertTriangle className="h-6 w-6" />
                            </div>
                            <div className="min-w-0 space-y-2">
                                <h2 id="sync-integrity-title" className="text-xl font-bold tracking-tight text-foreground">
                                    Sync issue needs to be resolved
                                </h2>
                                <p id="sync-integrity-description" className="text-sm leading-6 text-muted-foreground">
                                    Supabase rejected a queued change. To protect order, inventory, and product data, actions are paused until the issue is resolved. Nothing has been discarded.
                                </p>
                            </div>
                        </div>

                        <div className="mt-6 rounded-2xl border border-destructive/20 bg-destructive/5 p-4">
                            <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-semibold text-foreground">
                                    {getEntityLabel(firstIssue.entityType)} requires attention
                                </p>
                                {integrityIssues.length > 1 && (
                                    <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
                                        {integrityIssues.length} issues
                                    </span>
                                )}
                            </div>
                            <p className="mt-2 break-words text-xs leading-5 text-destructive">
                                {firstIssueMessage}
                            </p>
                        </div>

                        {retryError && (
                            <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground" role="status">
                                {retryError}
                            </p>
                        )}

                        {!isOnline && (
                            <p className="mt-4 text-sm text-muted-foreground">
                                Reconnect to the internet before retrying this sync issue.
                            </p>
                        )}

                        <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setIsQueueOpen(true)}
                                disabled={isRetrying}
                                autoFocus
                            >
                                <ListTodo className="h-4 w-4" />
                                Review sync queue
                            </Button>
                            {canRepairVehicleYear && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setIsYearRecoveryOpen(true)}
                                    disabled={isRetrying}
                                >
                                    {t('carRental.syncRecovery.fixVehicleYear')}
                                </Button>
                            )}
                            <Button
                                type="button"
                                onClick={handleRetry}
                                disabled={!isOnline || isRetrying}
                            >
                                {isRetrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                {isRetrying ? 'Retrying sync...' : 'Retry sync'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            <RentalVehicleYearRecoveryDialog
                open={isYearRecoveryOpen}
                onOpenChange={setIsYearRecoveryOpen}
                onRepaired={() => {
                    setIsYearRecoveryOpen(false)
                    void handleRetry()
                }}
                workspaceId={workspaceId}
                vehicleId={canRepairVehicleYear ? firstIssue.entityId : undefined}
                mutationId={canRepairVehicleYear ? firstIssue.id : undefined}
            />

            <ManualSyncModal
                open={isQueueOpen}
                onOpenChange={setIsQueueOpen}
                contentClassName="z-[10020]"
            />
        </>
    )
}
