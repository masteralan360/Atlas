import { describe, expect, it } from 'vitest'
import type { CartItem } from '@/types'
import {
    canAddProductToPosCart,
    canOfferMobileFreeOnlyOrderHold,
    canSetPosPaidQuantity,
    hasPosOrderFreeBonus,
    isFreeOnlyPosQuickOrder,
    restorePosCart,
    shouldRemovePosCartItem,
    snapshotPosCart
} from '@/lib/posCart'
import { getCartInventoryQuantity } from '@/lib/unitRelationships'

const item: CartItem = { product_id: 'p', storageId: 's', sku: 'SKU', name: 'Item', price: 100,
    quantity: 2.25, max_stock: 20, negotiated_price: 90, price_book_id: 'book' }

describe('POS held-cart snapshots and restoration', () => {
    it('blocks related-unit products from an Order cart without restricting other payment methods', () => {
        expect(canAddProductToPosCart('order', true)).toBe(false)
        expect(canAddProductToPosCart('order', false)).toBe(true)
        expect(canAddProductToPosCart('cash', true)).toBe(true)
        expect(canAddProductToPosCart('digital', true)).toBe(true)
        expect(canAddProductToPosCart('loan', true)).toBe(true)
    })

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

    it('counts paid and free quantities together for inventory, including a selling-unit factor', () => {
        expect(getCartInventoryQuantity({ ...item, quantity: 1.25, freeBonusQuantity: 0.75, unit_factor: 4 })).toBe(8)
    })

    it('blocks a paid line from becoming free-only until a Free quantity exists', () => {
        expect(canSetPosPaidQuantity(item, 0)).toBe(false)
        expect(canSetPosPaidQuantity({ ...item, freeBonusQuantity: 1 }, 0)).toBe(true)
    })

    it('removes a line only after both paid and free quantities are zero', () => {
        expect(shouldRemovePosCartItem({ ...item, quantity: 0, freeBonusQuantity: 1 })).toBe(false)
        expect(shouldRemovePosCartItem({ ...item, quantity: 0, freeBonusQuantity: 0 })).toBe(true)
    })

    it('recognizes and locks only a genuine free-only Quick Order', () => {
        const freeOnly = [{ ...item, quantity: 0, freeBonusQuantity: 1 }]
        expect(hasPosOrderFreeBonus(freeOnly)).toBe(true)
        expect(isFreeOnlyPosQuickOrder(freeOnly, 0)).toBe(true)
        expect(isFreeOnlyPosQuickOrder([{ ...item, quantity: 1, freeBonusQuantity: 1 }], 0)).toBe(false)
    })

    it('offers mobile hold-to-add only for a permitted uncatalogued in-stock product', () => {
        expect(canOfferMobileFreeOnlyOrderHold({
            canUseOrderFreeBonus: true, quickOrderEnabled: true, alreadyInCart: false,
            inventoryQuantity: 1, isInfiniteActivity: false
        })).toBe(true)
        expect(canOfferMobileFreeOnlyOrderHold({
            canUseOrderFreeBonus: true, quickOrderEnabled: true, alreadyInCart: true,
            inventoryQuantity: 1, isInfiniteActivity: false
        })).toBe(false)
        expect(canOfferMobileFreeOnlyOrderHold({
            canUseOrderFreeBonus: false, quickOrderEnabled: true, alreadyInCart: false,
            inventoryQuantity: 1, isInfiniteActivity: false
        })).toBe(false)
    })
})
