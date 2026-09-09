import { describe, expect, it } from 'vitest'

import type { PaymentTransaction } from '@/local-db/models'

import { summarizeLedgerCashMovementsByCurrency } from './ledgerCashSummary'
import { getLedgerCashMovementEntries, getLedgerCashMovementFromPayment } from './ledgerCashMovementEntries'

function payment(overrides: Partial<PaymentTransaction>): PaymentTransaction {
    return {
        id: 'payment-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-09-01T08:00:00.000Z',
        updatedAt: '2026-09-01T08:00:00.000Z',
        syncStatus: 'synced',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false,
        sourceModule: 'payments',
        sourceType: 'direct_transaction',
        sourceRecordId: 'record-1',
        direction: 'incoming',
        amount: 0,
        currency: 'usd',
        paymentMethod: 'cash',
        paidAt: '2026-09-01T08:00:00.000Z',
        ...overrides,
    }
}

describe('getLedgerCashMovementEntries', () => {
    it('reconciles the dashboard amount to the same net recorded cash movement as Ledger', () => {
        const entries = getLedgerCashMovementEntries({
            sales: [
                {
                    createdAt: '2026-09-01T08:00:00.000Z',
                    isDeleted: false,
                    isReturned: false,
                    origin: 'pos',
                    payment_method: 'cash',
                    settlementCurrency: 'usd',
                    totalAmount: 100,
                },
                {
                    createdAt: '2026-09-01T09:00:00.000Z',
                    isDeleted: false,
                    isReturned: false,
                    origin: 'pos',
                    payment_method: 'loan',
                    settlementCurrency: 'usd',
                    totalAmount: 999,
                },
            ],
            paymentTransactions: [
                payment({ id: 'sales-order-payment', sourceType: 'sales_order', amount: 40 }),
                payment({ id: 'expense-payment', sourceType: 'expense_item', direction: 'outgoing', amount: 25 }),
                payment({ id: 'loan-taken', sourceType: 'loan_origination', amount: 50 }),
                payment({ id: 'loan-repayment', sourceType: 'loan_payment', direction: 'outgoing', amount: 10 }),
                payment({ id: 'direct-outflow', direction: 'outgoing', amount: 3 }),
                payment({ id: 'opening-balance', sourceType: 'payment_account_opening_balance', amount: 1_000 }),
            ],
            exchangeTransactions: [
                {
                    createdAt: '2026-09-01T10:00:00.000Z',
                    transactionType: 'sell',
                    profitAmount: 5,
                    profitCurrency: 'usd',
                },
            ],
        })

        const [summary] = summarizeLedgerCashMovementsByCurrency(entries)

        expect(entries).not.toContainEqual(expect.objectContaining({ amount: 999 }))
        expect(summary.currency).toBe('usd')
        expect(summary.summary).toMatchObject({
            netCashRevenue: 140,
            cashOperatingSurplus: 115,
            netBorrowingMovement: 40,
            netRecordedCashMovement: 157,
        })
    })

    it('keeps payment reversals as the counter-movement recorded by Ledger', () => {
        const reversal = getLedgerCashMovementFromPayment(
            payment({
                sourceType: 'real_estate_commission',
                direction: 'outgoing',
                amount: 42,
                reversalOfTransactionId: 'original-commission-payment',
            }),
        )

        expect(reversal).toMatchObject({
            type: 'real_estate_commission',
            direction: 'outgoing',
            amount: 42,
        })
    })
})
