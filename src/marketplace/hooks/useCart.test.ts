import { describe, expect, it } from 'vitest'

import type { MarketplaceProduct } from '../lib/marketplaceApi'
import { mergeCartWithCatalog, type MarketplaceCartItem } from './useCart'

const cartItem: MarketplaceCartItem = {
    product_id: 'outside-page',
    name: 'Saved product',
    sku: 'OLD-1',
    unit_price: 10,
    original_unit_price: 10,
    currency: 'iqd',
    image_url: null,
    unit: 'pcs',
    quantity: 2,
    discount_type: null,
    discount_value: null,
    discount_ends_at: null
}

const catalogProduct: MarketplaceProduct = {
    id: 'current-page',
    name: 'Updated product',
    sku: 'NEW-1',
    description: '',
    price: 25,
    currency: 'iqd',
    unit: 'box',
    category_id: null,
    category_name: null,
    image_url: 'https://example.com/product.png',
    discount_price: 20,
    discount_type: 'percentage',
    discount_value: 20,
    discount_ends_at: '2026-10-01T00:00:00.000Z',
    marketplace_added_at: null
}

describe('mergeCartWithCatalog', () => {
    it('keeps cart items that are not in the current catalog page', () => {
        expect(mergeCartWithCatalog([cartItem], [])).toEqual([cartItem])
    })

    it('refreshes price and catalog details for products included in the current page', () => {
        const staleItem = { ...cartItem, product_id: catalogProduct.id }

        expect(mergeCartWithCatalog([staleItem], [catalogProduct])).toEqual([
            expect.objectContaining({
                product_id: catalogProduct.id,
                name: 'Updated product',
                sku: 'NEW-1',
                unit_price: 20,
                original_unit_price: 25,
                unit: 'box',
                image_url: 'https://example.com/product.png'
            })
        ])
    })
})
