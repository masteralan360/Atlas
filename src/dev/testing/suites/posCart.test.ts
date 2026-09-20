import { describe, expect, it } from 'vitest'
import type { CartItem } from '@/types'
import { restorePosCart, snapshotPosCart } from '@/lib/posCart'

const item: CartItem = { product_id: 'p', storageId: 's', sku: 'SKU', name: 'Item', price: 100,
    quantity: 2.25, max_stock: 20, negotiated_price: 90, price_book_id: 'book' }

describe('POS held-cart snapshots and restoration', () => {
    it('holds a separate snapshot with fractional quantity, price book and negotiated price', () => {
        const cart = [{ ...item }]
        const held = snapshotPosCart(cart)
        cart[0].quantity = 4
        cart[0].negotiated_price = 80
        expect(held).toEqual([item])
        expect(held[0]).not.toBe(cart[0])
    })
    it('restores current stock bounds without mutating the held price or quantity', () => {
        const held = [item]
        const restored = restorePosCart(held, 'other', () => ({ inventoryQuantity: 1 }))
        expect(restored[0]).toEqual({ ...item, max_stock: 1 })
        expect(held[0].max_stock).toBe(20)
    })
    it('keeps cross-storage lines and resolves legacy missing storage', () => {
        const restored = restorePosCart([item, { ...item, storageId: undefined }], 'fallback', (_id, storage) => ({ inventoryQuantity: storage === 's' ? 5 : 10 }))
        expect(restored.map(row => [row.storageId, row.max_stock])).toEqual([['s', 5], ['fallback', 10]])
    })
    it('preserves a missing product so checkout can reject it rather than silently dropping the sale line', () => {
        expect(restorePosCart([item], 's', () => undefined)).toEqual([item])
    })
    it('restores parent-unit stock bounds from canonical child inventory', () => {
        const parent = { ...item, unit_factor: 20, max_stock: 1 }
        expect(restorePosCart([parent], 's', () => ({ inventoryQuantity: 123 }))[0].max_stock).toBe(6.15)
    })
    it('an empty held cart remains empty', () => { expect(restorePosCart([], 's', () => undefined)).toEqual([]) })
})
