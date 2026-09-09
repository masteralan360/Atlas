import { describe, expect, it } from 'vitest'

import {
    getLedgerCashBucketId,
    isLedgerCashDrilldownMatch,
    normalizeLedgerDashboardConfig,
    summarizeLedgerCashMovements,
    summarizeLedgerCashMovementsByCurrency,
    type LedgerCashSummaryEntry,
} from './ledgerCashSummary'

function entry(type: string, direction: LedgerCashSummaryEntry['direction'], amount: number): LedgerCashSummaryEntry {
    return { type, direction, amount }
}

describe('summarizeLedgerCashMovements', () => {
    it('keeps operating, borrowing, and lending cash separate while reconciling the headline', () => {
        const rows = [
            entry('pos_sale', 'incoming', 1_000),
            entry('activity_refund', 'outgoing', 50),
            entry('expense', 'outgoing', 250),
            entry('loan_taken', 'incoming', 500),
            entry('loan_repayment_paid', 'outgoing', 100),
            entry('loan_repayment_received', 'incoming', 80),
            entry('loan_given', 'outgoing', 200),
            entry('direct_inflow', 'incoming', 25),
        ]

        const summary = summarizeLedgerCashMovements(rows)

        expect(summary.netCashRevenue).toBe(950)
        expect(summary.cashOperatingSurplus).toBe(700)
        expect(summary.netBorrowingMovement).toBe(400)
        expect(summary.netLendingMovement).toBe(-120)
        expect(summary.buckets.otherCompletedMovement.amount).toBe(25)
        expect(summary.netRecordedCashMovement).toBe(1_005)
        expect(summary.netRecordedCashMovement).toBe(
            rows.reduce((total, row) => total + (row.direction === 'incoming' ? row.amount : -row.amount), 0),
        )
    })

    it('nets reversals into their semantic leaf and treats outgoing sales cash as a refund', () => {
        const summary = summarizeLedgerCashMovements([
            entry('pos_sale', 'incoming', 100),
            entry('pos_sale', 'outgoing', 30),
            entry('expense', 'outgoing', 40),
            entry('expense', 'incoming', 10),
            entry('loan_taken', 'incoming', 200),
            entry('loan_taken', 'outgoing', 50),
        ])

        expect(summary.buckets.cashRevenueReceived.amount).toBe(100)
        expect(summary.buckets.cashRefundsPaid.amount).toBe(30)
        expect(summary.buckets.operatingCashPaid.amount).toBe(30)
        expect(summary.buckets.loansReceived.amount).toBe(150)
        expect(summary.netRecordedCashMovement).toBe(190)
    })

    it('counts sales-order financing collections and refunds as operating cash, not lending', () => {
        const summary = summarizeLedgerCashMovements([
            entry('order_loan_collection', 'incoming', 300),
            entry('order_loan_refund', 'outgoing', 80),
        ])

        expect(summary.buckets.cashRevenueReceived.amount).toBe(300)
        expect(summary.buckets.cashRefundsPaid.amount).toBe(80)
        expect(summary.buckets.repaymentsCollected.amount).toBe(0)
        expect(summary.netCashRevenue).toBe(220)
        expect(summary.netRecordedCashMovement).toBe(220)
    })

    it('rounds converted values and ignores non-cash positions and invalid values', () => {
        const rows = [
            entry('pos_sale', 'incoming', 0.1),
            entry('pos_sale', 'incoming', 0.2),
            entry('payment_account_opening_balance', 'opening', 5_000),
            entry('ecommerce_receivable', 'incoming', 900),
            entry('direct_inflow', 'incoming', Number.NaN),
        ]

        const summary = summarizeLedgerCashMovements(rows, (row) => row.amount)

        expect(summary.buckets.cashRevenueReceived.amount).toBe(0.3)
        expect(summary.netRecordedCashMovement).toBe(0.3)
        expect(summary.completedEntryCount).toBe(2)
        expect(summary.excludedEntryCount).toBe(3)
    })

    it('classifies every unknown completed cash type as other instead of dropping it', () => {
        const row = entry('future_completed_cash_source', 'outgoing', 12)
        expect(getLedgerCashBucketId(row)).toBe('otherCompletedMovement')
        expect(summarizeLedgerCashMovements([row]).netRecordedCashMovement).toBe(-12)
    })
})

describe('summarizeLedgerCashMovementsByCurrency', () => {
    it('keeps each currency on its own line without converting or combining amounts', () => {
        const summaries = summarizeLedgerCashMovementsByCurrency([
            { ...entry('pos_sale', 'incoming', 1_000), currency: 'iqd' },
            { ...entry('expense', 'outgoing', 250), currency: 'iqd' },
            { ...entry('pos_sale', 'incoming', 100), currency: 'usd' },
            { ...entry('activity_refund', 'outgoing', 20), currency: 'usd' },
        ])

        expect(summaries).toHaveLength(2)
        expect(summaries[0]).toMatchObject({
            currency: 'iqd',
            summary: { netCashRevenue: 1_000, cashOperatingSurplus: 750, netRecordedCashMovement: 750 },
        })
        expect(summaries[1]).toMatchObject({
            currency: 'usd',
            summary: { netCashRevenue: 80, cashOperatingSurplus: 80, netRecordedCashMovement: 80 },
        })
    })

    it('retains a selected currency as a zero line when it has no movements', () => {
        const summaries = summarizeLedgerCashMovementsByCurrency(
            [{ ...entry('pos_sale', 'incoming', 50), currency: 'usd' }],
            ['usd', 'eur'],
        )

        expect(summaries.map(({ currency }) => currency)).toEqual(['usd', 'eur'])
        expect(summaries[1].summary.netRecordedCashMovement).toBe(0)
        expect(summaries[1].summary.completedEntryCount).toBe(0)
    })
})

describe('Ledger cash dashboard configuration and drill-down', () => {
    it('normalizes group order, removes invalid values, and never hides operating activity', () => {
        expect(
            normalizeLedgerDashboardConfig({
                version: 99,
                hiddenGroups: ['operating', 'borrowing', 'unknown', 'borrowing'],
                groupOrder: ['lending', 'lending'],
            }),
        ).toEqual({
            version: 1,
            hiddenGroups: ['borrowing'],
            groupOrder: ['lending', 'operating', 'borrowing'],
        })
    })

    it('matches result drill-downs to the complete dependency group', () => {
        expect(isLedgerCashDrilldownMatch(entry('activity_refund', 'outgoing', 10), 'netCashRevenue')).toBe(true)
        expect(isLedgerCashDrilldownMatch(entry('expense', 'outgoing', 10), 'netCashRevenue')).toBe(false)
        expect(isLedgerCashDrilldownMatch(entry('loan_given', 'outgoing', 10), 'lending')).toBe(true)
        expect(isLedgerCashDrilldownMatch(entry('payment_account_deposit', 'incoming', 10), 'operating')).toBe(false)
    })
})
