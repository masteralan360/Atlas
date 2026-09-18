import { beforeAll, describe, expect, it } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'

import type { PaymentTransaction } from './models'

let getRemainingPaymentTransactions: typeof import('./payments').getRemainingPaymentTransactions

function installBrowserEnvironment() {
    installTestBrowser()
}

function paymentTransaction(overrides: Partial<PaymentTransaction>): PaymentTransaction {
    return {
        id: 'payment-1',
        workspaceId: 'workspace-1',
        sourceModule: 'orders',
        sourceType: 'sales_order',
        sourceRecordId: 'order-1',
        sourceSubrecordId: null,
        direction: 'incoming',
        amount: 50.01,
        currency: 'usd',
        paymentMethod: 'cash',
        paidAt: '2026-08-03T19:44:00.000Z',
        counterpartyName: 'Test',
        referenceLabel: 'SO-2026-00053',
        note: null,
        createdBy: null,
        reversalOfTransactionId: null,
        metadata: null,
        createdAt: '2026-08-03T19:44:00.000Z',
        updatedAt: '2026-08-03T19:44:00.000Z',
        syncStatus: 'synced',
        lastSyncedAt: '2026-08-03T19:44:00.000Z',
        version: 1,
        isDeleted: false,
        ...overrides
    }
}

describe('getRemainingPaymentTransactions', () => {
    beforeAll(async () => {
        installBrowserEnvironment()
        ;({ getRemainingPaymentTransactions } = await import('./payments'))
    }, 30_000)

    it('keeps the remaining settlement after a partial order return', () => {
        const original = paymentTransaction({ id: 'original', amount: 50.01 })
        const reversal = paymentTransaction({
            id: 'return-reversal',
            amount: -16.67,
            paidAt: '2026-08-03T19:46:00.000Z',
            reversalOfTransactionId: original.id,
            metadata: { partialReversal: true }
        })

        const remaining = getRemainingPaymentTransactions([original, reversal])

        expect(remaining).toHaveLength(1)
        expect(remaining[0]).toMatchObject({ id: original.id })
        expect(remaining[0].amount).toBeCloseTo(33.34, 6)
    })
})
