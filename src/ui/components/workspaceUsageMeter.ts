import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
    getChargedWorkspaceUsageBytes,
    getWorkspaceUsageStatus,
    type WorkspaceUsageStatus
} from '@/lib/workspaceUsage'
import {
    buildWorkspaceUsageInsights,
    saveWorkspaceUsageSnapshot,
    type WorkspaceUsageLocalHistory
} from '@/lib/workspaceUsageHistory'
import type {
    WorkspaceUsageMeter,
    WorkspaceUsageMeterMetric,
    WorkspaceUsageMeterSegment
} from './WorkspaceUsageModal'
import type { WorkspacePaygSummary } from '@/lib/workspacePayments'
import { useWorkspace } from '@/workspace'

const WORKSPACE_USAGE_UPDATED_EVENT = 'workspace-usage-updated'
const WORKSPACE_USAGE_REFRESH_DELAY_MS = 1500
const WORKSPACE_USAGE_REFRESH_INTERVAL_MS = 30000

function getMetricPercent(usedValue?: number | null, limitValue?: number | null) {
    if (limitValue === null || limitValue === undefined) return null

    const used = Number(usedValue ?? 0)
    const limit = Number(limitValue)
    if (!Number.isFinite(used) || !Number.isFinite(limit)) return null
    if (used <= 0) return 0
    if (limit <= 0) return 100

    return Math.min(100, Math.max(0, (used / limit) * 100))
}

function buildWorkspaceUsageMeter(
    status: WorkspaceUsageStatus | null,
    history: WorkspaceUsageLocalHistory | null,
    t: TFunction,
    paygSummary: WorkspacePaygSummary | null
): WorkspaceUsageMeter | null {
    if (!status?.has_limits) return null

    const storageLabel = t('workspaceUsage.storage')
    const chargedUsageLabel = t('workspaceUsage.chargedUsage')
    const rawSegments: Array<Omit<WorkspaceUsageMeterSegment, 'widthPercent'>> = []
    const metrics: WorkspaceUsageMeterMetric[] = []
    const titleParts: string[] = []

    const storagePercent = getMetricPercent(status.storage_units, status.storage_unit_limit)
    if (storagePercent !== null) {
        titleParts.push(`${storageLabel}: ${Math.round(storagePercent)}%`)
        const storageMetric: WorkspaceUsageMeterMetric = {
            key: 'storage',
            label: storageLabel,
            percent: storagePercent,
            barClassName: 'bg-primary',
            badgeClassName: 'bg-primary/10 text-primary ring-primary/20'
        }
        metrics.push(storageMetric)
        if (storagePercent > 0) {
            rawSegments.push({
                key: storageMetric.key,
                label: storageMetric.label,
                percent: storageMetric.percent,
                className: storageMetric.barClassName
            })
        }
    }

    const chargedUsageBytes = getChargedWorkspaceUsageBytes(status)
    const chargedUsageDisplayLimit = paygSummary?.enabled
        ? 100_000_000_000
        : status.monthly_data_transfer_limit_bytes
    const chargedUsagePercent = getMetricPercent(chargedUsageBytes, chargedUsageDisplayLimit)
    if (chargedUsagePercent !== null) {
        titleParts.push(`${chargedUsageLabel}: ${Math.round(chargedUsagePercent)}%`)
        const chargedUsageMetric: WorkspaceUsageMeterMetric = {
            key: 'chargedUsage',
            label: chargedUsageLabel,
            percent: chargedUsagePercent,
            barClassName: 'bg-amber-500 dark:bg-amber-400',
            badgeClassName: 'bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300'
        }
        metrics.push(chargedUsageMetric)
        if (chargedUsagePercent > 0) {
            rawSegments.push({
                key: chargedUsageMetric.key,
                label: chargedUsageMetric.label,
                percent: chargedUsageMetric.percent,
                className: chargedUsageMetric.barClassName
            })
        }
    }

    const overallPercent = rawSegments.length
        ? Math.max(...rawSegments.map((segment) => segment.percent))
        : 0
    const totalSegmentPercent = rawSegments.reduce((total, segment) => total + segment.percent, 0)
    const segments: WorkspaceUsageMeterSegment[] = rawSegments.map((segment) => ({
        ...segment,
        widthPercent: totalSegmentPercent > 0
            ? (segment.percent / totalSegmentPercent) * 100
            : 0
    }))

    return {
        percent: overallPercent,
        label: `${Math.round(overallPercent)}%`,
        title: titleParts.length
            ? t('workspaceUsage.title', { details: titleParts.join(' / ') })
            : t('workspaceUsage.emptyTitle'),
        segments,
        metrics,
        details: {
            storageUnits: Number(status.storage_units ?? 0),
            storageUnitLimit: status.storage_unit_limit === null
                ? null
                : Number(status.storage_unit_limit),
            chargedUsageBytes,
            chargedUsageLimitBytes: chargedUsageDisplayLimit === null
                ? null
                : Number(chargedUsageDisplayLimit),
            transferPeriodStart: status.transfer_period_start,
            insights: buildWorkspaceUsageInsights(status, history)
        }
    }
}

type UseWorkspaceUsageMeterOptions = {
    enabled: boolean
    workspaceId?: string | null
}

export function useWorkspaceUsageMeter({ enabled, workspaceId }: UseWorkspaceUsageMeterOptions) {
    const { t } = useTranslation()
    const { paygSummary, refreshPaygSummary } = useWorkspace()
    const [usageStatus, setUsageStatus] = useState<WorkspaceUsageStatus | null>(null)
    const [usageHistory, setUsageHistory] = useState<WorkspaceUsageLocalHistory | null>(null)
    const [isRefreshingWorkspaceUsage, setIsRefreshingWorkspaceUsage] = useState(false)
    const refreshUsageRef = useRef<(() => Promise<void>) | null>(null)

    useEffect(() => {
        if (!enabled || !workspaceId) {
            setUsageStatus(null)
            setUsageHistory(null)
            setIsRefreshingWorkspaceUsage(false)
            refreshUsageRef.current = null
            return
        }

        let cancelled = false
        let refreshTimeout: number | undefined
        let latestRequestId = 0

        const fetchUsageStatus = async (options: { includePayg?: boolean } = {}) => {
            const includePayg = options.includePayg !== false
            const requestId = ++latestRequestId
            try {
                const [statusResult] = await Promise.allSettled([
                    getWorkspaceUsageStatus(workspaceId),
                    includePayg ? refreshPaygSummary() : Promise.resolve(null)
                ])
                if (statusResult.status === 'rejected') throw statusResult.reason
                const status = statusResult.value
                // Focus, interval, and usage events can overlap. Ignore a response
                // from an older request so lower stale counters are never mistaken
                // for a server-side monthly reset.
                if (!cancelled && requestId === latestRequestId) {
                    setUsageStatus(status)
                    setUsageHistory((current) => (
                        status
                        && current?.workspaceId === status.workspace_id
                        && current.transferPeriodStart === status.transfer_period_start
                            ? current
                            : null
                    ))
                }

                if (status && !cancelled && requestId === latestRequestId) {
                    try {
                        const history = await saveWorkspaceUsageSnapshot(status)
                        if (!cancelled && requestId === latestRequestId) {
                            setUsageHistory(history)
                        }
                    } catch (error) {
                        console.warn('[WorkspaceUsage] Failed to save local usage history:', error)
                    }
                }
            } catch (error) {
                console.warn('[WorkspaceUsage] Failed to load workspace usage:', error)
                if (!cancelled && requestId === latestRequestId) {
                    setUsageStatus(null)
                    setUsageHistory(null)
                }
            }
        }

        const refreshWorkspaceUsage = async () => {
            setIsRefreshingWorkspaceUsage(true)
            try {
                await fetchUsageStatus()
            } finally {
                if (!cancelled) {
                    setIsRefreshingWorkspaceUsage(false)
                }
            }
        }

        refreshUsageRef.current = refreshWorkspaceUsage

        const scheduleUsageRefresh = (event?: Event) => {
            const detail = event instanceof CustomEvent
                ? event.detail as { workspaceId?: string } | undefined
                : undefined

            if (detail?.workspaceId && detail.workspaceId !== workspaceId) {
                return
            }

            if (refreshTimeout) {
                window.clearTimeout(refreshTimeout)
            }

            refreshTimeout = window.setTimeout(() => {
                void fetchUsageStatus()
            }, WORKSPACE_USAGE_REFRESH_DELAY_MS)
        }

        void fetchUsageStatus()
        const intervalId = window.setInterval(() => {
            void fetchUsageStatus()
        }, WORKSPACE_USAGE_REFRESH_INTERVAL_MS)
        const refreshUsageOnFocus = () => {
            void fetchUsageStatus()
        }
        window.addEventListener(WORKSPACE_USAGE_UPDATED_EVENT, scheduleUsageRefresh)
        window.addEventListener('focus', refreshUsageOnFocus)

        return () => {
            cancelled = true
            if (refreshUsageRef.current === refreshWorkspaceUsage) {
                refreshUsageRef.current = null
            }
            window.clearInterval(intervalId)
            if (refreshTimeout) {
                window.clearTimeout(refreshTimeout)
            }
            window.removeEventListener(WORKSPACE_USAGE_UPDATED_EVENT, scheduleUsageRefresh)
            window.removeEventListener('focus', refreshUsageOnFocus)
        }
    }, [enabled, refreshPaygSummary, workspaceId])

    return {
        usageMeter: buildWorkspaceUsageMeter(usageStatus, usageHistory, t, paygSummary),
        paygSummary,
        isRefreshingWorkspaceUsage,
        refreshWorkspaceUsage: async () => {
            await refreshUsageRef.current?.()
        }
    }
}
