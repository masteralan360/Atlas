import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useId,
    useMemo,
    useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react'

import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import {
    getWorkspaceDataFetchSource,
    readWorkspaceDataHydration,
    readWorkspaceDataFetch,
    WORKSPACE_DATA_HYDRATION_EVENT,
    WORKSPACE_DATA_FETCH_EVENT,
    type WorkspaceDataHydrationSnapshot,
    type WorkspaceDataFetchSnapshot
} from '@/workspace/workspaceDataFreshness'
import { cn } from '@/lib/utils'
import { formatModulePageRelativeTime } from './modulePageFreshnessFormat'

type ModulePageFreshnessLoadingContextValue = {
    setLoading: (id: string, isLoading: boolean) => void
}

const ModulePageFreshnessLoadingContext = createContext<ModulePageFreshnessLoadingContextValue | null>(null)

/**
 * Aggregates only the freshness readers mounted by the current module. This
 * keeps the shell animation scoped to the page's own declared data tables.
 */
export function ModulePageFreshnessLoadingProvider({
    children
}: {
    children: (isLoading: boolean) => ReactNode
}) {
    const [activeLoaderIds, setActiveLoaderIds] = useState<ReadonlySet<string>>(() => new Set())

    const setLoading = useCallback((id: string, isLoading: boolean) => {
        setActiveLoaderIds((current) => {
            if (current.has(id) === isLoading) return current

            const next = new Set(current)
            if (isLoading) {
                next.add(id)
            } else {
                next.delete(id)
            }
            return next
        })
    }, [])

    const value = useMemo<ModulePageFreshnessLoadingContextValue>(() => ({ setLoading }), [setLoading])

    return (
        <ModulePageFreshnessLoadingContext.Provider value={value}>
            {children(activeLoaderIds.size > 0)}
        </ModulePageFreshnessLoadingContext.Provider>
    )
}

function useRegisterModulePageFreshnessLoading(isLoading: boolean) {
    const context = useContext(ModulePageFreshnessLoadingContext)
    const id = useId()
    const setLoading = context?.setLoading

    useEffect(() => {
        if (!setLoading) return

        setLoading(id, isLoading)
        return () => setLoading(id, false)
    }, [id, isLoading, setLoading])
}

export function ModulePageFreshness({
    className,
    tableNames,
    loadingIconOnly = false
}: {
    className?: string
    /** Limits freshness feedback to the data actually shown by this module. */
    tableNames?: readonly string[]
    /** Shows only a spinner while the scoped tables are refreshing. */
    loadingIconOnly?: boolean
}) {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const source = getWorkspaceDataFetchSource(features.data_mode)
    const workspaceId = user?.workspaceId
    const tableNamesKey = tableNames?.filter(Boolean).join('|') ?? ''
    const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(() => (
        readWorkspaceDataFetch(workspaceId, source, tableNames)?.fetchedAt ?? null
    ))
    const [hydration, setHydration] = useState<WorkspaceDataHydrationSnapshot | null>(() => (
        readWorkspaceDataHydration(workspaceId, source, tableNames)
    ))
    const [, setClock] = useState(0)

    useEffect(() => {
        const scopedTableNames = tableNamesKey ? tableNamesKey.split('|') : undefined
        setLastFetchedAt(readWorkspaceDataFetch(workspaceId, source, scopedTableNames)?.fetchedAt ?? null)

        const handleFetch = (event: Event) => {
            const snapshot = (event as CustomEvent<WorkspaceDataFetchSnapshot>).detail
            if (
                snapshot?.workspaceId === workspaceId
                && snapshot.source === source
                && (tableNamesKey.length === 0 || Boolean(snapshot.tableName && scopedTableNames?.includes(snapshot.tableName)))
            ) {
                setLastFetchedAt(snapshot.fetchedAt)
            }
        }

        window.addEventListener(WORKSPACE_DATA_FETCH_EVENT, handleFetch)
        return () => window.removeEventListener(WORKSPACE_DATA_FETCH_EVENT, handleFetch)
    }, [source, tableNamesKey, workspaceId])

    useEffect(() => {
        const scopedTableNames = tableNamesKey ? tableNamesKey.split('|') : undefined
        setHydration(readWorkspaceDataHydration(workspaceId, source, scopedTableNames))

        const handleHydration = (event: Event) => {
            const snapshot = (event as CustomEvent<WorkspaceDataHydrationSnapshot>).detail
            if (snapshot?.workspaceId === workspaceId && snapshot.source === source) {
                setHydration(readWorkspaceDataHydration(workspaceId, source, scopedTableNames))
            }
        }

        window.addEventListener(WORKSPACE_DATA_HYDRATION_EVENT, handleHydration)
        return () => window.removeEventListener(WORKSPACE_DATA_HYDRATION_EVENT, handleHydration)
    }, [source, tableNamesKey, workspaceId])

    useEffect(() => {
        const interval = window.setInterval(() => setClock((value) => value + 1), 60_000)
        return () => window.clearInterval(interval)
    }, [])

    const completionAt = hydration?.lastResult?.state === 'complete'
        ? new Date(hydration.lastResult.at).getTime()
        : null
    const completionIsRecent = completionAt !== null
        && !Number.isNaN(completionAt)
        && Date.now() - completionAt < 3_500

    useEffect(() => {
        if (!completionIsRecent || completionAt === null) return

        const timeout = window.setTimeout(() => setClock((value) => value + 1), Math.max(0, 3_500 - (Date.now() - completionAt)))
        return () => window.clearTimeout(timeout)
    }, [completionAt, completionIsRecent])

    const relativeTime = lastFetchedAt
        ? formatModulePageRelativeTime(lastFetchedAt, i18n.resolvedLanguage || i18n.language, t)
        : null
    const freshnessLabel = relativeTime
        ? t('launcher.freshness.updated', { time: relativeTime, defaultValue: `Updated ${relativeTime}` })
        : t('launcher.freshness.unavailable', { defaultValue: 'Update unavailable' })

    const isChecking = hydration?.isLoading === true
    useRegisterModulePageFreshnessLoading(isChecking)
    if (loadingIconOnly) {
        return isChecking ? (
            <span
                className={cn('inline-flex shrink-0 items-center', className)}
                role="status"
                aria-live="polite"
                aria-label={t('launcher.freshness.checking', { defaultValue: 'Checking for updates…' })}
            >
                <Loader2 aria-hidden="true" className="size-4 animate-spin text-current" />
            </span>
        ) : null
    }
    const hasFailed = !isChecking && hydration?.lastResult?.state === 'error'
    const label = isChecking
        ? t('launcher.freshness.checking', { defaultValue: 'Checking for updates…' })
        : hasFailed
            ? t('launcher.freshness.checkFailed', { defaultValue: 'Could not check for newer data' })
            : completionIsRecent
                ? t('launcher.freshness.upToDate', { defaultValue: 'Up to date' })
                : freshnessLabel

    return (
        <span
            className={cn('inline items-center text-current !ms-0', (isChecking || hasFailed || completionIsRecent) && 'inline-flex gap-1', className)}
            role="status"
            aria-live="polite"
            title={lastFetchedAt
                ? new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language || 'en', {
                    dateStyle: 'medium',
                    timeStyle: 'short'
                }).format(new Date(lastFetchedAt))
                : undefined}
        >
            {isChecking ? (
                <Loader2 aria-hidden="true" className="size-3 animate-spin text-primary" />
            ) : hasFailed ? (
                <CircleAlert aria-hidden="true" className="size-3 text-amber-600 dark:text-amber-400" />
            ) : completionIsRecent ? (
                <CheckCircle2 aria-hidden="true" className="size-3 text-emerald-600 dark:text-emerald-400" />
            ) : (
                <span aria-hidden="true" className="mx-1 text-primary">•</span>
            )}
            {label}
        </span>
    )
}
