import { describe, expect, it } from 'vitest'

import { createMarketplaceGridRows } from './marketplaceVirtualGridRows'

describe('createMarketplaceGridRows', () => {
    it('keeps every catalog item in responsive grid rows', () => {
        const products = Array.from({ length: 293 }, (_, index) => ({ id: `product-${index}` }))

        const rows = createMarketplaceGridRows(products, (product) => product.id, 2)

        expect(rows).toHaveLength(147)
        expect(rows.flatMap((row) => row.items.map(({ item }) => item.id))).toEqual(products.map((product) => product.id))
        expect(rows.at(-1)?.items).toEqual([{ item: products.at(-1), index: 292 }])
    })

    it('reflows items without dropping their original render indexes', () => {
        const products = ['a', 'b', 'c', 'd', 'e']

        const rows = createMarketplaceGridRows(products, (product) => product, 3)

        expect(rows.map((row) => row.items.map(({ index }) => index))).toEqual([[0, 1, 2], [3, 4]])
    })
})
