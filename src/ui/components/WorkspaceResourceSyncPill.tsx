import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
    assetManager,
    type WorkspaceResourceSyncProgress,
} from '@/lib/assetManager'
import { cn } from '@/lib/utils'

const SUCCESS_FADE_DELAY_MS = 4000
const SUCCESS_HIDE_DELAY_MS = 5000

export function WorkspaceResourceSyncPill() {
    const { t } = useTranslation()
    const [progress, setProgress] = useState<WorkspaceResourceSyncProgress>(() =>
        assetManager.getWorkspaceResourceSyncProgress()
    )
    const [isHidden, setIsHidden] = useState(progress.status === 'idle')
    const [isFading, setIsFading] = useState(false)

    useEffect(() => {
        const handleProgress = (nextProgress: WorkspaceResourceSyncProgress) => {
            setProgress(nextProgress)
            setIsHidden(nextProgress.status === 'idle')
        }

        assetManager.on('workspace-resource-sync', handleProgress)
        handleProgress(assetManager.getWorkspaceResourceSyncProgress())

        return () => {
            assetManager.off('workspace-resource-sync', handleProgress)
        }
    }, [])

    useEffect(() => {
        if (progress.status !== 'upToDate') {
            setIsFading(false)
            return
        }

        const fadeTimer = window.setTimeout(() => setIsFading(true), SUCCESS_FADE_DELAY_MS)
        const hideTimer = window.setTimeout(() => setIsHidden(true), SUCCESS_HIDE_DELAY_MS)

        return () => {
            window.clearTimeout(fadeTimer)
            window.clearTimeout(hideTimer)
        }
    }, [progress.status])

    if (isHidden || progress.status === 'idle') return null

    const isDownloading = progress.status === 'downloading'
    const isWorking = progress.status === 'checking' || isDownloading
    const isReloadRequired = progress.status === 'reloadRequired'
    const isError = progress.status === 'error'
    const label = progress.status === 'checking'
        ? t('workspaceResourceSync.checking')
        : isDownloading
            ? t('workspaceResourceSync.downloading', {
                current: progress.current ?? 0,
                total: progress.total ?? 0,
            })
            : progress.status === 'upToDate'
                ? t('workspaceResourceSync.upToDate')
                : isReloadRequired
                    ? t('workspaceResourceSync.newResourcesReady')
                    : t('workspaceResourceSync.downloadNeedsAttention')
    const actionLabel = isReloadRequired
        ? t('workspaceResourceSync.reloadToApply')
        : isError
            ? t('workspaceResourceSync.retry')
            : undefined
    const tooltip = isDownloading && progress.currentFile
        ? t('workspaceResourceSync.downloadingFile', { fileName: progress.currentFile })
        : actionLabel
            ? `${label}: ${actionLabel}`
            : label
    const Icon = isError ? AlertTriangle : isReloadRequired ? RefreshCw : isWorking ? Loader2 : Check
    const accentClass = isError
        ? 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-300'
        : isReloadRequired
            ? 'border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-300'
            : progress.status === 'upToDate'
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                : 'border-primary/25 bg-primary/10 text-primary'
    const dotClass = isError
        ? 'bg-red-500'
        : isReloadRequired
            ? 'bg-blue-500'
            : progress.status === 'upToDate'
                ? 'bg-emerald-500'
                : 'bg-primary'
    const pillClassName = cn(
        'flex max-w-[230px] shrink items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all duration-1000',
        accentClass,
        isFading && 'pointer-events-none opacity-0',
        (isReloadRequired || isError) && 'hover:brightness-95'
    )
    const pillContent = (
        <>
            <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass)} />
            <Icon className={cn('h-3.5 w-3.5 shrink-0', isWorking && 'animate-spin')} />
            <span className="truncate">{label}</span>
            {actionLabel && <span className="shrink-0 font-semibold">{actionLabel}</span>}
        </>
    )

    if (isReloadRequired) {
        return (
            <button
                type="button"
                onClick={() => window.location.reload()}
                className={pillClassName}
                title={tooltip}
                aria-label={tooltip}
            >
                {pillContent}
            </button>
        )
    }

    if (isError) {
        return (
            <button
                type="button"
                onClick={() => assetManager.retryColdStartSync()}
                className={pillClassName}
                title={tooltip}
                aria-label={tooltip}
            >
                {pillContent}
            </button>
        )
    }

    return (
        <div className={pillClassName} role="status" aria-live="polite" title={tooltip}>
            {pillContent}
        </div>
    )
}
