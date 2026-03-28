import { useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
} from '@/ui/components/dialog'
import { Button } from '@/ui/components/button'
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useAuth } from '@/auth/AuthContext'
import { useToast } from '@/ui/components/use-toast'
import { usePendingSyncCount, clearOfflineMutations } from '@/local-db/hooks'
import { useTranslation } from 'react-i18next'
import { runManagedFullSync } from '@/sync/syncCoordinator'

interface ManualSyncModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSyncComplete?: () => void
}

export function ManualSyncModal({ open, onOpenChange, onSyncComplete }: ManualSyncModalProps) {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { toast } = useToast()
    const pendingCount = usePendingSyncCount()

    const [isSyncing, setIsSyncing] = useState(false)
    const [status, setStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle')
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

    async function handleSync() {
        if (!user || !user.workspaceId) return

        setIsSyncing(true)
        setStatus('syncing')
        setErrorMessage(null)

        try {
            const result = await runManagedFullSync(user.id, user.workspaceId, null)

            if (result.success) {
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

    async function handleDiscard() {
        try {
            await clearOfflineMutations()
            toast({
                title: t('sync.toastDiscardTitle'),
                description: t('sync.toastDiscardDesc'),
                variant: 'default'
            })
            setShowDiscardConfirm(false)
            onOpenChange(false)
        } catch (error: any) {
            toast({
                title: t('common.error', 'Error'),
                description: t('sync.discardError'),
                variant: 'destructive'
            })
        }
    }

    return (
        <>
            <Dialog open={open} onOpenChange={isSyncing ? undefined : onOpenChange}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('sync.title')}</DialogTitle>
                        <DialogDescription>
                            {status === 'idle' && t('sync.pendingCount', { count: pendingCount })}
                            {status === 'syncing' && t('sync.syncing')}
                            {status === 'success' && t('sync.success')}
                            {status === 'error' && t('sync.failed')}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col items-center justify-center py-6 space-y-4">
                        {status === 'idle' && (
                            <div className="text-center space-y-2">
                                <p className="text-sm text-muted-foreground">
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
                                onClick={() => onOpenChange(false)}
                                disabled={isSyncing}
                            >
                                {status === 'success' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
                            </Button>
                            {status === 'idle' && pendingCount > 0 && (
                                <Button
                                    variant="destructive"
                                    onClick={() => setShowDiscardConfirm(true)}
                                    disabled={isSyncing}
                                >
                                    {t('sync.discardBtn')}
                                </Button>
                            )}
                        </div>
                        {status !== 'success' && (
                            <Button
                                onClick={handleSync}
                                disabled={isSyncing || !navigator.onLine}
                            >
                                {isSyncing ? t('sync.syncingBtn') : t('sync.syncNow')}
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showDiscardConfirm} onOpenChange={setShowDiscardConfirm}>
                <DialogContent className="sm:max-w-[400px]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle className="h-5 w-5" />
                            {t('sync.confirmDiscard')}
                        </DialogTitle>
                        <DialogDescription>
                            {t('sync.discardDescription', { count: pendingCount })}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="sm:justify-end gap-2">
                        <Button variant="ghost" onClick={() => setShowDiscardConfirm(false)}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button variant="destructive" onClick={handleDiscard}>
                            {t('sync.yesDiscard')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}
