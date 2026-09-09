import { describe, expect, it } from 'vitest'

import { classifySalesOrderLoanCash } from './ledgerOrderLoan'

const salesOrderLoan = {
    source: 'order' as const,
    orderId: 'sales-order-1',
    orderType: 'sales' as const,
}

describe('classifySalesOrderLoanCash', () => {
    it('classifies money received for a financed sales order as an order-loan collection', () => {
        expect(
            classifySalesOrderLoanCash(
                {
                    sourceType: 'loan_installment',
                    sourceRecordId: 'loan-1',
                    direction: 'incoming',
                    amount: 125.5,
                    metadata: null,
                },
                salesOrderLoan,
            ),
        ).toEqual({
            type: 'order_loan_collection',
            direction: 'incoming',
            amount: 125.5,
            orderId: 'sales-order-1',
        })
    })

    it('classifies a signed collection reversal as an order-loan cash refund', () => {
        expect(
            classifySalesOrderLoanCash(
                {
                    sourceType: 'simple_loan',
                    sourceRecordId: 'loan-1',
                    direction: 'incoming',
                    amount: -40,
                    metadata: null,
                },
                salesOrderLoan,
            ),
        ).toEqual({
            type: 'order_loan_refund',
            direction: 'outgoing',
            amount: 40,
            orderId: 'sales-order-1',
        })
    })

    it('supports historical payment rows through their order metadata', () => {
        expect(
            classifySalesOrderLoanCash({
                sourceType: 'loan_payment',
                sourceRecordId: 'missing-loan',
                direction: 'incoming',
                amount: 75,
                metadata: { orderId: 'sales-order-2', orderType: 'sales' },
            }),
        ).toMatchObject({ type: 'order_loan_collection', orderId: 'sales-order-2' })
    })

    it('keeps purchase-order financing and independent loans in lending or borrowing', () => {
        const payment = {
            sourceType: 'loan_payment' as const,
            sourceRecordId: 'loan-2',
            direction: 'outgoing' as const,
            amount: 50,
            metadata: { orderId: 'purchase-order-1', orderType: 'purchase' },
        }

        expect(
            classifySalesOrderLoanCash(payment, {
                source: 'order',
                orderId: 'purchase-order-1',
                orderType: 'purchase',
            }),
        ).toBeNull()
        expect(classifySalesOrderLoanCash(payment, { source: 'manual', orderId: null, orderType: null })).toBeNull()
    })

    it('normalizes legacy order-return fallback refunds to a positive outgoing cash movement', () => {
        expect(
            classifySalesOrderLoanCash({
                sourceType: 'order_return',
                sourceRecordId: 'return-1',
                direction: 'outgoing',
                amount: -25,
                metadata: { orderId: 'sales-order-1', loanRepaymentRefund: true },
            }),
        ).toEqual({
            type: 'order_loan_refund',
            direction: 'outgoing',
            amount: 25,
            orderId: 'sales-order-1',
        })
    })
})
