import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'

import type { PaymentObligation, PaymentTransaction } from './models'

let getRemainingPaymentTransactions: typeof import('./payments').getRemainingPaymentTransactions
let recordObligationSettlement: typeof import('./payments').recordObligationSettlement

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
        ;({ getRemainingPaymentTransactions, recordObligationSettlement } = await import('./payments'))
    }, 30_000)

    afterEach(() => vi.restoreAllMocks())

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

    it('records a sales-agent netted simple-loan amount instead of the gross loan balance', async () => {
        const hooks = await import('./hooks')
        const recordLoanPayment = vi.spyOn(hooks, 'recordLoanPayment').mockResolvedValue({} as any)
        const obligation = {
            id: 'simple-loan:loan-1',
            workspaceId: 'workspace-1',
            sourceModule: 'loans',
            sourceType: 'simple_loan',
            sourceRecordId: 'loan-1',
            sourceSubrecordId: null,
            direction: 'incoming',
            amount: 75,
            currency: 'iqd',
            dueDate: '2026-09-01',
            createdAt: '2026-06-01T00:00:00.000Z',
            counterpartyName: 'Agent partner',
            referenceLabel: 'SO-2026-00001',
            title: 'Agent partner',
            subtitle: 'Order loan balance',
            status: 'open',
            routePath: '/loans',
            metadata: { businessPartnerId: 'partner-1', orderId: 'order-1', orderType: 'sales', displaySourceLabel: 'order_loan' }
        } as PaymentObligation

        await recordObligationSettlement('workspace-1', obligation, { paymentMethod: 'cash' })

        expect(recordLoanPayment).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
            loanId: 'loan-1',
            amount: 75
        }))
    })

    it('rejects a simple-loan collection amount above the displayed net balance', async () => {
        const hooks = await import('./hooks')
        const recordLoanPayment = vi.spyOn(hooks, 'recordLoanPayment').mockResolvedValue({} as any)
        const obligation = {
            id: 'simple-loan:loan-1',
            workspaceId: 'workspace-1',
            sourceModule: 'loans',
            sourceType: 'simple_loan',
            sourceRecordId: 'loan-1',
            direction: 'incoming',
            amount: 75,
            currency: 'iqd',
            dueDate: '2026-09-01',
            referenceLabel: 'SO-2026-00001',
            title: 'Agent partner',
            status: 'open',
            routePath: '/loans'
        } as PaymentObligation

        await expect(recordObligationSettlement('workspace-1', obligation, {
            paymentMethod: 'cash',
            amount: 76
        })).rejects.toThrow('Settlement amount cannot exceed the loan balance')
        expect(recordLoanPayment).not.toHaveBeenCalled()
    })
})
