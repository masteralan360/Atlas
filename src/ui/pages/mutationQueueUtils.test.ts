import { describe, expect, it, vi } from 'vitest'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import type { OfflineMutation } from '@/local-db/models'
import {
    canStartMutationQueueSync,
    filterMutationQueueRows,
    getMutationQueueRecoveryFailureKey,
    getMutationQueueStatusCounts,
    requestMutationQueueSync,
} from './mutationQueueUtils'

function mutation(overrides: Partial<OfflineMutation> = {}): OfflineMutation {
    return {
        id: 'mutation-1',
        workspaceId: 'workspace-1',
        entityType: 'products',
        entityId: 'product-1',
        operation: 'update',
        payload: { id: 'product-1' },
        createdAt: '2026-09-16T08:00:00.000Z',
        status: 'pending',
        ...overrides,
    }
}

describe('mutation queue utilities', () => {
    it('shows actionable rows by default, ordered newest first, and isolates the active workspace', () => {
        const rows = filterMutationQueueRows([
            mutation({ id: 'pending-old', createdAt: '2026-09-16T08:00:00.000Z' }),
            mutation({ id: 'failed-new', status: 'failed', createdAt: '2026-09-16T10:00:00.000Z' }),
            mutation({ id: 'synced', status: 'synced' }),
            mutation({ id: 'other-workspace', workspaceId: 'workspace-2' }),
        ], 'workspace-1', {
            search: '',
            status: 'actionable',
            dateRange: 'allTime',
            customDates: { start: '', end: '' },
        })

        expect(rows.map((row) => row.id)).toEqual(['failed-new', 'pending-old'])
    })

    it('filters historical statuses and search terms', () => {
        const rows = filterMutationQueueRows([
            mutation({ id: 'synced', status: 'synced', createdAt: '2026-09-16T23:59:59.000Z', error: 'remote completed' }),
            mutation({ id: 'outside-date', status: 'synced', createdAt: '2026-09-17T00:00:00.000Z' }),
            mutation({ id: 'different-status', status: 'discarded', createdAt: '2026-09-16T12:00:00.000Z' }),
        ], 'workspace-1', {
            search: 'completed',
            status: 'synced',
            dateRange: 'allTime',
            customDates: { start: '', end: '' },
        })

        expect(rows.map((row) => row.id)).toEqual(['synced'])
    })

    it('reveals the complete local history when the all-history filter is selected', () => {
        const rows = filterMutationQueueRows([
            mutation({ id: 'pending', status: 'pending' }),
            mutation({ id: 'synced', status: 'synced' }),
            mutation({ id: 'discarded', status: 'discarded' }),
        ], 'workspace-1', {
            search: '',
            status: 'allHistory',
            dateRange: 'allTime',
            customDates: { start: '', end: '' },
        })

        expect(rows.map((row) => row.id)).toEqual(['pending', 'synced', 'discarded'])
    })

    it('uses the shared inclusive custom creation-date boundary', () => {
        const customDates = { start: '2026-09-16', end: '2026-09-16' }

        expect(isDateInDateRange(
            new Date(2026, 8, 16, 23, 59, 59),
            'custom',
            customDates,
            new Date('2026-09-16T12:00:00.000Z'),
            '00:00'
        )).toBe(true)
        expect(isDateInDateRange(
            new Date(2026, 8, 17, 0, 0, 0),
            'custom',
            customDates,
            new Date('2026-09-16T12:00:00.000Z'),
            '00:00'
        )).toBe(false)
    })

    it('counts every status only for the active workspace', () => {
        expect(getMutationQueueStatusCounts([
            mutation({ status: 'pending' }),
            mutation({ id: 'failed', status: 'failed' }),
            mutation({ id: 'discarded', status: 'discarded' }),
            mutation({ id: 'other', workspaceId: 'workspace-2', status: 'synced' }),
        ], 'workspace-1')).toEqual({
            pending: 1,
            syncing: 0,
            failed: 1,
            synced: 0,
            discarded: 1,
        })
    })

    it('maps every guarded recovery failure to a user-facing translation key', () => {
        expect([
            'not_found',
            'not_recoverable',
            'cloud_authority_unavailable',
            'dependent_changes',
            'remote_missing',
            'changed_during_recovery',
            'remote_request_failed',
        ].map((reason) => getMutationQueueRecoveryFailureKey(reason as Parameters<typeof getMutationQueueRecoveryFailureKey>[0])))
            .toEqual([
                'mutationQueue.recoveryFailures.not_found',
                'mutationQueue.recoveryFailures.not_recoverable',
                'mutationQueue.recoveryFailures.cloud_authority_unavailable',
                'mutationQueue.recoveryFailures.dependent_changes',
                'mutationQueue.recoveryFailures.remote_missing',
                'mutationQueue.recoveryFailures.changed_during_recovery',
                'mutationQueue.recoveryFailures.remote_request_failed',
            ])
    })

    it('only invokes the standard full-sync callback when the device is ready', async () => {
        const sync = vi.fn(async () => undefined)

        expect(canStartMutationQueueSync({ isOnline: false, isSyncing: false, isSupabaseConfigured: true })).toBe(false)
        expect(await requestMutationQueueSync({
            isOnline: false,
            isSyncing: false,
            isSupabaseConfigured: true,
            sync,
        })).toBe(false)
        expect(sync).not.toHaveBeenCalled()

        expect(await requestMutationQueueSync({
            isOnline: true,
            isSyncing: false,
            isSupabaseConfigured: true,
            sync,
        })).toBe(true)
        expect(sync).toHaveBeenCalledTimes(1)
    })
})
