import { describe, expect, it } from 'vitest'
import type { CartItem } from '@/types'
import { applyPosBulkDiscount, getCartBasePrice, getCartEffectivePrice } from '@/lib/posCart'

const line: CartItem = { product_id: 'p', name: 'Item', sku: 'SKU', price: 100, quantity: 2.25, max_stock: 20 }
describe('POS production pricing', () => {
    it('uses negotiated → automatic discount → catalog price precedence, including zero', () => {
        expect(getCartEffectivePrice(line)).toBe(100)
        expect(getCartBasePrice({ ...line, discounted_price: 80 })).toBe(80)
        expect(getCartEffectivePrice({ ...line, discounted_price: 80, negotiated_price: 70 })).toBe(70)
        expect(getCartEffectivePrice({ ...line, negotiated_price: 0 })).toBe(0)
        expect(getCartBasePrice({ ...line, discounted_price: 0 })).toBe(0)
    })
    it('applies bulk percentages to the discounted base and retains the list-price snapshot', () => {
        const [result] = applyPosBulkDiscount([{ ...line, discounted_price: 80 }], '12.5', 'percent', 180)
        expect(result.negotiated_price).toBe(70)
        expect(result.price).toBe(100)
        expect(getCartEffectivePrice(result) * result.quantity).toBe(157.5)
    })
    it('allocates a fixed discount proportionally across unlike prices and fractional quantities', () => {
        const items = [line, { ...line, price: 50, quantity: 1.5 }]
        const results = applyPosBulkDiscount(items, '30', 'amount', 300)
        expect(results.map(row => row.negotiated_price)).toEqual([90, 45])
        expect(results.reduce((sum, row) => sum + getCartEffectivePrice(row) * row.quantity, 0)).toBe(270)
    })
    for (const value of ['100', '101', '1000']) it(`caps ${value}% at a zero price`, () => {
        expect(applyPosBulkDiscount([line], value, 'percent', 225)[0].negotiated_price).toBe(0)
    })
    for (const value of ['', '0', '-1', 'invalid', 'Infinity']) it(`reset/invalid discount '${value}' returns to the base price`, () => {
        const result = applyPosBulkDiscount([{ ...line, negotiated_price: 70, discounted_price: 80 }], value, 'percent', 180)[0]
        expect(result.negotiated_price).toBeUndefined()
        expect(getCartEffectivePrice(result)).toBe(80)
    })
    it('avoids dividing by a zero subtotal and keeps unchanged line identities', () => {
        expect(applyPosBulkDiscount([line], '10', 'amount', 0)[0].negotiated_price).toBe(100)
        const negotiated = { ...line, negotiated_price: 90 }
        expect(applyPosBulkDiscount([negotiated], '10', 'percent', 225)[0]).toBe(negotiated)
    })
})
