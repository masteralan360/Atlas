import { describe, expect, it } from 'vitest'

import { createSalesOrderReturnPrintData } from './orderReturnPrintData'

describe('sales order return print data', () => {
    it('includes only posted return items and their recorded refund amounts', () => {
        const order = {
            id: 'order-1',
            returnStatus: 'partial',
            items: [
                { id: 'line-returned', quantity: 3, lineTotal: 75, convertedUnitPrice: 25 },
                { id: 'line-not-returned', quantity: 2, lineTotal: 40, convertedUnitPrice: 20 }
            ]
        } as any
        const printData = createSalesOrderReturnPrintData(order, [
            { id: 'posted-return', status: 'posted', returnedAt: '2026-08-15T10:00:00.000Z', isDeleted: false },
            { id: 'voided-return', status: 'voided', returnedAt: '2026-08-15T11:00:00.000Z', isDeleted: false }
        ] as any, [
            { returnId: 'posted-return', orderItemId: 'line-returned', quantity: 1, refundAmount: 20, isDeleted: false },
            { returnId: 'voided-return', orderItemId: 'line-not-returned', quantity: 2, refundAmount: 40, isDeleted: false },
            { returnId: 'posted-return', orderItemId: 'missing-line', quantity: 1, refundAmount: 99, isDeleted: false }
        ] as any)

        expect(printData).toEqual({
            status: 'partial',
            returnedAt: '2026-08-15T10:00:00.000Z',
            baseRefundAmount: 20,
            adjustmentAmount: 0,
            totalRefundAmount: 20,
            lines: [{
                orderItemId: 'line-returned',
                returnedQuantity: 1,
                selectedUnitQuantity: 1,
                paidSelectedUnitQuantity: 1,
                refundAmount: 20,
                unitRefundAmount: 20
            }],
            adjustments: []
        })
    })

    it('prints related-unit returns in the selected unit and excludes free units from the unit refund price', () => {
        const order = {
            id: 'order-related',
            returnStatus: 'partial',
            currency: 'iqd',
            items: [{
                id: 'line-related',
                quantity: 2,
                inventoryQuantity: 40,
                unitFactor: 20,
                convertedUnitPrice: 40_000
            }]
        } as any

        const printData = createSalesOrderReturnPrintData(order, [
            { id: 'posted-return', status: 'posted', returnedAt: '2026-09-22T10:00:00.000Z', isDeleted: false }
        ] as any, [{
            returnId: 'posted-return',
            orderItemId: 'line-related',
            inventoryQuantity: 60,
            selectedUnitQuantity: 3,
            paidSelectedUnitQuantity: 2,
            freeSelectedUnitQuantity: 1,
            refundAmount: 80_000,
            isDeleted: false
        }] as any)

        expect(printData?.lines[0]).toMatchObject({
            returnedQuantity: 60,
            selectedUnitQuantity: 3,
            paidSelectedUnitQuantity: 2,
            refundAmount: 80_000,
            unitRefundAmount: 40_000
        })
    })

    it('marks a document fully returned when every inventory line has been returned', () => {
        const order = {
            id: 'order-2',
            returnStatus: 'partial',
            items: [
                { id: 'line-1', quantity: 1, lineTotal: 25, convertedUnitPrice: 25 },
                { id: 'line-2', quantity: 2, lineTotal: 40, convertedUnitPrice: 20 }
            ]
        } as any
        const printData = createSalesOrderReturnPrintData(order, [
            { id: 'posted-return', status: 'posted', returnedAt: '2026-08-15T10:00:00.000Z', isDeleted: false }
        ] as any, [
            { returnId: 'posted-return', orderItemId: 'line-1', quantity: 1, refundAmount: 25, isDeleted: false },
            { returnId: 'posted-return', orderItemId: 'line-2', quantity: 2, refundAmount: 40, isDeleted: false }
        ] as any)

        expect(printData?.status).toBe('full')
        expect(printData?.totalRefundAmount).toBe(65)
    })

    it('includes only immutable corrections linked to posted returns and reconciles the refund total', () => {
        const order = {
            id: 'order-3',
            returnStatus: 'partial',
            currency: 'usd',
            items: [{ id: 'line-1', quantity: 1, lineTotal: 25, convertedUnitPrice: 25 }],
            orderAdjustments: [
                {
                    id: 'extra-refund', type: 'deduction', name: 'Damaged packaging', currency: 'usd', amount: 5,
                    orderCurrency: 'usd', convertedAmount: 5, exchangeRate: 1, exchangeRateSource: 'native',
                    exchangeRateTimestamp: '2026-08-15T10:00:00.000Z', exchangeRates: [], scope: 'post_return', returnId: 'posted-return'
                },
                {
                    id: 'voided-return-adjustment', type: 'addition', name: 'Fee', currency: 'usd', amount: 3,
                    orderCurrency: 'usd', convertedAmount: 3, exchangeRate: 1, exchangeRateSource: 'native',
                    exchangeRateTimestamp: '2026-08-15T10:00:00.000Z', exchangeRates: [], scope: 'post_return', returnId: 'voided-return'
                }
            ]
        } as any

        const printData = createSalesOrderReturnPrintData(order, [
            { id: 'posted-return', status: 'posted', returnedAt: '2026-08-15T10:00:00.000Z', isDeleted: false },
            { id: 'voided-return', status: 'voided', returnedAt: '2026-08-15T11:00:00.000Z', isDeleted: false }
        ] as any, [
            { returnId: 'posted-return', orderItemId: 'line-1', quantity: 1, refundAmount: 25, isDeleted: false }
        ] as any)

        expect(printData).toMatchObject({
            baseRefundAmount: 25,
            adjustmentAmount: 5,
            totalRefundAmount: 30,
            adjustments: [expect.objectContaining({ id: 'extra-refund', returnId: 'posted-return' })]
        })
    })
})
