import { describe, expect, it } from 'vitest'

import { clearSalesItemProductForServicesStorage } from '@/lib/salesOrderLineStorage'

describe('clearSalesItemProductForServicesStorage', () => {
    it('clears the selected product and selling-price fields while preserving the rest of the line', () => {
        const line = {
            seq: 3,
            productId: 'product-1',
            productSearch: 'Premium product',
            storageId: '__atlas_services__',
            quantity: '2',
            freeBonusQuantity: '1',
            freeBonusUnit: 'box',
            unitPrice: '125000',
            batchId: 'batch-1',
            priceBookId: 'price-book-1',
            priceBookItemId: 'price-book-item-1',
            priceSourceCurrency: 'USD',
            priceBookCostPrice: '75',
            note: 'Keep this note'
        }
        const cleared = clearSalesItemProductForServicesStorage(line)

        expect(cleared).toMatchObject({
            seq: 3,
            storageId: '__atlas_services__',
            quantity: '2',
            freeBonusQuantity: '1',
            freeBonusUnit: 'box',
            note: 'Keep this note',
            productId: '',
            productSearch: '',
            unitPrice: '',
            batchId: '',
            priceBookId: '',
            priceBookItemId: '',
            priceSourceCurrency: '',
            priceBookCostPrice: ''
        })
    })
})
