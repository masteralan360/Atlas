import { describe, expect, it } from 'vitest'
import type { AgentCommissionEntry, SalesOrder, SalesOrderAgentAssignment } from '@/local-db'
import { filterAgentCommissionPeriod } from './agentCommissionDateRange'
import { buildCommissionHistoryGroups, summarizeCommissionEntries } from './agentCommissionPresentation'

const now = new Date(2026, 8, 16, 12)
const emptyDates = { start: '', end: '' }
const metadata = {
    workspaceId: 'workspace', createdAt: new Date(2026, 8, 16).toISOString(),
    updatedAt: new Date(2026, 8, 16).toISOString(), syncStatus: 'synced' as const,
    version: 1, isDeleted: false, lastSyncedAt: null,
}
function entry(overrides: Partial<AgentCommissionEntry> = {}): AgentCommissionEntry {
    return {
        ...metadata, id: 'commission', agentId: 'agent', orderId: 'sale', assignmentId: 'assignment',
        kind: 'accrual', status: 'earned', commissionMode: 'tracked', currency: 'iqd',
        calculationBasis: 'net_profit', includeTax: false, includeDeliveryCharge: false,
        basisAmount: 0, revenueAmount: 0, costAmount: 0, taxAmount: 0, deliveryChargeAmount: 0,
        ratePercent: 0, amount: 228_500, occurredAt: new Date(2026, 8, 3).toISOString(), ...overrides,
    }
}
function order(overrides: Partial<SalesOrder> = {}): SalesOrder {
    return {
        ...metadata, id: 'sale', orderNumber: 'SO-2026-00010', customerId: 'customer', customerName: 'Customer',
        items: [], subtotal: 1_000, discount: 0, tax: 0, total: 1_000, currency: 'iqd',
        exchangeRate: null, exchangeRateSource: null, exchangeRateTimestamp: null,
        status: 'completed', actualDeliveryDate: new Date(2026, 8, 3).toISOString(),
        isPaid: false, paymentStatus: 'unpaid', paidAmount: 0, balanceAmount: 1_000,
        initialPaymentAmount: 0, isInstallmentBased: false, installmentCount: 0, ...overrides,
    }
}
function assignment(overrides: Partial<SalesOrderAgentAssignment> = {}): SalesOrderAgentAssignment {
    return {
        ...metadata, id: 'assignment', orderId: 'sale', agentId: 'agent',
        assignedAt: new Date(2026, 7, 30).toISOString(), deliveryChargeAmount: 0, internalDeliveryCostAmount: 0,
        ...overrides,
    }
}
const period = (entries: AgentCommissionEntry[], orders: SalesOrder[] = [order()], assignments = [assignment()]) =>
    filterAgentCommissionPeriod(entries, assignments, orders, 'month', emptyDates, now, '00:00')

describe('commission overview date range', () => {
    it('places backfilled commissions in their original activity period and reconciles the September difference', () => {
        const entries = [entry(), entry({ id: 'august', orderId: 'august-sale', amount: 4_200, occurredAt: new Date(2026, 7, 31).toISOString() })]
        const september = period(entries)
        expect(summarizeCommissionEntries(september.entries, 'tracked').earned).toEqual({ iqd: 228_500 })
        const allTime = filterAgentCommissionPeriod(entries, [assignment()], [order()], 'allTime', emptyDates, now)
        expect(summarizeCommissionEntries(allTime.entries, 'tracked').earned).toEqual({ iqd: 232_700 })
        expect(summarizeCommissionEntries(september.entries).due).toEqual({})
        expect(buildCommissionHistoryGroups(september.entries)[0]).toMatchObject({ earned: 228_500, status: 'tracked', outstanding: 0 })
    })

    it('uses fulfillment rather than order creation or assignment dates for completed sales', () => {
        const orders = [order({ createdAt: new Date(2026, 7, 30).toISOString() }), order({ id: 'old-sale', actualDeliveryDate: new Date(2026, 7, 31).toISOString() })]
        const result = period([entry()], orders, [assignment(), assignment({ id: 'old-assignment', orderId: 'old-sale' })])
        expect(result.salesOrders.map((sale) => sale.id)).toEqual(['sale'])
        expect(result.assignments.map((assigned) => assigned.id)).toEqual(['assignment'])
    })

    it('uses the earliest original accrual for legacy completed orders missing fulfillment dates', () => {
        const entries = [entry({ id: 'later', occurredAt: new Date(2026, 8, 5).toISOString() }), entry({ id: 'original', occurredAt: new Date(2026, 7, 31).toISOString() })]
        expect(period(entries, [order({ actualDeliveryDate: null })]).salesOrders).toEqual([])
        expect(period([entry()], [order({ actualDeliveryDate: null, createdAt: new Date(2026, 7, 30).toISOString() })]).salesOrders).toHaveLength(1)
    })

    it('uses creation dates for unfulfilled orders and ignores estimates as fulfillment dates', () => {
        const pending = order({ status: 'pending', actualDeliveryDate: null, createdAt: new Date(2026, 7, 30).toISOString() })
        expect(period([entry({ kind: 'estimate', status: 'estimated' })], [pending]).salesOrders).toEqual([])
        expect(period([], [order({ status: 'draft', actualDeliveryDate: null })]).salesOrders).toHaveLength(1)
    })

    it('includes the start boundary and excludes the next day after a custom end date', () => {
        const entries = [
            entry({ id: 'before', occurredAt: new Date(2026, 8, 3, 9, 59, 59, 999).toISOString() }),
            entry({ id: 'start', occurredAt: new Date(2026, 8, 3, 10).toISOString() }),
            entry({ id: 'end', occurredAt: new Date(2026, 8, 4, 9, 59, 59, 999).toISOString() }),
            entry({ id: 'after', occurredAt: new Date(2026, 8, 4, 10).toISOString() }),
        ]
        const result = filterAgentCommissionPeriod(entries, [], [], 'custom', { start: '2026-09-03', end: '2026-09-03' }, now, '10:00')
        expect(result.entries.map((record) => record.id)).toEqual(['start', 'end'])
    })

    it('supports Today, Yesterday and Last Month using the shared business-day boundary', () => {
        const entries = [entry({ id: 'today', occurredAt: new Date(2026, 8, 16, 10).toISOString() }), entry({ id: 'yesterday', occurredAt: new Date(2026, 8, 16, 9).toISOString() }), entry({ id: 'last-month', occurredAt: new Date(2026, 7, 31, 12).toISOString() })]
        for (const [range, expected] of [['today', 'today'], ['yesterday', 'yesterday'], ['lastMonth', 'last-month']] as const) {
            expect(filterAgentCommissionPeriod(entries, [], [], range, emptyDates, now, '10:00').entries.map((record) => record.id)).toEqual([expected])
        }
    })

    it('supports open ranges, an empty custom range, and rejects reversed ranges', () => {
        expect(filterAgentCommissionPeriod([entry()], [], [], 'custom', { start: '2026-09-03', end: '' }, now).entries).toHaveLength(1)
        expect(filterAgentCommissionPeriod([entry()], [], [], 'custom', { start: '', end: '2026-09-02' }, now).entries).toEqual([])
        expect(filterAgentCommissionPeriod([entry()], [], [], 'custom', emptyDates, now).isScoped).toBe(false)
        expect(filterAgentCommissionPeriod([entry()], [], [], 'custom', { start: '2026-09-04', end: '2026-09-02' }, now).entries).toEqual([])
    })

    it('excludes deleted records and undated activity from scoped periods without substituting backfill dates', () => {
        const records = [entry({ id: 'deleted', isDeleted: true }), entry({ id: 'invalid', occurredAt: 'invalid' }), entry({ id: 'undated', occurredAt: '' })]
        expect(period(records).entries).toEqual([])
        expect(period([], [order({ isDeleted: true })]).assignments).toEqual([])
        expect(period([], [order()], [assignment({ isDeleted: true })]).assignments).toEqual([])
        const allTime = filterAgentCommissionPeriod(records, [], [], 'allTime', emptyDates, now)
        expect(allTime.entries.map((record) => record.id)).toEqual(['invalid', 'undated'])
    })

    it('reports reversals, payouts and recoveries on their own dates while keeping currencies and modes separate', () => {
        const result = period([
            entry({ id: 'old-earned', commissionMode: 'payable', amount: 10, occurredAt: new Date(2026, 7, 30).toISOString() }),
            entry({ id: 'reversal', commissionMode: 'payable', kind: 'reversal', status: 'reversed', amount: -2 }),
            entry({ id: 'payout', commissionMode: 'payable', kind: 'payout', status: 'paid', amount: -5 }),
            entry({ id: 'recovery', commissionMode: 'payable', kind: 'recovery', status: 'paid', amount: 1 }),
            entry({ id: 'dollars', currency: 'usd', amount: 1.234567 }),
        ])
        expect(summarizeCommissionEntries(result.entries)).toMatchObject({ earned: { iqd: -2 }, netPaid: { iqd: 4 }, due: { iqd: -6 } })
        expect(summarizeCommissionEntries(result.entries, 'tracked')).toMatchObject({ earned: { usd: 1.234567 }, due: {} })
    })

    it('preserves precision and review rounding and leaves source records unchanged', () => {
        const entries = [entry({ id: 'one', amount: 0.1 }), entry({ id: 'two', amount: 0.2 })]
        const orders = [order()]
        const assignments = [assignment()]
        const before = structuredClone({ entries, orders, assignments })
        const result = period(entries, orders, assignments)
        expect(summarizeCommissionEntries(result.entries, 'tracked').earned.iqd).toBeCloseTo(0.3, 6)
        expect(buildCommissionHistoryGroups(result.entries)[0].earned).toBe(0.3)
        expect({ entries, orders, assignments }).toEqual(before)
    })
})
