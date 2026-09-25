import { describe, expect, it } from 'vitest'
import type { SalesOrder } from '@/local-db'
import type { RevenueAnalysisRecord } from './revenueAnalysis'
import type { LedgerCashMovementEntry } from './ledgerCashMovementEntries'
import {
    getDashboardCashSummaries,
    getDashboardCashTrend,
    getDashboardPartnerProfit,
    getDashboardPeriodBounds,
    getDashboardTransactions,
} from './dashboardOverview'

const now = new Date(2026, 8, 24, 12)
const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).toISOString()
const cash = (
    day: number,
    type: string,
    direction: 'incoming' | 'outgoing',
    amount: number,
    currency: 'usd' | 'iqd' = 'usd',
): LedgerCashMovementEntry => ({ date: at(day), type, direction, amount, currency })
const saleRecord = (id: string, partyId: string | null, date = at(24)): RevenueAnalysisRecord => ({
    key: `sale:${id}`,
    id,
    source: 'sale',
    referenceCode: `#${id}`,
    date,
    currency: 'usd',
    origin: 'pos',
    cashier: '',
    partyId,
    hasPartialReturn: false,
    isReturned: false,
    items: [
        {
            productId: 'p',
            productName: 'Product',
            quantity: 2,
            returnedQuantity: 0,
            unitPrice: 15.125,
            costPrice: 5.125,
        },
    ],
})

describe('dashboard cash overview', () => {
    it('uses the Ledger cash equations, keeps currencies separate, and includes reversal effects', () => {
        const entries = [
            cash(24, 'pos_sale', 'incoming', 100),
            cash(24, 'pos_sale', 'outgoing', 10),
            cash(24, 'expense', 'outgoing', 30),
            cash(24, 'expense', 'incoming', 5),
            cash(24, 'loan_taken', 'incoming', 500),
            cash(24, 'pos_sale', 'incoming', 2500, 'iqd'),
            cash(14, 'pos_sale', 'incoming', 999),
        ]
        const summaries = getDashboardCashSummaries(entries, 'thisWeek', now)
        expect(summaries).toHaveLength(2)
        expect(summaries[0].summary.buckets.cashRevenueReceived.amount).toBe(100)
        expect(summaries[0].summary.buckets.cashRefundsPaid.amount).toBe(10)
        expect(summaries[0].summary.netCashRevenue).toBe(90)
        expect(summaries[0].summary.buckets.operatingCashPaid.amount).toBe(25)
        expect(summaries[0].summary.cashOperatingSurplus).toBe(65)
        expect(summaries[1].currency).toBe('iqd')
        expect(summaries[1].summary.netCashRevenue).toBe(2500)
        expect(
            getDashboardCashTrend(entries, 'thisWeek', 'usd', 'cashOperatingSurplus', now).reduce(
                (sum, point) => sum + point.value,
                0,
            ),
        ).toBe(65)
    })

    it('uses inclusive start and exclusive end for each period', () => {
        const { start, end } = getDashboardPeriodBounds('lastMonth', now)
        expect(start).toEqual(new Date(2026, 7, 1))
        expect(end).toEqual(new Date(2026, 8, 1))
        expect(getDashboardCashSummaries([cash(24, 'pos_sale', 'incoming', 1)], 'lastMonth', now)).toEqual([])
        const boundaryEntries: LedgerCashMovementEntry[] = [
            { date: start.toISOString(), type: 'pos_sale', direction: 'incoming', amount: 1, currency: 'usd' },
            { date: end.toISOString(), type: 'pos_sale', direction: 'incoming', amount: 9, currency: 'usd' },
        ]
        expect(getDashboardCashSummaries(boundaryEntries, 'lastMonth', now)[0].summary.netCashRevenue).toBe(1)
    })

    it('builds all five card sparklines from the same per-currency ledger buckets', () => {
        const entries = [
            cash(22, 'pos_sale', 'incoming', 100.125),
            cash(22, 'pos_sale', 'outgoing', 20.005),
            cash(22, 'expense', 'outgoing', 10.005),
            cash(23, 'pos_sale', 'incoming', 50),
            cash(23, 'expense', 'outgoing', 5),
            cash(24, 'pos_sale', 'incoming', 999, 'iqd'),
            cash(14, 'pos_sale', 'incoming', 999),
        ]
        const expected = {
            cashRevenueReceived: 150.125,
            cashRefundsPaid: 20.005,
            netCashRevenue: 130.12,
            operatingCashPaid: 15.005,
            cashOperatingSurplus: 115.115,
        } as const

        for (const [metric, total] of Object.entries(expected) as [keyof typeof expected, number][]) {
            const trend = getDashboardCashTrend(entries, 'thisWeek', 'usd', metric, now)
            expect(trend.reduce((sum, point) => sum + point.value, 0)).toBeCloseTo(total, 8)
            expect(trend.find((point) => point.timestamp === new Date(2026, 8, 22).getTime())?.value).not.toBe(0)
        }
    })
})

describe('dashboard transactions and partner profit', () => {
    it('keeps actual order status and shows zero realized revenue for an incomplete order', () => {
        const order: SalesOrder = {
            id: 'order-1',
            workspaceId: 'workspace-1',
            orderNumber: 'SO-1',
            status: 'pending',
            createdAt: at(24),
            updatedAt: at(24),
            syncStatus: 'synced',
            lastSyncedAt: at(24),
            version: 1,
            isDeleted: false,
            currency: 'usd',
            items: [],
            customerId: 'customer',
            customerName: 'Customer',
            subtotal: 0,
            discount: 0,
            tax: 0,
            total: 0,
            exchangeRate: null,
            exchangeRateSource: null,
            exchangeRateTimestamp: null,
            isPaid: false,
            paymentStatus: 'unpaid',
            paidAmount: 0,
            balanceAmount: 0,
            initialPaymentAmount: 0,
            isInstallmentBased: false,
            installmentCount: 0,
        }
        const rows = getDashboardTransactions([saleRecord('pos-1', null)], [order])
        expect(rows.map((row) => row.status)).toEqual(['sold', 'pending'])
        expect(rows[1].revenue).toBe(0)
        expect(rows[1].profit).toBe(0)
    })

    it('ranks linked partners by realized profit without merging currencies or anonymous sales', () => {
        const records = [
            saleRecord('one', 'partner-1'),
            saleRecord('two', 'partner-1'),
            saleRecord('three', 'partner-2'),
            saleRecord('four', null),
        ]
        records[2].items[0].returnedQuantity = 1
        const ranking = getDashboardPartnerProfit(
            records,
            'thisWeek',
            'usd',
            new Map([
                ['partner-1', 'Agent'],
                ['partner-2', 'Customer'],
            ]),
            now,
        )
        expect(ranking.map((item) => [item.name, item.profit])).toEqual([
            ['Agent', 40],
            ['Customer', 10],
        ])
        expect(getDashboardPartnerProfit(records, 'thisWeek', 'iqd', new Map(), now)).toEqual([])
    })

    it('rounds fractional partner profit and gives a returned POS sale its own status', () => {
        const record = saleRecord('fractional', 'partner-1')
        record.items = [
            {
                productId: 'p',
                productName: 'Product',
                quantity: 1,
                returnedQuantity: 0,
                unitPrice: 0.3,
                costPrice: 0.1,
            },
        ]
        expect(
            getDashboardPartnerProfit([record], 'today', 'usd', new Map([['partner-1', 'Partner']]), now)[0].profit,
        ).toBe(0.2)
        record.isReturned = true
        expect(getDashboardTransactions([record], [])[0]).toMatchObject({ status: 'returned', revenue: 0, profit: 0 })
    })
})
