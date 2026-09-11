import { describe, expect, it } from 'vitest'

import { createJumlaKhaleejInquiryPdfData } from './jumlaKhaleejInquiryPdfData'

describe('createJumlaKhaleejInquiryPdfData', () => {
    const baseOrder = {
        websiteStorefrontKey: 'jumla-khaleej',
        orderNumber: 'MKT-12345',
        createdAt: '2026-09-10T10:00:00.000Z',
        customerName: 'Sara',
        customerPhone: '07700000000',
        customerAddress: 'Kirkuk',
        customerCity: 'کەرکووک',
        customerNotes: null,
        deliveryFee: 3000,
        currency: 'iqd'
    }

    it('groups split inventory allocations and retains immutable delivery data', () => {
        const result = createJumlaKhaleejInquiryPdfData({
            ...baseOrder,
            items: [
                { product_id: 'product-a', allocation_group_id: 'product-a', name: 'Serum', unit_price: 2500, currency: 'iqd', quantity: 1, line_total: 2500 },
                { product_id: 'product-a', allocation_group_id: 'product-a', name: 'Serum', unit_price: 2500, currency: 'iqd', quantity: 2, line_total: 5000 }
            ]
        })

        expect(result).toMatchObject({ deliveryFee: 3000, currency: 'iqd' })
        expect(result?.items).toEqual([expect.objectContaining({ name: 'Serum', quantity: 3, lineTotal: 7500 })])
    })

    it('rejects non-Jumla orders and orders without printable product lines', () => {
        expect(createJumlaKhaleejInquiryPdfData({ ...baseOrder, websiteStorefrontKey: 'other', items: [] })).toBeNull()
        expect(createJumlaKhaleejInquiryPdfData({ ...baseOrder, items: [] })).toBeNull()
    })
})
