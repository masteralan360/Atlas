import { describe, expect, it, vi } from 'vitest'

import {
    getLaterMarketplaceOrderStatuses,
    getMarketplaceOrderAdvancementPath,
    getMarketplaceOrderAdvancementProgressMetrics,
    getMarketplaceOrderRefreshDisposition,
    getNextMarketplaceOrderStatus,
    runMarketplaceOrderAdvancement
} from './MarketplaceOrderWorkflow'

describe('marketplace order workflow', () => {
    it('returns the normal immediate next status', () => {
        expect(getNextMarketplaceOrderStatus('pending')).toBe('confirmed')
        expect(getNextMarketplaceOrderStatus('confirmed')).toBe('processing')
        expect(getNextMarketplaceOrderStatus('processing')).toBe('shipped')
        expect(getNextMarketplaceOrderStatus('shipped')).toBe('delivered')
        expect(getNextMarketplaceOrderStatus('delivered')).toBeNull()
        expect(getNextMarketplaceOrderStatus('cancelled')).toBeNull()
    })

    it('returns only statuses later than the current status', () => {
        expect(getLaterMarketplaceOrderStatuses('pending')).toEqual([
            'confirmed',
            'processing',
            'shipped',
            'delivered'
        ])
        expect(getLaterMarketplaceOrderStatuses('confirmed')).toEqual(['processing', 'shipped', 'delivered'])
        expect(getLaterMarketplaceOrderStatuses('processing')).toEqual(['shipped', 'delivered'])
        expect(getLaterMarketplaceOrderStatuses('shipped')).toEqual(['delivered'])
        expect(getLaterMarketplaceOrderStatuses('delivered')).toEqual([])
        expect(getLaterMarketplaceOrderStatuses('cancelled')).toEqual([])
    })

    it('builds every normal step through the selected target', () => {
        expect(getMarketplaceOrderAdvancementPath('pending', 'delivered')).toEqual([
            'confirmed',
            'processing',
            'shipped',
            'delivered'
        ])
        expect(getMarketplaceOrderAdvancementPath('confirmed', 'shipped')).toEqual(['processing', 'shipped'])
    })

    it('rejects the current status, previous statuses, and cancellation', () => {
        expect(getMarketplaceOrderAdvancementPath('processing', 'processing')).toBeNull()
        expect(getMarketplaceOrderAdvancementPath('processing', 'confirmed')).toBeNull()
        expect(getMarketplaceOrderAdvancementPath('pending', 'cancelled')).toBeNull()
        expect(getMarketplaceOrderAdvancementPath('cancelled', 'delivered')).toBeNull()
    })

    it('reports exact advancement progress and rounds the percentage', () => {
        expect(getMarketplaceOrderAdvancementProgressMetrics(1, 3)).toEqual({
            completedCount: 1,
            totalCount: 3,
            progressPercent: 33,
            activeStepIndex: 1
        })
        expect(getMarketplaceOrderAdvancementProgressMetrics(3, 4)).toEqual({
            completedCount: 3,
            totalCount: 4,
            progressPercent: 75,
            activeStepIndex: 3
        })
    })

    it('clamps advancement progress at its lower and upper boundaries', () => {
        expect(getMarketplaceOrderAdvancementProgressMetrics(-2, 4)).toEqual({
            completedCount: 0,
            totalCount: 4,
            progressPercent: 0,
            activeStepIndex: 0
        })
        expect(getMarketplaceOrderAdvancementProgressMetrics(9, 4)).toEqual({
            completedCount: 4,
            totalCount: 4,
            progressPercent: 100,
            activeStepIndex: null
        })
        expect(getMarketplaceOrderAdvancementProgressMetrics(1, 0)).toEqual({
            completedCount: 0,
            totalCount: 0,
            progressPercent: 0,
            activeStepIndex: null
        })
    })

    it('defers realtime reloads while an advancement sequence owns the refresh cycle', () => {
        expect(getMarketplaceOrderRefreshDisposition({
            eventWorkspaceId: 'workspace-1',
            activeWorkspaceId: 'workspace-1',
            source: 'realtime',
            isTransitioning: true
        })).toBe('defer')
        expect(getMarketplaceOrderRefreshDisposition({
            eventWorkspaceId: 'workspace-1',
            activeWorkspaceId: 'workspace-1',
            source: 'reconnected',
            isTransitioning: true
        })).toBe('defer')
    })

    it('loads realtime changes when idle and ignores local or unrelated invalidations', () => {
        expect(getMarketplaceOrderRefreshDisposition({
            eventWorkspaceId: 'workspace-1',
            activeWorkspaceId: 'workspace-1',
            source: 'realtime',
            isTransitioning: false
        })).toBe('load')
        expect(getMarketplaceOrderRefreshDisposition({
            eventWorkspaceId: 'workspace-1',
            activeWorkspaceId: 'workspace-1',
            source: 'local',
            isTransitioning: false
        })).toBe('ignore')
        expect(getMarketplaceOrderRefreshDisposition({
            eventWorkspaceId: 'workspace-2',
            activeWorkspaceId: 'workspace-1',
            source: 'realtime',
            isTransitioning: false
        })).toBe('ignore')
    })

    it('waits for each refresh hook before starting the next transition', async () => {
        const events: string[] = []

        const results = await runMarketplaceOrderAdvancement({
            currentStatus: 'pending',
            targetStatus: 'delivered',
            advanceStep: async (status) => {
                events.push(`advance:${status}`)
                return status
            },
            afterStep: async (status) => {
                events.push(`refresh:${status}`)
            }
        })

        expect(results).toEqual(['confirmed', 'processing', 'shipped', 'delivered'])
        expect(events).toEqual([
            'advance:confirmed',
            'refresh:confirmed',
            'advance:processing',
            'refresh:processing',
            'advance:shipped',
            'refresh:shipped',
            'advance:delivered',
            'refresh:delivered'
        ])
    })

    it('uses one transition for the immediate next status', async () => {
        const advanceStep = vi.fn(async (status: string) => status)
        const afterStep = vi.fn(async () => undefined)

        await runMarketplaceOrderAdvancement({
            currentStatus: 'processing',
            targetStatus: 'shipped',
            advanceStep,
            afterStep
        })

        expect(advanceStep).toHaveBeenCalledTimes(1)
        expect(advanceStep).toHaveBeenCalledWith('shipped')
        expect(afterStep).toHaveBeenCalledTimes(1)
    })

    it('stops immediately when a transition fails', async () => {
        const attempted: string[] = []
        const refreshed: string[] = []

        await expect(runMarketplaceOrderAdvancement({
            currentStatus: 'pending',
            targetStatus: 'delivered',
            advanceStep: async (status) => {
                attempted.push(status)
                if (status === 'shipped') throw new Error('shipping failed')
                return status
            },
            afterStep: async (status) => {
                refreshed.push(status)
            }
        })).rejects.toThrow('shipping failed')

        expect(attempted).toEqual(['confirmed', 'processing', 'shipped'])
        expect(refreshed).toEqual(['confirmed', 'processing'])
    })

    it('stops before the next transition when refreshing fails', async () => {
        const attempted: string[] = []

        await expect(runMarketplaceOrderAdvancement({
            currentStatus: 'pending',
            targetStatus: 'delivered',
            advanceStep: async (status) => {
                attempted.push(status)
                return status
            },
            afterStep: async (status) => {
                if (status === 'processing') throw new Error('refresh failed')
            }
        })).rejects.toThrow('refresh failed')

        expect(attempted).toEqual(['confirmed', 'processing'])
    })

    it('does not invoke callbacks for an invalid target', async () => {
        const advanceStep = vi.fn(async (status: string) => status)
        const afterStep = vi.fn(async () => undefined)

        const result = await runMarketplaceOrderAdvancement({
            currentStatus: 'processing',
            targetStatus: 'confirmed',
            advanceStep,
            afterStep
        })

        expect(result).toBeNull()
        expect(advanceStep).not.toHaveBeenCalled()
        expect(afterStep).not.toHaveBeenCalled()
    })
})
