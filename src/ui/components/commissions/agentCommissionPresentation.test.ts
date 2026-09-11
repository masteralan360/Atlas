import { describe, expect, it } from 'vitest'

import type { AgentCommissionEntry, AgentCommissionMembership, AgentCommissionPlan } from '@/local-db'
import {
    buildCommissionHistoryGroups,
    commissionEntryOrderReference,
    getActiveAgentCommissionMembership,
    getCurrentCommissionPlanRevision,
    summarizeCommissionEntries
} from './agentCommissionPresentation'

function membership(overrides: Partial<AgentCommissionMembership>): AgentCommissionMembership {
    return {
        id: overrides.id || 'membership',
        workspaceId: 'workspace',
        agentId: 'agent',
        planId: 'plan',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        syncStatus: 'synced',
        version: 1,
        isDeleted: false,
        ...overrides,
        lastSyncedAt: overrides.lastSyncedAt ?? null
    }
}

function entry(overrides: Partial<AgentCommissionEntry>): AgentCommissionEntry {
    return {
        id: overrides.id || 'entry',
        workspaceId: 'workspace',
        agentId: 'agent',
        kind: 'accrual',
        status: 'earned',
        currency: 'iqd',
        basisAmount: 100_000,
        revenueAmount: 150_000,
        costAmount: 50_000,
        taxAmount: 0,
        deliveryChargeAmount: 0,
        ratePercent: 5,
        amount: 5_000,
        occurredAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        syncStatus: 'synced',
        version: 1,
        isDeleted: false,
        ...overrides,
        calculationBasis: overrides.calculationBasis ?? 'net_profit',
        includeTax: overrides.includeTax ?? false,
        includeDeliveryCharge: overrides.includeDeliveryCharge ?? false,
        lastSyncedAt: overrides.lastSyncedAt ?? null
    }
}

function plan(overrides: Partial<AgentCommissionPlan>): AgentCommissionPlan {
    return {
        id: overrides.id || 'plan',
        workspaceId: 'workspace',
        name: 'Level 1',
        level: 'level_1',
        ratePercent: 5,
        calculationBasis: 'net_profit',
        includeTax: false,
        includeDeliveryCharge: false,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        syncStatus: 'synced',
        version: 1,
        isDeleted: false,
        ...overrides,
        lastSyncedAt: overrides.lastSyncedAt ?? null
    }
}

describe('agent commission presentation helpers', () => {
    it('does not expose an order UUID while its order number is still loading', () => {
        const pendingEntry = entry({ orderId: 'd372545f-8d6f-4925-bef2-7b02431ab1af' })

        expect(commissionEntryOrderReference(pendingEntry, new Map())).toBe('—')
        expect(commissionEntryOrderReference(pendingEntry, new Map([
            [pendingEntry.orderId as string, 'SO-2026-00102']
        ]))).toBe('SO-2026-00102')
    })

    it('selects the latest effective, unended membership', () => {
        const result = getActiveAgentCommissionMembership([
            membership({ id: 'old', planId: 'level-1', effectiveTo: '2026-02-01T00:00:00.000Z' }),
            membership({ id: 'current', planId: 'level-2', effectiveFrom: '2026-02-01T00:00:00.000Z' }),
            membership({ id: 'future', planId: 'level-3', effectiveFrom: '2027-01-01T00:00:00.000Z' })
        ], 'agent', new Date('2026-08-24T00:00:00.000Z'))

        expect(result?.id).toBe('current')
    })

    it('selects the newest active or open plan revision for a settings card', () => {
        const result = getCurrentCommissionPlanRevision([
            plan({ id: 'historical', effectiveFrom: '2026-08-25T00:00:00.000Z', effectiveTo: '2026-08-26T00:00:00.000Z', isActive: false }),
            plan({ id: 'inactive-open', effectiveFrom: '2026-08-20T00:00:00.000Z', isActive: false }),
            plan({ id: 'active-open', effectiveFrom: '2026-08-15T00:00:00.000Z', isActive: true }),
            plan({ id: 'other-level', level: 'level_2' })
        ], 'level_1')

        expect(result?.id).toBe('inactive-open')
    })

    it('falls back to the newest historical revision when no current revision exists', () => {
        const result = getCurrentCommissionPlanRevision([
            plan({ id: 'older', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-02-01T00:00:00.000Z', isActive: false }),
            plan({ id: 'newer', effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: '2026-04-01T00:00:00.000Z', isActive: false })
        ], 'level_1')

        expect(result?.id).toBe('newer')
    })

    it('keeps status totals separated by currency and counts unique orders', () => {
        const result = summarizeCommissionEntries([
            entry({ id: 'earned-iqd', orderId: 'order-1', status: 'earned', amount: 5_000, currency: 'iqd' }),
            entry({ id: 'approval-iqd', orderId: 'order-1', kind: 'approval', status: 'approved', amount: 0, currency: 'iqd', relatedEntryId: 'earned-iqd' }),
            entry({ id: 'paid-usd', orderId: 'order-1', kind: 'payout', status: 'paid', amount: -4, currency: 'usd' }),
            entry({ id: 'recovered-iqd', orderId: 'order-2', kind: 'recovery', status: 'paid', amount: 500, currency: 'iqd' }),
            entry({ id: 'reversed-iqd', orderId: 'order-2', kind: 'reversal', status: 'reversed', amount: -1_000, currency: 'iqd' })
        ])

        expect(result.earned).toEqual({ iqd: 4_000 })
        expect(result.paid).toEqual({ usd: 4 })
        expect(result.recovered).toEqual({ iqd: 500 })
        expect(result.approved).toEqual({ iqd: 5_000 })
        expect(result.reversed).toEqual({ iqd: -1_000 })
        expect(result.due).toEqual({ iqd: 5_000 - 1_000 + 500, usd: -4 })
        expect(result.orderCount).toBe(2)
    })

    it('nets linked return reversals into the approved source amount', () => {
        const result = summarizeCommissionEntries([
            entry({ id: 'accrual', orderId: 'order-1', kind: 'accrual', amount: 40 }),
            entry({ id: 'approval', orderId: 'order-1', kind: 'approval', status: 'approved', amount: 0, relatedEntryId: 'accrual' }),
            entry({ id: 'return-reversal', orderId: 'order-1', kind: 'reversal', status: 'reversed', amount: -20, relatedEntryId: 'accrual' })
        ])

        expect(result.approved).toEqual({ iqd: 20 })
    })

    it('counts nested approved adjustments and linked reversals only once', () => {
        const result = summarizeCommissionEntries([
            entry({ id: 'accrual', kind: 'accrual', amount: 10 }),
            entry({ id: 'approve-accrual', kind: 'approval', status: 'approved', amount: 0, relatedEntryId: 'accrual' }),
            entry({ id: 'return-adjustment', kind: 'adjustment', amount: -10, relatedEntryId: 'accrual' }),
            entry({ id: 'restored-adjustment', kind: 'adjustment', amount: 10, relatedEntryId: 'return-adjustment' }),
            entry({ id: 'approve-restored', kind: 'approval', status: 'approved', amount: 0, relatedEntryId: 'restored-adjustment' })
        ])

        expect(result.earned).toEqual({ iqd: 10 })
        expect(result.approved).toEqual({ iqd: 10 })
    })

    it('shows a normal product-commission replacement and payout as one paid order activity, not a reversal', () => {
        const result = buildCommissionHistoryGroups([
            entry({ id: 'original', orderId: 'order-1', kind: 'accrual', status: 'earned', amount: 10 }),
            entry({ id: 'replace-plan', orderId: 'order-1', kind: 'adjustment', status: 'reversed', amount: -10, relatedEntryId: 'original' }),
            entry({ id: 'product-commission', orderId: 'order-1', kind: 'adjustment', status: 'earned', amount: 10, relatedEntryId: 'original' }),
            entry({ id: 'payout', orderId: 'order-1', kind: 'payout', status: 'paid', amount: -10 }),
        ])

        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
            orderId: 'order-1',
            earned: 10,
            paid: 10,
            reversed: 0,
            outstanding: 0,
            status: 'paid',
        })
    })

    it('retains a real reversal in the grouped order activity', () => {
        const result = buildCommissionHistoryGroups([
            entry({ id: 'earned', orderId: 'order-1', kind: 'accrual', amount: 10 }),
            entry({ id: 'returned', orderId: 'order-1', kind: 'reversal', status: 'reversed', amount: -10, relatedEntryId: 'earned' }),
        ])

        expect(result[0]).toMatchObject({ earned: 0, reversed: 10, outstanding: 0, status: 'reversed' })
    })
})
