import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    AlertTriangle,
    CheckCircle2,
    CloudDownload,
    Database,
    HardDrive,
    RefreshCw,
    ShieldCheck,
    WifiOff
} from 'lucide-react'
import { useAuth } from '@/auth'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isTauri } from '@/lib/platform'
import {
    getOfflineReadinessSnapshot,
    OfflinePreparationError,
    prepareForOfflineUse,
    type OfflinePreparationErrorCode,
    type OfflinePreparationPhase,
    type OfflinePreparationResult,
    type OfflineReadinessSnapshot
} from '@/lib/offlinePreparation'
import { useSyncProgress } from '@/sync/syncProgress'
import { useWorkspace } from '@/workspace'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Progress,
    useToast
} from '@/ui/components'
import { cn } from '@/lib/utils'

const RELOAD_NOTICE_KEY = 'atlas_offline_preparation_completed'

function formatBytes(bytes: number | null) {
    if (bytes === null || !Number.isFinite(bytes)) return null
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function OfflineReadinessCard() {
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const isOnline = useNetworkStatus()
    const syncProgress = useSyncProgress()
    const dataMode = features.data_mode ?? user?.workspaceMode ?? 'hybrid'
    const [snapshot, setSnapshot] = useState<OfflineReadinessSnapshot | null>(null)
    const [isChecking, setIsChecking] = useState(true)
    const [dialogOpen, setDialogOpen] = useState(false)
    const [isPreparing, setIsPreparing] = useState(false)
    const [phase, setPhase] = useState<OfflinePreparationPhase>('storage')
    const [shellProgress, setShellProgress] = useState({ completed: 0, total: 0 })
    const [result, setResult] = useState<OfflinePreparationResult | null>(null)
    const [errorCode, setErrorCode] = useState<OfflinePreparationErrorCode | null>(null)

    const refreshSnapshot = useCallback(async () => {
        if (!user) return
        setIsChecking(true)
        try {
            setSnapshot(await getOfflineReadinessSnapshot(user, dataMode))
        } catch (error) {
            console.warn('[OfflineReadiness] Could not inspect readiness:', error)
            setSnapshot(null)
        } finally {
            setIsChecking(false)
        }
    }, [dataMode, user])

    useEffect(() => {
        void refreshSnapshot()
    }, [refreshSnapshot])

    useEffect(() => {
        try {
            if (sessionStorage.getItem(RELOAD_NOTICE_KEY) !== '1') return
            sessionStorage.removeItem(RELOAD_NOTICE_KEY)
            toast({
                title: t('settings.offlineReadiness.successTitle'),
                description: t('settings.offlineReadiness.successDescription')
            })
        } catch {
            // Session storage is advisory only.
        }
    }, [t, toast])

    const phases = useMemo(() => {
        const rows: Array<{ phase: OfflinePreparationPhase; icon: typeof ShieldCheck }> = [
            { phase: 'storage', icon: HardDrive }
        ]
        if (dataMode === 'hybrid') {
            rows.push({ phase: 'data', icon: CloudDownload })
        }
        rows.push({ phase: 'database', icon: Database }, { phase: 'shell', icon: CloudDownload })
        return rows
    }, [dataMode])

    const activePhaseIndex = Math.max(0, phases.findIndex((row) => row.phase === phase))
    const progressValue = (() => {
        if (result || phase === 'complete') return 100
        if (phase === 'shell' && shellProgress.total > 0) {
            const start = (activePhaseIndex / phases.length) * 100
            const share = 100 / phases.length
            return start + (shellProgress.completed / shellProgress.total) * share
        }
        if (phase === 'data' && syncProgress.total > 0) {
            const start = (activePhaseIndex / phases.length) * 100
            const share = 100 / phases.length
            const completedTables = syncProgress.completed + (
                syncProgress.detail && syncProgress.detail.total > 0
                    ? syncProgress.detail.completed / syncProgress.detail.total
                    : 0
            )
            return start + (completedTables / syncProgress.total) * share
        }
        return (activePhaseIndex / phases.length) * 100 + 4
    })()

    const startPreparation = async () => {
        if (!user || isPreparing) return
        setDialogOpen(true)
        setIsPreparing(true)
        setResult(null)
        setErrorCode(null)
        setPhase('storage')
        setShellProgress({ completed: 0, total: 0 })

        try {
            const prepared = await prepareForOfflineUse({
                user,
                dataMode,
                onPhase: (nextPhase, progress) => {
                    setPhase(nextPhase)
                    if (progress) {
                        setShellProgress({ completed: progress.completed, total: progress.total })
                    }
                }
            })
            setResult(prepared)
            await refreshSnapshot()

            if (prepared.shellUpdated) {
                try {
                    sessionStorage.setItem(RELOAD_NOTICE_KEY, '1')
                } catch {
                    // The reload is still safe without a completion toast.
                }
                window.location.reload()
                return
            }

            toast({
                title: t('settings.offlineReadiness.successTitle'),
                description: prepared.outcome === 'ready'
                    ? t('settings.offlineReadiness.successDescription')
                    : t('settings.offlineReadiness.unprotectedDescription')
            })
        } catch (error) {
            console.error('[OfflineReadiness] Preparation failed:', error)
            setErrorCode(error instanceof OfflinePreparationError ? error.code : 'unexpected')
        } finally {
            setIsPreparing(false)
        }
    }

    if (!user || isTauri()) return null

    const isReady = snapshot?.ready === true
    const isProtected = snapshot?.storagePersisted === true
    const preparedAt = snapshot?.record?.preparedAt
        ? new Date(snapshot.record.preparedAt).toLocaleString(i18n.resolvedLanguage ?? i18n.language)
        : null
    const usage = formatBytes(snapshot?.record?.storageUsage ?? null)
    const quota = formatBytes(snapshot?.record?.storageQuota ?? null)

    return (
        <>
            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1.5">
                            <CardTitle className="flex items-center gap-2">
                                <ShieldCheck className="h-5 w-5" />
                                {t('settings.offlineReadiness.title')}
                            </CardTitle>
                            <CardDescription>{t('settings.offlineReadiness.description')}</CardDescription>
                        </div>
                        <Badge
                            variant={isReady ? 'default' : 'secondary'}
                            className={cn(
                                'w-fit gap-1.5',
                                isReady && isProtected && 'bg-emerald-600 text-white',
                                isReady && !isProtected && 'bg-amber-500 text-white'
                            )}
                        >
                            {isChecking ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            ) : isReady ? (
                                isProtected ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />
                            ) : (
                                <WifiOff className="h-3.5 w-3.5" />
                            )}
                            {isChecking
                                ? t('settings.offlineReadiness.checking')
                                : isReady
                                    ? isProtected
                                        ? t('settings.offlineReadiness.ready')
                                        : t('settings.offlineReadiness.readyUnprotected')
                                    : t('settings.offlineReadiness.notReady')}
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <StatusItem
                            icon={CloudDownload}
                            label={t('settings.offlineReadiness.appFiles')}
                            value={snapshot?.shell.ready
                                ? t('settings.offlineReadiness.cachedAssets', { count: snapshot.shell.cachedAssets ?? 0 })
                                : t('settings.offlineReadiness.incomplete')}
                            ready={snapshot?.shell.ready === true}
                        />
                        <StatusItem
                            icon={Database}
                            label={t('settings.offlineReadiness.workspaceData')}
                            value={preparedAt ?? t('settings.offlineReadiness.neverPrepared')}
                            ready={Boolean(snapshot?.record)}
                        />
                        <StatusItem
                            icon={HardDrive}
                            label={t('settings.offlineReadiness.storageProtection')}
                            value={isProtected
                                ? usage && quota
                                    ? t('settings.offlineReadiness.storageUsage', { usage, quota })
                                    : t('settings.offlineReadiness.protected')
                                : t('settings.offlineReadiness.notProtected')}
                            ready={isProtected}
                            warning={!isProtected}
                        />
                    </div>

                    <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/25 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-muted-foreground">
                            {t('settings.offlineReadiness.scopeDescription')}
                        </p>
                        <Button
                            allowViewer={true}
                            className="shrink-0 gap-2"
                            disabled={!isOnline || isPreparing}
                            onClick={() => void startPreparation()}
                        >
                            {isPreparing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
                            {isPreparing
                                ? t('settings.offlineReadiness.preparing')
                                : t('settings.offlineReadiness.prepareButton')}
                        </Button>
                    </div>
                    {!isOnline && (
                        <p className="flex items-center gap-2 text-sm text-amber-600">
                            <WifiOff className="h-4 w-4" />
                            {t('settings.offlineReadiness.onlineRequired')}
                        </p>
                    )}
                </CardContent>
            </Card>

            <AppDialog open={dialogOpen} onOpenChange={(open) => !isPreparing && setDialogOpen(open)}>
                <AppDialogContent
                    className="max-w-2xl"
                    showCloseButton={!isPreparing}
                    onPointerDownOutside={(event) => isPreparing && event.preventDefault()}
                    onEscapeKeyDown={(event) => isPreparing && event.preventDefault()}
                >
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <CloudDownload className="h-5 w-5" />
                            {t('settings.offlineReadiness.dialogTitle')}
                        </AppDialogTitle>
                        <AppDialogDescription>
                            {t('settings.offlineReadiness.dialogDescription')}
                        </AppDialogDescription>
                    </AppDialogHeader>
                    <AppDialogBody className="space-y-5">
                        <Progress value={Math.min(100, Math.max(0, progressValue))} />

                        <div className="space-y-2">
                            {phases.map((row, index) => {
                                const Icon = row.icon
                                const complete = Boolean(result) || phase === 'complete' || index < activePhaseIndex
                                const active = isPreparing && index === activePhaseIndex
                                return (
                                    <div
                                        key={row.phase}
                                        className={cn(
                                            'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm',
                                            complete && 'border-emerald-500/30 bg-emerald-500/5',
                                            active && 'border-primary/40 bg-primary/5'
                                        )}
                                    >
                                        {complete ? (
                                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                                        ) : active ? (
                                            <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
                                        ) : (
                                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        )}
                                        <span>{t(`settings.offlineReadiness.phases.${row.phase}`)}</span>
                                        {active && row.phase === 'shell' && shellProgress.total > 0 && (
                                            <span className="ms-auto text-xs text-muted-foreground">
                                                {shellProgress.completed}/{shellProgress.total}
                                            </span>
                                        )}
                                        {active && row.phase === 'data' && syncProgress.total > 0 && (
                                            <span className="ms-auto text-xs text-muted-foreground">
                                                {syncProgress.detail && syncProgress.detail.total > 0
                                                    ? t('settings.offlineReadiness.recordProgress', {
                                                        completed: syncProgress.detail.completed.toLocaleString(i18n.resolvedLanguage ?? i18n.language),
                                                        total: syncProgress.detail.total.toLocaleString(i18n.resolvedLanguage ?? i18n.language)
                                                    })
                                                    : `${syncProgress.completed}/${syncProgress.total}`}
                                            </span>
                                        )}
                                    </div>
                                )
                            })}
                        </div>

                        {result && (
                            <div className={cn(
                                'rounded-xl border p-4 text-sm',
                                result.outcome === 'ready'
                                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
                                    : 'border-amber-500/30 bg-amber-500/10 text-amber-700'
                            )}>
                                <div className="flex items-start gap-2">
                                    {result.outcome === 'ready'
                                        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                                        : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                                    <span>{result.outcome === 'ready'
                                        ? t('settings.offlineReadiness.successDescription')
                                        : t('settings.offlineReadiness.unprotectedDescription')}</span>
                                </div>
                            </div>
                        )}

                        {errorCode && (
                            <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                                <div className="flex items-start gap-2">
                                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                    <span>{t(`settings.offlineReadiness.errors.${errorCode}`)}</span>
                                </div>
                            </div>
                        )}
                    </AppDialogBody>
                    <AppDialogFooter>
                        {errorCode && (
                            <Button
                                variant="outline"
                                disabled={isPreparing || !isOnline}
                                onClick={() => void startPreparation()}
                            >
                                <RefreshCw className="h-4 w-4" />
                                {t('common.retry')}
                            </Button>
                        )}
                        <Button
                            disabled={isPreparing}
                            onClick={() => setDialogOpen(false)}
                        >
                            {isPreparing ? (
                                <>
                                    <RefreshCw className="h-4 w-4 animate-spin" />
                                    {t('settings.offlineReadiness.preparing')}
                                </>
                            ) : (
                                t('common.close')
                            )}
                        </Button>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>
        </>
    )
}

function StatusItem({
    icon: Icon,
    label,
    value,
    ready,
    warning = false
}: {
    icon: typeof ShieldCheck
    label: string
    value: string
    ready: boolean
    warning?: boolean
}) {
    return (
        <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Icon className="h-4 w-4" />
                {label}
            </div>
            <div className="flex items-start gap-2 text-sm font-medium">
                {ready ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : warning ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                    <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="break-words">{value}</span>
            </div>
        </div>
    )
}
