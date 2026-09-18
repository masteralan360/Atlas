import { describe, expect, it } from 'vitest'

import { getCanonicalProductImagePath } from '../../supabase/functions/_shared/productImagePath'

describe('marketplace product-image snapshots', () => {
    const workspaceId = '6f8cf944-4663-4eb8-bdf0-6dd35e68b6c1'
    const imagePath = `product-images/${workspaceId}/product.webp`

    it('retains only canonical R2 product-image paths for new order snapshots', () => {
        expect(getCanonicalProductImagePath(imagePath)).toBe(imagePath)
        expect(getCanonicalProductImagePath(`/${imagePath}`)).toBe(imagePath)
        expect(getCanonicalProductImagePath(`product-images\\${workspaceId}\\product.webp`)).toBe(imagePath)
    })

    it('rejects rendered URLs and non-R2 image values', () => {
        expect(getCanonicalProductImagePath(`https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/product-images/product.webp`)).toBeNull()
        expect(getCanonicalProductImagePath('https://external.example/product.webp')).toBeNull()
        expect(getCanonicalProductImagePath('data:image/webp;base64,abc')).toBeNull()
        expect(getCanonicalProductImagePath('product-images/../../product.webp')).toBeNull()
    })
})
