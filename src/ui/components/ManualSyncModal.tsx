import { useEffect, useMemo, useState } from 'react'
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
import { Loader2, CheckCircle2, AlertTriangle, ListTodo, RotateCcw } from 'lucide-react'
import { useAuth } from '@/auth/AuthContext'
import { useToast } from '@/ui/components/use-toast'
import { usePendingSyncMutations } from '@/local-db/hooks'
import { retrySyncIntegrityMutations } from '@/local-db/offlineMutations'
import { canRecoverOfflineMutation, discardAndRestoreOfflineMutation, type OfflineMutationRecoveryFailure } from '@/local-db/offlineMutationRecovery'
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
import { useWorkspace } from '@/workspace'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'

interface ManualSyncModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSyncComplete?: () => void
    contentClassName?: string
}

function getEntityLabel(entityType: OfflineMutation['entityType']) {
    return entityType
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter: string) => letter.toUpperCase())
}

function getMutationSummary(payload: OfflineMutation['payload']) {
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
    const { isLocalMode } = useWorkspace()
    const { toast } = useToast()
    const pendingMutations = usePendingSyncMutations()
    const pendingCount = pendingMutations.length
    const [isOnline, setIsOnline] = useState(() => connectionManager.getState().isOnline)

    const [isSyncing, setIsSyncing] = useState(false)
    const [status, setStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle')
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [mutationToDiscard, setMutationToDiscard] = useState<OfflineMutation | null>(null)
    const [isDiscarding, setIsDiscarding] = useState(false)
    const [selectedMutation, setSelectedMutation] = useState<OfflineMutation | null>(null)

    const selectedMutationCanRecover = useMemo(() => (
        !isLocalMode
        && isOnline
        && canRecoverOfflineMutation(selectedMutation)
    ), [isLocalMode, isOnline, selectedMutation])

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

    async function handleSync() {
        if (!user || !user.workspaceId) return

        setIsSyncing(true)
        setStatus('syncing')
        setErrorMessage(null)

        try {
            // This is deliberate user intent. Automatic sync never retries a
            // deterministic server rejection because it would repeatedly fail
            // until the underlying schema, permission, or validation issue is fixed.
            await retrySyncIntegrityMutations(user.workspaceId)
            const result = await runManagedFullSync(
                user.id,
                user.workspaceId,
                localStorage.getItem(LAST_SYNC_KEY)
            )

            if (result.success) {
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
                setErrorMessage(result.errors.join(', '))
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

    function getRecoveryFailureMessage(reason: OfflineMutationRecoveryFailure) {
        return t(`sync.recovery.errors.${reason}`)
    }

    async function handleDiscard() {
        if (!user || !mutationToDiscard || isDiscarding) return

        setIsDiscarding(true)
        try {
            const result = await discardAndRestoreOfflineMutation(
                user.workspaceId,
                mutationToDiscard.id,
                user.id
            )

            if (result.status === 'discarded') {
                toast({
                    title: t('sync.recovery.successTitle'),
                    description: t(`sync.recovery.successDescription.${result.action}`),
                    variant: 'default'
                })
                setSelectedMutation(null)
                setMutationToDiscard(null)
                return
            }

            toast({
                title: t('sync.recovery.failureTitle'),
                description: getRecoveryFailureMessage(result.reason),
                variant: 'destructive'
            })
        } catch (_error: unknown) {
            toast({
                title: t('sync.recovery.failureTitle'),
                description: t('sync.recovery.errors.remote_request_failed'),
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
                                        const hasSyncIntegrityIssue = isSyncIntegrityError(mutation.error)
                                        const statusLabel = hasSyncIntegrityIssue
                                            ? t('sync.needsAttention', { defaultValue: 'Needs attention' })
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

                    <DialogFooter className="sm:justify-between flex-row gap-2">
                        <div className="flex gap-2">
                            <Button
                                variant="ghost"
                                onClick={() => handleOpenChange(false)}
                                disabled={isSyncing || isDiscarding}
                            >
                                {status === 'success' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
                            </Button>
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
                                onClick={handleSync}
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
                confirmLabel={isBusinessPartnerAccessChangedError(mutationToDiscard?.error)
                    ? t('sync.recovery.accessRevokedAction')
                    : t('sync.recovery.action')}
                title={isBusinessPartnerAccessChangedError(mutationToDiscard?.error)
                    ? t('sync.recovery.accessRevokedConfirmTitle')
                    : t('sync.recovery.confirmTitle')}
                description={isBusinessPartnerAccessChangedError(mutationToDiscard?.error)
                    ? t('sync.recovery.accessRevokedConfirmDescription')
                    : t('sync.recovery.confirmDescription', {
                        entity: mutationToDiscard ? getEntityLabel(mutationToDiscard.entityType) : ''
                    })}
                itemName={mutationToDiscard ? getEntityLabel(mutationToDiscard.entityType) : ''}
                contentClassName={cn(contentClassName, 'z-[10030]')}
                overlayClassName="z-[10025]"
            />

            <AppDialog
                open={selectedMutation !== null}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && !isDiscarding) setSelectedMutation(null)
                }}
            >
                <AppDialogContent
                    className={cn('max-w-4xl', contentClassName)}
                    showCloseButton={!isDiscarding}
                    onEscapeKeyDown={(event) => {
                        if (isDiscarding) event.preventDefault()
                    }}
                    onPointerDownOutside={(event) => {
                        if (isDiscarding) event.preventDefault()
                    }}
                >
                    <AppDialogHeader>
                        <AppDialogTitle>{t('sync.payloadTitle', { entity: getEntityLabel(selectedMutation?.entityType ?? 'products') })}</AppDialogTitle>
                        <DialogDescription>
                            {t('sync.payloadDescription')}
                        </DialogDescription>
                    </AppDialogHeader>

                    <AppDialogBody>
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
                    </AppDialogBody>

                    <AppDialogFooter>
                        <Button variant="ghost" onClick={() => setSelectedMutation(null)} disabled={isDiscarding}>
                            {t('common.close', 'Close')}
                        </Button>
                        {selectedMutationCanRecover ? (
                            <Button
                                variant="destructive"
                                onClick={() => {
                                    if (selectedMutation) setMutationToDiscard(selectedMutation)
                                }}
                                disabled={isDiscarding}
                            >
                                {isDiscarding ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                                {selectedPartnerAccessChanged
                                    ? t('sync.accessChanged.discardAction')
                                    : t('sync.recovery.action')}
                            </Button>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                {isLocalMode
                                    ? t('sync.recovery.unavailableLocal')
                                    : !isOnline
                                        ? t('sync.recovery.unavailableOffline')
                                        : t('sync.recovery.unavailable')}
                            </p>
                        )}
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>
        </>
    )
}
