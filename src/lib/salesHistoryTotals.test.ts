import { describe, expect, it } from 'vitest'
import type { Sale } from '@/types'
import { getSalesHistoryRowTotal } from './salesHistoryTotals'

function sale(overrides: Partial<Sale> = {}): Sale {
    return {
        id: 'sale-1',
        workspace_id: 'workspace-1',
        cashier_id: 'cashier-1',
        total_amount: 0,
        settlement_currency: 'usd',
        created_at: '2026-09-11T00:00:00.000Z',
        origin: 'sales_order',
        ...overrides
    }
}

describe('getSalesHistoryRowTotal', () => {
    it('uses the persisted sales-order total after an order discount and tax', () => {
        const total = getSalesHistoryRowTotal(sale({
            total_amount: 95,
            items: [{
                id: 'line-1',
                sale_id: 'sale-1',
                product_id: 'product-1',
                quantity: 1,
                unit_price: 100,
                total_price: 100,
                original_currency: 'usd',
                original_unit_price: 100,
                converted_unit_price: 100,
                settlement_currency: 'usd'
            }]
        }))

        expect(total).toBe(95)
    })

    it('keeps a partially returned order at its persisted remaining total', () => {
        const total = getSalesHistoryRowTotal(sale({
            total_amount: 72,
            items: [{
                id: 'line-1',
                sale_id: 'sale-1',
                product_id: 'product-1',
                quantity: 2,
                returned_quantity: 1,
                unit_price: 100,
                total_price: 200,
                original_currency: 'usd',
                original_unit_price: 100,
                converted_unit_price: 100,
                settlement_currency: 'usd'
            }]
        }))

        expect(total).toBe(72)
    })

    it('preserves the persisted rounded order total', () => {
        const total = getSalesHistoryRowTotal(sale({
            total_amount: 89.99,
            items: [{
                id: 'line-1',
                sale_id: 'sale-1',
                product_id: 'product-1',
                quantity: 1,
                unit_price: 100,
                total_price: 100,
                original_currency: 'usd',
                original_unit_price: 100,
                converted_unit_price: 100,
                settlement_currency: 'usd'
            }]
        }))

        expect(total).toBe(89.99)
    })

    it('shows a fully returned sales order as zero', () => {
        expect(getSalesHistoryRowTotal(sale({
            total_amount: 95,
            is_returned: true
        }))).toBe(0)
    })

    it('continues to calculate a standard sale from its remaining lines', () => {
        const total = getSalesHistoryRowTotal(sale({
            origin: 'pos',
            total_amount: 200,
            items: [{
                id: 'line-1',
                sale_id: 'sale-1',
                product_id: 'product-1',
                quantity: 2,
                returned_quantity: 1,
                unit_price: 100,
                total_price: 200,
                original_currency: 'usd',
                original_unit_price: 100,
                converted_unit_price: 100,
                settlement_currency: 'usd'
            }]
        }))

        expect(total).toBe(100)
    })
})
