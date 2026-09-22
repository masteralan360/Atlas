import { describe, expect, it } from 'vitest'

import {
    buildSalesOrderLineId,
    clearSalesItemProductForServicesStorage,
    getPersistedSalesOrderItemStorageId,
    getSalesOrderFormItemStorageId
} from '@/lib/salesOrderLineStorage'

describe('clearSalesItemProductForServicesStorage', () => {
    it('keeps otherwise-identical product lines separately addressable', () => {
        const line = {
            productId: 'product-1',
            storageId: 'storage-1',
            batchId: '',
            unitRef: 'builtin:carton',
            quantity: 2,
            freeBonusQuantity: 0,
            unitPrice: 40_000,
            seq: 1
        }

        expect(buildSalesOrderLineId(line)).not.toBe(buildSalesOrderLineId({ ...line, seq: 2 }))
    })

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
            note: 'Keep this note',
            productId: '',
            productSearch: '',
            unitPrice: '',
            batchId: '',
            priceBookId: '',
            priceBookItemId: '',
            priceSourceCurrency: '',
            priceBookCostPrice: '',
            unitRef: '',
            unitRelationshipId: '',
            unitFactor: '',
            baseUnitRef: '',
            baseUnitCode: '',
            unitNameSnapshot: '',
            baseUnitNameSnapshot: '',
            freeBonusQuantity: '',
            freeBonusUnit: ''
        })
    })

    it('keeps the Services location in the form but never in the saved order line', () => {
        const service = { isService: true }

        expect(getSalesOrderFormItemStorageId(service, null, 'storage-1')).toBe('__atlas_services__')
        expect(getPersistedSalesOrderItemStorageId(service, '__atlas_services__')).toBeNull()
        expect(getPersistedSalesOrderItemStorageId({ isService: false }, 'storage-1')).toBe('storage-1')
    })
})
