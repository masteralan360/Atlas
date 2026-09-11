import { describe, expect, it } from 'vitest'

import type { PaymentTransaction } from '@/local-db/models'

import {
    buildLedgerFinalSettlementIndex,
    buildLedgerSettlementIndex,
    getPaymentTransactionSourceKey,
    getSignedPaymentTransactionAmount,
} from './ledgerSettlement'

function transaction(
    id: string,
    amount: number,
    direction: PaymentTransaction['direction'] = 'incoming',
    reversalOfTransactionId: string | null = null,
    overrides: Partial<PaymentTransaction> = {},
): PaymentTransaction {
    return {
        id,
        workspaceId: 'workspace-1',
        sourceModule: 'orders',
        sourceType: 'sales_order',
        sourceRecordId: 'order-1',
        direction,
        amount,
        currency: 'iqd',
        paymentMethod: 'cash',
        paidAt: `2026-09-0${id.length}T10:00:00.000Z`,
        reversalOfTransactionId,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
        isDeleted: false,
        syncStatus: 'synced',
        ...overrides,
        lastSyncedAt: overrides.lastSyncedAt ?? null,
        version: overrides.version ?? 1,
    }
}

describe('ledger settlement projection', () => {
    it('uses the selected standalone movement as its all-time final settlement', () => {
        const incoming = transaction('in', 186_000)
        const outgoing = transaction('out', 25_000, 'outgoing', null, { sourceRecordId: 'order-2' })
        const index = buildLedgerSettlementIndex([incoming, outgoing])

        expect(index.byTransactionId.get('in')).toMatchObject({ movementAmount: 186_000, finalSettlement: 186_000, status: 'posted' })
        expect(index.byTransactionId.get('out')).toMatchObject({ movementAmount: -25_000, finalSettlement: -25_000, status: 'posted' })
    })

    it('nets a full reversal to zero while keeping both movements visible', () => {
        const original = transaction('original', 186_000)
        const reversal = transaction('reversal', -186_000, 'incoming', 'original', { paidAt: '2026-10-02T10:00:00.000Z' })
        const index = buildLedgerSettlementIndex([original, reversal])

        expect(index.byTransactionId.get('original')).toMatchObject({
            movementAmount: 186_000,
            finalSettlement: 0,
            reversedAmount: 186_000,
            status: 'fully_reversed',
            linkedTransactionIds: ['original', 'reversal'],
        })
        expect(index.byTransactionId.get('reversal')).toMatchObject({
            movementAmount: -186_000,
            finalSettlement: 0,
            isReversal: true,
            status: 'fully_reversed',
        })
    })

    it('supports cumulative partial reversals and outgoing-payment reversals', () => {
        const incoming = transaction('incoming', 500_000)
        const first = transaction('first', -125_000, 'incoming', 'incoming')
        const second = transaction('second', -75_000, 'incoming', 'incoming')
        const outgoing = transaction('expense', 500_000, 'outgoing', null, { sourceType: 'expense_item', sourceRecordId: 'expense-1' })
        const restored = transaction('restored', -200_000, 'outgoing', 'expense', {
            sourceType: 'expense_item',
            sourceRecordId: 'expense-1',
        })
        const index = buildLedgerSettlementIndex([incoming, first, second, outgoing, restored])

        expect(index.byTransactionId.get('incoming')).toMatchObject({ finalSettlement: 300_000, reversedAmount: 200_000, status: 'partially_reversed' })
        expect(index.byTransactionId.get('expense')).toMatchObject({ movementAmount: -500_000, finalSettlement: -300_000, status: 'partially_reversed' })
        expect(index.byTransactionId.get('restored')).toMatchObject({ movementAmount: 200_000, finalSettlement: -300_000 })
    })

    it('normalizes floating-point zero at the rounding boundary', () => {
        const original = transaction('decimal-original', 0.3, 'incoming', null, { currency: 'usd' })
        const reversalA = transaction('decimal-a', -0.1, 'incoming', 'decimal-original', { currency: 'usd' })
        const reversalB = transaction('decimal-b', -0.2, 'incoming', 'decimal-original', { currency: 'usd' })
        const result = buildLedgerSettlementIndex([original, reversalA, reversalB]).byTransactionId.get('decimal-original')

        expect(result?.finalSettlement).toBe(0)
        expect(result?.status).toBe('fully_reversed')
    })

    it('does not merge a later payment just because it belongs to the same source document', () => {
        const original = transaction('original', 186_000, 'incoming', null, { paidAt: '2026-09-05T19:00:00.000Z' })
        const reversal = transaction('reversal', -186_000, 'incoming', 'original', { paidAt: '2026-09-05T19:03:40.000Z' })
        const newPayment = transaction('new-payment', 186_000, 'incoming', null, { paidAt: '2026-09-05T19:03:44.000Z' })
        const index = buildLedgerSettlementIndex([original, reversal, newPayment])
        const sourceKey = getPaymentTransactionSourceKey(original)

        expect(index.byTransactionId.get('original')?.finalSettlement).toBe(0)
        expect(index.byTransactionId.get('new-payment')?.finalSettlement).toBe(186_000)
        expect(index.byTransactionId.get('new-payment')?.linkedTransactionIds).toEqual(['new-payment'])
        expect(index.sourceTransactionIds.get(sourceKey)).toEqual(['original', 'reversal', 'new-payment'])
    })

    it('reconciles different payment types for the same source document without merging their chains', () => {
        const payment = transaction('payment', 200_000, 'incoming', null, { paidAt: '2026-09-01T10:00:00.000Z' })
        const refund = transaction('refund', 50_000, 'outgoing', null, {
            sourceType: 'order_return',
            paidAt: '2026-09-03T10:00:00.000Z',
        })
        const index = buildLedgerSettlementIndex([payment, refund])
        const sourceKey = getPaymentTransactionSourceKey(payment)

        expect(index.sourceTransactionIds.get(sourceKey)).toEqual(['payment', 'refund'])
        expect(index.byTransactionId.get('payment')?.linkedTransactionIds).toEqual(['payment'])
        expect(index.byTransactionId.get('refund')?.linkedTransactionIds).toEqual(['refund'])
    })

    it('marks missing, mixed-currency, over-reversed, and deleted relationship data safely', () => {
        const orphan = transaction('orphan', -20, 'incoming', 'missing')
        const original = transaction('original', 100)
        const otherCurrency = transaction('other-currency', -10, 'incoming', 'original', { currency: 'usd' })
        const overOriginal = transaction('over-original', 100, 'incoming', null, { sourceRecordId: 'order-2' })
        const overReversal = transaction('over-reversal', -120, 'incoming', 'over-original', { sourceRecordId: 'order-2' })
        const deleted = transaction('deleted', 50, 'incoming', null, { isDeleted: true })
        const index = buildLedgerSettlementIndex([orphan, original, otherCurrency, overOriginal, overReversal, deleted])

        expect(index.byTransactionId.get('orphan')).toMatchObject({ finalSettlement: null, status: 'relationship_missing' })
        expect(index.byTransactionId.get('original')).toMatchObject({ finalSettlement: null, status: 'inconsistent' })
        expect(index.byTransactionId.get('over-original')).toMatchObject({ finalSettlement: -20, status: 'inconsistent' })
        expect(index.byTransactionId.has('deleted')).toBe(false)
    })

    it('calculates signed movement effects without losing large values', () => {
        expect(getSignedPaymentTransactionAmount(transaction('large', 9_999_999_999_999))).toBe(9_999_999_999_999)
        expect(getSignedPaymentTransactionAmount(transaction('large-out', 9_999_999_999_999, 'outgoing'))).toBe(-9_999_999_999_999)
    })
})

describe('ledger final settlement projection', () => {
    it('totals a loan origination and its repayments by immutable relation key despite changing display suffixes', () => {
        const origination = transaction('loan-origin', 1_000_000, 'incoming', null, {
            sourceModule: 'loans',
            sourceType: 'loan_origination',
            sourceRecordId: 'loan-uuid-1',
            referenceLabel: 'LN-2026-001',
        })
        const firstRepayment = transaction('loan-payment-1', 250_000, 'outgoing', null, {
            sourceModule: 'loans',
            sourceType: 'loan_payment',
            sourceRecordId: 'loan-uuid-1',
            referenceLabel: 'LN-2026-001-1',
        })
        const secondRepayment = transaction('loan-payment-2', 250_000, 'outgoing', null, {
            sourceModule: 'loans',
            sourceType: 'loan_payment',
            sourceRecordId: 'loan-uuid-1',
            referenceLabel: 'LN-2026-001-2',
        })
        const settlement = buildLedgerSettlementIndex([origination, firstRepayment, secondRepayment])
        const relationKeys = new Map([
            [origination.id, 'loan:loan-uuid-1'],
            [firstRepayment.id, 'loan:loan-uuid-1'],
            [secondRepayment.id, 'loan:loan-uuid-1'],
        ])
        const final = buildLedgerFinalSettlementIndex(settlement, relationKeys)

        expect(final.byTransactionId.get(origination.id)).toMatchObject({
            relationKey: 'loan:loan-uuid-1',
            totals: [{ currency: 'iqd', amount: 500_000 }],
            isRelationTotal: true,
            linkedRootTransactionIds: ['loan-origin', 'loan-payment-1', 'loan-payment-2'],
        })
        expect(final.byTransactionId.get(secondRepayment.id)?.totals).toEqual([{ currency: 'iqd', amount: 500_000 }])
    })

    it('counts a reversed repayment chain once when totaling its relation', () => {
        const origination = transaction('origin', 1_000_000)
        const repayment = transaction('repayment', 400_000, 'outgoing')
        const repaymentReversal = transaction('repayment-reversal', -100_000, 'outgoing', 'repayment')
        const settlement = buildLedgerSettlementIndex([origination, repayment, repaymentReversal])
        const relationKeys = new Map([
            [origination.id, 'loan:1'],
            [repayment.id, 'loan:1'],
            [repaymentReversal.id, 'loan:1'],
        ])
        const final = buildLedgerFinalSettlementIndex(settlement, relationKeys)

        expect(final.byTransactionId.get(repayment.id)?.totals).toEqual([{ currency: 'iqd', amount: 700_000 }])
        expect(final.byTransactionId.get(repaymentReversal.id)?.totals).toEqual([{ currency: 'iqd', amount: 700_000 }])
    })

    it('keeps relation totals separated by currency and normalizes floating-point zero', () => {
        const iqd = transaction('iqd', 500_000)
        const usdIn = transaction('usd-in', 0.3, 'incoming', null, { currency: 'usd' })
        const usdOut = transaction('usd-out', 0.1 + 0.2, 'outgoing', null, { currency: 'usd' })
        const settlement = buildLedgerSettlementIndex([iqd, usdIn, usdOut])
        const relationKeys = new Map([
            [iqd.id, 'relation:multi-currency'],
            [usdIn.id, 'relation:multi-currency'],
            [usdOut.id, 'relation:multi-currency'],
        ])
        const final = buildLedgerFinalSettlementIndex(settlement, relationKeys)

        expect(final.byTransactionId.get(iqd.id)?.totals).toEqual([
            { currency: 'iqd', amount: 500_000 },
            { currency: 'usd', amount: 0 },
        ])
    })

    it('keeps an unrelated standalone reversal chain scoped to itself', () => {
        const original = transaction('standalone', 100)
        const reversal = transaction('standalone-reversal', -100, 'incoming', 'standalone')
        const settlement = buildLedgerSettlementIndex([original, reversal])
        const final = buildLedgerFinalSettlementIndex(settlement, new Map())

        expect(final.byTransactionId.get(original.id)).toMatchObject({
            relationKey: null,
            totals: [{ currency: 'iqd', amount: 0 }],
            isRelationTotal: false,
            status: 'fully_reversed',
        })
    })

    it('marks the whole relation unavailable when one linked chain is broken', () => {
        const valid = transaction('valid', 100)
        const orphan = transaction('orphan', -20, 'incoming', 'missing')
        const settlement = buildLedgerSettlementIndex([valid, orphan])
        const relationKeys = new Map([
            [valid.id, 'loan:broken'],
            [orphan.id, 'loan:broken'],
        ])
        const final = buildLedgerFinalSettlementIndex(settlement, relationKeys)

        expect(final.byTransactionId.get(valid.id)).toMatchObject({
            totals: [],
            status: 'relationship_missing',
            isRelationTotal: true,
        })
    })
})
