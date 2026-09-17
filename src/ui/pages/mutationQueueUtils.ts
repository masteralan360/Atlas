import type { DateRangeType } from '@/context/DateRangeContext'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import type { MutationStatus, OfflineMutation } from '@/local-db/models'
import type { OfflineMutationRecoveryFailure } from '@/local-db/offlineMutationRecovery'

export const MUTATION_QUEUE_STATUSES = [
    'pending',
    'syncing',
    'failed',
    'synced',
    'discarded',
] as const satisfies readonly MutationStatus[]

export type MutationQueueStatusFilter = 'actionable' | 'allHistory' | MutationStatus

export interface MutationQueueFilters {
    search: string
    status: MutationQueueStatusFilter
    dateRange: DateRangeType
    customDates: { start: string, end: string }
}

export interface MutationQueueSyncRequest {
    isOnline: boolean
    isSyncing: boolean
    isSupabaseConfigured: boolean
    sync: () => Promise<void>
}

const ACTIONABLE_STATUSES = new Set<MutationStatus>(['pending', 'syncing', 'failed'])

const RECOVERY_FAILURE_TRANSLATION_KEYS: Record<OfflineMutationRecoveryFailure, string> = {
    not_found: 'mutationQueue.recoveryFailures.not_found',
    not_recoverable: 'mutationQueue.recoveryFailures.not_recoverable',
    cloud_authority_unavailable: 'mutationQueue.recoveryFailures.cloud_authority_unavailable',
    dependent_changes: 'mutationQueue.recoveryFailures.dependent_changes',
    remote_missing: 'mutationQueue.recoveryFailures.remote_missing',
    changed_during_recovery: 'mutationQueue.recoveryFailures.changed_during_recovery',
    remote_request_failed: 'mutationQueue.recoveryFailures.remote_request_failed',
}

export function getMutationQueueRecoveryFailureKey(reason: OfflineMutationRecoveryFailure): string {
    return RECOVERY_FAILURE_TRANSLATION_KEYS[reason]
}

export function filterMutationQueueRows(
    mutations: OfflineMutation[],
    workspaceId: string | undefined,
    filters: MutationQueueFilters
): OfflineMutation[] {
    if (!workspaceId) return []

    const normalizedSearch = filters.search.trim().toLocaleLowerCase()

    return mutations
        .filter((mutation) => {
            if (mutation.workspaceId !== workspaceId) return false
            if (!isDateInDateRange(mutation.createdAt, filters.dateRange, filters.customDates)) return false
            if (filters.status === 'actionable') {
                if (!ACTIONABLE_STATUSES.has(mutation.status)) return false
            } else if (filters.status !== 'allHistory' && mutation.status !== filters.status) {
                return false
            }

            if (!normalizedSearch) return true

            return [
                mutation.entityType,
                mutation.entityId,
                mutation.operation,
                mutation.status,
                mutation.error,
                mutation.discardedBy,
            ]
                .filter((value): value is string => Boolean(value))
                .join(' ')
                .toLocaleLowerCase()
                .includes(normalizedSearch)
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function getMutationQueueStatusCounts(
    mutations: OfflineMutation[],
    workspaceId: string | undefined
): Record<MutationStatus, number> {
    const counts: Record<MutationStatus, number> = {
        pending: 0,
        syncing: 0,
        failed: 0,
        synced: 0,
        discarded: 0,
    }

    if (!workspaceId) return counts

    for (const mutation of mutations) {
        if (mutation.workspaceId === workspaceId) counts[mutation.status] += 1
    }

    return counts
}

export function canStartMutationQueueSync({
    isOnline,
    isSyncing,
    isSupabaseConfigured,
}: Omit<MutationQueueSyncRequest, 'sync'>): boolean {
    return isOnline && !isSyncing && isSupabaseConfigured
}

export async function requestMutationQueueSync(request: MutationQueueSyncRequest): Promise<boolean> {
    if (!canStartMutationQueueSync(request)) return false

    await request.sync()
    return true
}
