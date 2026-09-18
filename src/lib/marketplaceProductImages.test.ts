import { describe, expect, it } from 'vitest'

import {
    createMarketplaceProductImageUrls,
    getMarketplaceProductImageUrl
} from './marketplaceProductImages'

describe('marketplace product image lookup', () => {
    it('uses the current product image instead of an order-item snapshot', () => {
        const currentProductImage = 'product-images/6f8cf944-4663-4eb8-bdf0-6dd35e68b6c1/current.webp'
        const orderItemSnapshot = 'https://external.example/old-image.webp'
        const productImageUrls = createMarketplaceProductImageUrls([{
            id: 'product-1',
            imageUrl: currentProductImage
        }])

        expect(orderItemSnapshot).not.toBe(currentProductImage)
        expect(getMarketplaceProductImageUrl('product-1', productImageUrls)).toBe(currentProductImage)
    })

    it('returns no image when the current product is absent or has none', () => {
        const productImageUrls = createMarketplaceProductImageUrls([
            { id: 'without-image', imageUrl: undefined }
        ])

        expect(getMarketplaceProductImageUrl('without-image', productImageUrls)).toBeNull()
        expect(getMarketplaceProductImageUrl('deleted-product', productImageUrls)).toBeNull()
    })
})
