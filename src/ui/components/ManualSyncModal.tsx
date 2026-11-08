import appI18n from '@/i18n/config'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/local-db/database'
import { discardOfflineStockCount, type OfflineStockOperation } from '@/local-db/offlineStockOperations'
import { useEffect, useRef, useState } from 'react'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
} from '@/ui/components/dialog'
import { Button } from '@/ui/components/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/table'
import { Loader2, CheckCircle2, AlertTriangle, ListTodo, RotateCcw, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth/AuthContext'
import { useToast } from '@/ui/components/use-toast'
import { usePendingSyncMutations } from '@/local-db/hooks'
import { discardAndRestoreOfflineMutations } from '@/local-db/offlineMutationRecovery'
import { retrySyncIntegrityMutations } from '@/local-db/offlineMutations'
import type { OfflineMutation } from '@/local-db/models'
import {
    getCapitalPoolConflictFromSyncError,
    isBusinessPartnerAccessChangedError,
    isSyncIntegrityError
} from '@/sync/syncErrors'
import { inspectRemoteMutationPayload, type RemoteMutationFieldInspection } from '@/sync/syncPayloadContract'
import { useTranslation } from 'react-i18next'
import { runManagedFullSync } from '@/sync/syncCoordinator'
import { LAST_SYNC_KEY } from '@/sync/constants'
import { connectionManager } from '@/lib/connectionManager'
import { cn } from '@/lib/utils'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { queryClient } from '@/query/queryClient'
import { useWorkspace } from '@/workspace/WorkspaceContext'

interface ManualSyncModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSyncComplete?: () => void
    contentClassName?: string
}

function getEntityLabel(entityType: OfflineMutation['entityType']) {
    if (entityType === 'stock_operations') return appI18n.t('inventory.offline.label')
    return entityType
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter: string) => letter.toUpperCase())
}

function getMutationSummary(payload: OfflineMutation['payload']) {
    if (payload.version === 1 && Array.isArray(payload.effects)) return `LOCAL-${String(payload.id).slice(0, 8)}`
    const summaryFields = [
        'name',
        'title',
        'invoiceNumber',
        'invoice_number',
        'referenceLabel',
        'reference_label',
        'code',
        'sku'
    ]

    for (const field of summaryFields) {
        const value = payload[field]
        if (typeof value === 'string' && value.trim()) {
            return value.trim()
        }
    }

    return null
}

function formatQueuedAt(createdAt: string, locale: string) {
    const date = new Date(createdAt)
    if (Number.isNaN(date.getTime())) return createdAt

    return new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        month: 'short',
        day: 'numeric'
    }).format(date)
}

function formatPayloadValue(value: unknown) {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        return `[Blob: ${value.type || 'unknown type'}, ${value.size.toLocaleString()} bytes]`
    }

    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function getFieldStatusClassName(status: RemoteMutationFieldInspection['status']) {
    if (status === 'invalid') {
        return 'bg-destructive/10 text-destructive'
    }
    if (status === 'excluded') {
        return 'bg-muted text-muted-foreground'
    }
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
}

export function ManualSyncModal({ open, onOpenChange, onSyncComplete, contentClassName }: ManualSyncModalProps) {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { refreshFeatures } = useWorkspace()
    const { toast } = useToast()
    const pendingMutations = usePendingSyncMutations()
    const pendingCount = pendingMutations.length
    const clearableMutationCount = useLiveQuery(async () => {
        if (!user?.workspaceId) return 0
        return db.offline_mutations
            .where('workspaceId')
            .equals(user.workspaceId)
            .filter(mutation => mutation.status === 'pending' || mutation.status === 'syncing' || mutation.status === 'failed')
            .count()
    }, [user?.workspaceId]) ?? 0
    const [isOnline, setIsOnline] = useState(() => connectionManager.getState().isOnline)

    const stockRetryLock = useRef(false)
    const [isSyncing, setIsSyncing] = useState(false)
    const [status, setStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle')
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [mutationToDiscard, setMutationToDiscard] = useState<OfflineMutation | null>(null)
    const [mutationToClearWithoutRestore, setMutationToClearWithoutRestore] = useState<OfflineMutation | null>(null)
    const [isDiscarding, setIsDiscarding] = useState(false)
    const [isDiscardAllConfirmOpen, setIsDiscardAllConfirmOpen] = useState(false)
    const [isClearQueueConfirmOpen, setIsClearQueueConfirmOpen] = useState(false)
    const [selectedMutation, setSelectedMutation] = useState<OfflineMutation | null>(null)

    const selectedStockOperation = selectedMutation?.entityType === 'stock_operations' ? selectedMutation.payload as unknown as OfflineStockOperation : null
    const selectedStockProducts = useLiveQuery(async () => {
        const ids = [...new Set(selectedStockOperation?.effects.filter(effect => effect.table === 'inventory').map(effect => String(effect.after?.productId)) ?? [])]
        return db.products.bulkGet(ids)
    }, [selectedMutation?.id])
    const stockProductNames = new Map(selectedStockProducts?.filter(row => !!row).map(row => [row!.id, row!.name]))
    const selectedMutationFields = selectedMutation
        ? inspectRemoteMutationPayload(selectedMutation.entityType, selectedMutation.payload, selectedMutation.error)
        : []
    const selectedCapitalPoolConflict = getCapitalPoolConflictFromSyncError(selectedMutation?.error)
    const selectedPartnerAccessChanged = isBusinessPartnerAccessChangedError(selectedMutation?.error)
    const firstPartnerAccessChangedMutation = pendingMutations.find((mutation) => (
        isBusinessPartnerAccessChangedError(mutation.error)
    ))
    const selectedMutationError = selectedCapitalPoolConflict
        ? t('paymentAccounts.capitalPools.errors.accountConflict', {
            account: selectedCapitalPoolConflict.accountName,
            pool: selectedCapitalPoolConflict.poolName,
        })
        : selectedMutation?.error

    function handleOpenChange(nextOpen: boolean) {
        if (isSyncing || isDiscarding) return
        if (!nextOpen) {
            setSelectedMutation(null)
            setMutationToDiscard(null)
        }
        onOpenChange(nextOpen)
    }

    useEffect(() => {
        return connectionManager.subscribe((event) => {
            if (event === 'online' || event === 'heartbeat') {
                setIsOnline(true)
            } else if (event === 'offline') {
                setIsOnline(false)
            }
        })
    }, [])

    async function handleSync(retryAll = true) {
        if (!user || !user.workspaceId) return

        setIsSyncing(true)
        setStatus('syncing')
        setErrorMessage(null)

        try {
            // This is deliberate user intent. Automatic sync never retries a
            // deterministic server rejection because it would repeatedly fail
            // until the underlying schema, permission, or validation issue is fixed.
            if (retryAll) await retrySyncIntegrityMutations(user.workspaceId)
            const result = await runManagedFullSync(
                user.id,
                user.workspaceId,
                localStorage.getItem(LAST_SYNC_KEY)
            )

            const remainingStock = result.success ? await db.offline_mutations.where('workspaceId').equals(user.workspaceId)
                .filter(row => row.entityType === 'stock_operations' && row.status !== 'synced' && row.status !== 'discarded').count() : 0
            if (result.success && remainingStock === 0) {
                localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString())
                setStatus('success')
                toast({
                    title: t('sync.toastSyncComplete'),
                    description: t('sync.toastSyncStats', { pushed: result.pushed, pulled: result.pulled }),
                    variant: 'default'
                })
                if (onSyncComplete) onSyncComplete()

                setTimeout(() => {
                    onOpenChange(false)
                    setStatus('idle')
                }, 1500)
            } else {
                setStatus('error')
                setErrorMessage(result.errors.join(', ') || t(pendingMutations.some(row => row.entityType === 'stock_operations' && row.payload.actorId !== user.id) ? 'inventory.offline.identityRequired' : 'inventory.offline.retryPending'))
                toast({
                    title: t('sync.toastSyncFailed'),
                    description: t('sync.toastSyncFailedDesc'),
                    variant: 'destructive'
                })
            }
        } catch (error: any) {
            setStatus('error')
            setErrorMessage(error.message || 'Unknown error occurred')
            toast({
                title: t('sync.toastSyncError'),
                description: error.message,
                variant: 'destructive'
            })
        } finally {
            setIsSyncing(false)
        }
    }

    async function handleDiscard() {
        if (!mutationToDiscard || !user?.workspaceId || isDiscarding) return

        setIsDiscarding(true)
        try {
            const result = await discardAndRestoreOfflineMutations(
                user.workspaceId,
                [mutationToDiscard],
                user.id
            )
            if (result.status !== 'discarded') throw new Error(result.reason)
            const refreshTasks: Promise<unknown>[] = [
                queryClient.invalidateQueries({ queryKey: ['atlas', 'workspace', user.workspaceId] })
            ]
            if (mutationToDiscard.entityType === 'workspaces' || mutationToDiscard.entityType === 'workspace_branches') {
                refreshTasks.push(refreshFeatures())
            }
            await Promise.all(refreshTasks)
            setSelectedMutation(null)
            setMutationToDiscard(null)
            onSyncComplete?.()
            toast({
                title: t('sync.recovery.discardQueueSuccessTitle'),
                description: t('sync.recovery.discardQueueSuccessDescription'),
                variant: 'default'
            })
        } catch (_error: unknown) {
            toast({
                title: t('sync.recovery.failureTitle'),
                description: t('sync.recovery.discardRestoreError'),
                variant: 'destructive'
            })
        } finally {
            setIsDiscarding(false)
        }
    }

    async function handleDiscardAll() {
        if (pendingCount === 0 || !user?.workspaceId || isDiscarding) return

        setIsDiscarding(true)
        const mutationsToDiscard = [...pendingMutations]

        try {
            const result = await discardAndRestoreOfflineMutations(
                user.workspaceId,
                mutationsToDiscard,
                user.id
            )
            if (result.status !== 'discarded') throw new Error(result.reason)
            const refreshTasks: Promise<unknown>[] = [
                queryClient.invalidateQueries({ queryKey: ['atlas', 'workspace', user.workspaceId] })
            ]
            if (mutationsToDiscard.some(mutation => (
                mutation.entityType === 'workspaces' || mutation.entityType === 'workspace_branches'
            ))) {
                refreshTasks.push(refreshFeatures())
            }
            await Promise.all(refreshTasks)
            setIsDiscardAllConfirmOpen(false)
            setStatus('idle')
            setErrorMessage(null)
            onSyncComplete?.()
            toast({
                title: t('sync.recovery.discardAllSuccessTitle'),
                description: t('sync.recovery.discardAllSuccessDescription', { count: result.count }),
                variant: 'default'
            })
        } catch (_error: unknown) {
            toast({
                title: t('sync.recovery.failureTitle'),
                description: t('sync.recovery.discardRestoreError'),
                variant: 'destructive'
            })
        } finally {
            setIsDiscarding(false)
        }
    }

    async function handleClearSyncWithoutRestore(mutation: OfflineMutation) {
        if (isDiscarding || !user?.workspaceId || mutation.workspaceId !== user.workspaceId) return

        setIsDiscarding(true)
        try {
            await db.offline_mutations.delete(mutation.id)
            setSelectedMutation(null)
            setMutationToDiscard(null)
            setMutationToClearWithoutRestore(null)
            setStatus('idle')
            setErrorMessage(null)
            onSyncComplete?.()
            toast({
                title: t('sync.recovery.clearSyncSuccessTitle'),
                description: t('sync.recovery.clearSyncSuccessDescription'),
                variant: 'default'
            })
        } catch (_error: unknown) {
            toast({
                title: t('sync.recovery.failureTitle'),
                description: t('sync.recovery.clearQueueError'),
                variant: 'destructive'
            })
        } finally {
            setIsDiscarding(false)
        }
    }

    async function handleClearQueueWithoutRestore() {
        if (!user?.workspaceId || isDiscarding) return

        setIsDiscarding(true)
        try {
            const queuedRows = await db.offline_mutations
                .where('workspaceId')
                .equals(user.workspaceId)
                .filter(mutation => mutation.status === 'pending' || mutation.status === 'syncing' || mutation.status === 'failed')
                .toArray()
            const queuedIds = queuedRows.map(mutation => mutation.id)
            if (queuedIds.length === 0) {
                setIsClearQueueConfirmOpen(false)
                return
            }

            await db.transaction('rw', db.offline_mutations, async () => {
                await db.offline_mutations.bulkDelete(queuedIds)
            })
            setSelectedMutation(null)
            setMutationToDiscard(null)
            setIsDiscardAllConfirmOpen(false)
            setIsClearQueueConfirmOpen(false)
            setStatus('idle')
            setErrorMessage(null)
            onSyncComplete?.()
            toast({
                title: t('sync.recovery.clearQueueSuccessTitle'),
                description: t('sync.recovery.clearQueueSuccessDescription', { count: queuedIds.length }),
                variant: 'default'
            })
        } catch (_error: unknown) {
            toast({
                title: t('sync.recovery.failureTitle'),
                description: t('sync.recovery.clearQueueError'),
                variant: 'destructive'
            })
        } finally {
            setIsDiscarding(false)
        }
    }

    return (
        <>
            <Dialog open={open} onOpenChange={isSyncing || isDiscarding ? undefined : handleOpenChange}>
                <DialogContent
                    className={cn('sm:max-w-lg', contentClassName)}
                    showCloseButton={!isSyncing && !isDiscarding}
                    onEscapeKeyDown={(event) => {
                        if (isSyncing || isDiscarding) event.preventDefault()
                    }}
                    onPointerDownOutside={(event) => {
                        if (isSyncing || isDiscarding) event.preventDefault()
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{t('sync.title')}</DialogTitle>
                        <DialogDescription>
                            {status === 'idle' && t('sync.pendingCount', { count: pendingCount })}
                            {status === 'syncing' && t('sync.syncing')}
                            {status === 'success' && t('sync.success')}
                            {status === 'error' && t('sync.failed')}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col items-center justify-center py-4 space-y-4">
                        {status === 'idle' && (
                            <div className="w-full space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                                        <ListTodo className="h-4 w-4 text-primary" />
                                        <span>{t('sync.queueTitle')}</span>
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                        {t('sync.queueItems', { count: pendingMutations.length })}
                                    </span>
                                </div>

                                <div
                                    aria-label={t('sync.queueTitle')}
                                    className="max-h-52 divide-y overflow-y-auto rounded-md border bg-muted/20 text-left"
                                >
                                    {pendingMutations.map((mutation) => {
                                        const summary = getMutationSummary(mutation.payload)
                                        const hasSyncIntegrityIssue = isSyncIntegrityError(mutation.error) || (mutation.entityType === 'stock_operations' && mutation.status === 'failed')
                                        const statusLabel = hasSyncIntegrityIssue
                                            ? mutation.entityType === 'stock_operations' ? t('inventory.offline.needsAttention') : t('sync.needsAttention', { defaultValue: 'Needs attention' })
                                            : mutation.status === 'failed'
                                                ? t('sync.retrying')
                                            : mutation.status === 'syncing'
                                                ? t('sync.syncing')
                                                : t('sync.queued')

                                        return (
                                            <button
                                                key={mutation.id}
                                                type="button"
                                                onClick={() => setSelectedMutation(mutation)}
                                                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                title={t('sync.reviewPayload')}
                                            >
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-medium text-foreground">
                                                        {getEntityLabel(mutation.entityType)}
                                                        {summary && <span className="font-normal text-muted-foreground"> · {summary}</span>}
                                                    </p>
                                                    <p className="mt-0.5 text-xs text-muted-foreground">
                                                        {t(`sync.operations.${mutation.operation}`)} · {formatQueuedAt(mutation.createdAt, i18n.language)}
                                                    </p>
                                                </div>
                                                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${hasSyncIntegrityIssue ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
                                                    {statusLabel}
                                                </span>
                                            </button>
                                        )
                                    })}
                                </div>

                                <p className="text-center text-sm text-muted-foreground">
                                    {t('sync.connectionNote')}
                                </p>
                            </div>
                        )}

                        {status === 'syncing' && (
                            <div className="flex flex-col items-center gap-2">
                                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                                <p className="text-sm text-muted-foreground">{t('sync.processing')}</p>
                            </div>
                        )}

                        {status === 'success' && (
                            <div className="flex flex-col items-center gap-2">
                                <CheckCircle2 className="h-8 w-8 text-green-500" />
                                <p className="text-sm font-medium text-green-600">{t('sync.allSynced')}</p>
                            </div>
                        )}

                        {status === 'error' && (
                            <div className="flex flex-col items-center gap-2">
                                <AlertTriangle className="h-8 w-8 text-destructive" />
                                <p className="text-sm font-medium text-destructive">{t('sync.failed')}</p>
                                {errorMessage && (
                                    <p className="text-xs text-muted-foreground text-center max-w-[80%]">
                                        {errorMessage}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>

                    <DialogFooter className="sm:justify-between flex-col sm:flex-row gap-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                            <Button
                                variant="ghost"
                                onClick={() => handleOpenChange(false)}
                                disabled={isSyncing || isDiscarding}
                            >
                                {status === 'success' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
                            </Button>
                            {status !== 'success' && (
                                <>
                                    <Button
                                        type="button"
                                        variant="destructive"
                                        onClick={() => setIsDiscardAllConfirmOpen(true)}
                                        disabled={pendingCount === 0 || isSyncing || isDiscarding}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                        {t('sync.recovery.discardAllAction')}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="border-destructive/50 text-destructive hover:bg-destructive/10"
                                        onClick={() => setIsClearQueueConfirmOpen(true)}
                                        disabled={clearableMutationCount === 0 || isDiscarding}
                                        title={t('sync.recovery.clearQueueWithoutRestoreDescription')}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                        {t('sync.recovery.clearQueueWithoutRestoreAction')}
                                    </Button>
                                </>
                            )}
                        </div>
                        {status !== 'success' && (firstPartnerAccessChangedMutation ? (
                            <Button
                                variant="outline"
                                onClick={() => setSelectedMutation(firstPartnerAccessChangedMutation)}
                                disabled={isSyncing || isDiscarding}
                            >
                                <ListTodo className="h-4 w-4" />
                                {t('sync.accessChanged.reviewAction')}
                            </Button>
                        ) : (
                            <Button
                                onClick={() => void handleSync()}
                                disabled={isSyncing || isDiscarding || !isOnline}
                            >
                                {isSyncing ? t('sync.syncingBtn') : t('sync.syncNow')}
                            </Button>
                        ))}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={mutationToDiscard !== null}
                onClose={() => {
                    if (!isDiscarding) setMutationToDiscard(null)
                }}
                onConfirm={() => void handleDiscard()}
                isLoading={isDiscarding}
                confirmLabel={t('sync.recovery.discardAction')}
                title={t('sync.recovery.discardQueueConfirmTitle')}
                description={t('sync.recovery.discardQueueConfirmDescription', {
                    entity: mutationToDiscard ? getEntityLabel(mutationToDiscard.entityType) : ''
                })}
                itemName={mutationToDiscard ? getEntityLabel(mutationToDiscard.entityType) : ''}
                contentClassName={cn(contentClassName, 'z-[10030]')}
                overlayClassName="z-[10025]"
            />

            <DeleteConfirmationModal
                isOpen={mutationToClearWithoutRestore !== null}
                onClose={() => {
                    if (!isDiscarding) setMutationToClearWithoutRestore(null)
                }}
                onConfirm={() => mutationToClearWithoutRestore && void handleClearSyncWithoutRestore(mutationToClearWithoutRestore)}
                isLoading={isDiscarding}
                confirmLabel={t('sync.recovery.clearSyncWithoutRestoreAction')}
                title={t('sync.recovery.clearSyncConfirmTitle')}
                description={t('sync.recovery.clearSyncConfirmDescription', {
                    entity: mutationToClearWithoutRestore ? getEntityLabel(mutationToClearWithoutRestore.entityType) : ''
                })}
                itemName={mutationToClearWithoutRestore ? getEntityLabel(mutationToClearWithoutRestore.entityType) : ''}
                contentClassName={cn(contentClassName, 'z-[10030]')}
                overlayClassName="z-[10025]"
            />

            <DeleteConfirmationModal
                isOpen={isClearQueueConfirmOpen}
                onClose={() => {
                    if (!isDiscarding) setIsClearQueueConfirmOpen(false)
                }}
                onConfirm={() => void handleClearQueueWithoutRestore()}
                isLoading={isDiscarding}
                confirmLabel={t('sync.recovery.clearQueueWithoutRestoreAction')}
                title={t('sync.recovery.clearQueueConfirmTitle')}
                description={t('sync.recovery.clearQueueConfirmDescription', { count: clearableMutationCount })}
                itemName={t('sync.queueItems', { count: clearableMutationCount })}
                contentClassName={cn(contentClassName, 'z-[10030]')}
                overlayClassName="z-[10025]"
            />

            <DeleteConfirmationModal
                isOpen={isDiscardAllConfirmOpen}
                onClose={() => {
                    if (!isDiscarding) setIsDiscardAllConfirmOpen(false)
                }}
                onConfirm={() => void handleDiscardAll()}
                isLoading={isDiscarding}
                confirmLabel={t('sync.recovery.discardAllConfirmAction')}
                title={t('sync.recovery.discardAllConfirmTitle')}
                description={t('sync.recovery.discardAllConfirmDescription', { count: pendingCount })}
                itemName={t('sync.queueItems', { count: pendingCount })}
                contentClassName={cn(contentClassName, 'z-[10030]')}
                overlayClassName="z-[10025]"
            />

            <AppDialog
                open={selectedMutation !== null}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && !isDiscarding && !isSyncing) setSelectedMutation(null)
                }}
            >
                <AppDialogContent
                    className={cn('max-w-4xl', contentClassName, 'z-[10020]')}
                    overlayClassName="z-[10015]"
                    showCloseButton={!isDiscarding && !isSyncing}
                    onEscapeKeyDown={(event) => {
                        if (isDiscarding || isSyncing) event.preventDefault()
                    }}
                    onPointerDownOutside={(event) => {
                        if (isDiscarding || isSyncing) event.preventDefault()
                    }}
                >
                    <AppDialogHeader>
                        <AppDialogTitle>{selectedStockOperation ? t('inventory.offline.review') : t('sync.payloadTitle', { entity: getEntityLabel(selectedMutation?.entityType ?? 'products') })}</AppDialogTitle>
                        <DialogDescription>
                            {selectedStockOperation ? t('inventory.offline.reviewHelp') : t('sync.payloadDescription')}
                        </DialogDescription>
                    </AppDialogHeader>

                    <AppDialogBody>
                        {selectedStockOperation && selectedStockOperation.actorId !== user?.id && <p className="mb-3 text-sm text-muted-foreground">{t('inventory.offline.identityRequired')}</p>}
                        {selectedMutation?.error && (
                            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                                {selectedMutationError}
                            </div>
                        )}

                        {selectedPartnerAccessChanged && (
                            <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                {t('sync.accessChanged.detail')}
                            </p>
                        )}

                        {selectedStockOperation ? (
                            <div className="space-y-4 py-3">
                                <p className="break-all text-sm text-muted-foreground">{t('inventory.offline.pendingReference')}: LOCAL-{selectedStockOperation.id}</p>
                                <p className="font-medium">{t(`inventory.offline.kinds.${selectedStockOperation.kind}`)}</p>
                                {selectedStockOperation.effects.filter(effect => effect.table === 'inventory').map(effect => (
                                    <div key={effect.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                                        <span>{stockProductNames.get(String(effect.after?.productId)) ?? t('inventory.offline.label')}</span>
                                        <span className="tabular-nums">{t('inventory.offline.quantityChange', { quantity: new Intl.NumberFormat(i18n.language, { signDisplay: 'always', maximumFractionDigits: 6 }).format(Number(effect.after?.quantity ?? 0)-Number(effect.before?.quantity ?? 0)) })}</span>
                                    </div>
                                ))}
                                {selectedStockOperation.count && <p className="text-sm text-muted-foreground">{t('inventory.offline.countHelp')}</p>}
                                {selectedStockOperation.effects.some(effect => effect.table === 'payment_transactions') && <p className="text-sm text-muted-foreground">{t('inventory.offline.paymentPreserved')}</p>}
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('sync.payloadFields.field')}</TableHead>
                                        <TableHead>{t('sync.payloadFields.status')}</TableHead>
                                        <TableHead>{t('sync.payloadFields.reason')}</TableHead>
                                        <TableHead>{t('sync.payloadFields.value')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {selectedMutationFields.map((field) => {
                                        const statusClassName = getFieldStatusClassName(field.status)
                                        return (
                                        <TableRow key={field.field}>
                                            <TableCell className="font-mono text-xs font-medium">{field.field}</TableCell>
                                            <TableCell>
                                                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusClassName}`}>
                                                    {t(`sync.payloadStatus.${field.status}`)}
                                                </span>
                                            </TableCell>
                                            <TableCell className="min-w-48 text-xs text-muted-foreground">{field.reason}</TableCell>
                                            <TableCell className="min-w-56 max-w-80 whitespace-pre-wrap break-all font-mono text-xs">
                                                {formatPayloadValue(field.value)}
                                            </TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                            </Table>
                        )}
                    </AppDialogBody>

                    <AppDialogFooter>
                        <Button variant="ghost" onClick={() => setSelectedMutation(null)} disabled={isDiscarding || isSyncing}>
                            {t('common.close', 'Close')}
                        </Button>
                        {selectedMutation && (
                            <>
                                <Button
                                    variant="destructive"
                                    onClick={() => setMutationToDiscard(selectedMutation)}
                                    disabled={isDiscarding || isSyncing}
                                >
                                    {isDiscarding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                    {t('sync.recovery.discardAction')}
                                </Button>
                                <Button
                                    variant="outline"
                                    className="border-destructive/50 text-destructive hover:bg-destructive/10"
                                    onClick={() => setMutationToClearWithoutRestore(selectedMutation)}
                                    disabled={isDiscarding}
                                    title={t('sync.recovery.clearSyncWithoutRestoreDescription')}
                                >
                                    {isDiscarding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                    {t('sync.recovery.clearSyncWithoutRestoreAction')}
                                </Button>
                            </>
                        )}
                        {selectedStockOperation ? (
                            <Button disabled={isSyncing || isDiscarding || !isOnline || selectedStockOperation.actorId !== user?.id || selectedMutation?.status === 'syncing'} onClick={async () => {
                                if (!selectedMutation || stockRetryLock.current || isDiscarding) return
                                stockRetryLock.current = true
                                setIsSyncing(true)
                                try {
                                    const current = await db.offline_mutations.get(selectedMutation.id)
                                    if (current?.stockCancelRequested) { await discardOfflineStockCount(current.id); setSelectedMutation(null); return }
                                    await db.offline_mutations.update(selectedMutation.id, { status: 'pending', error: undefined, nextAttemptAt: undefined })
                                    await handleSync(false)
                                } catch {
                                    toast({ title: t('common.error'), description: t('inventory.offline.retryPending'), variant: 'destructive' })
                                } finally { stockRetryLock.current = false; setIsSyncing(false) }
                            }}>
                                {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                                {t('inventory.offline.retry')}
                            </Button>
                        ) : null}
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>
        </>
    )
}
