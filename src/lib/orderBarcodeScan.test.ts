import { describe, expect, it } from 'vitest'

import { findProductByOrderBarcode } from './orderBarcodeScan'
import type { Product, ProductBarcode } from '@/local-db/models'

const product = (id: string, overrides: Partial<Product> = {}): Product => ({
    id,
    workspaceId: 'workspace-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    syncStatus: 'synced',
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    isDeleted: false,
    sku: '',
    name: id,
    description: '',
    price: 0,
    costPrice: 0,
    quantity: 0,
    minStockLevel: 0,
    unit: 'pcs',
    currency: 'iqd',
    canBeReturned: true,
    ...overrides
})

const productBarcode = (productId: string, barcode: string): ProductBarcode => ({
    id: `${productId}-${barcode}`,
    workspaceId: 'workspace-1',
    productId,
    barcode,
    isPrimary: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    syncStatus: 'synced',
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    isDeleted: false
})

describe('product barcode lookup', () => {
    it('matches a barcode-table entry before legacy product barcode fields', () => {
        const tableProduct = product('from-table', { barcode: 'legacy-table' })
        const legacyProduct = product('from-legacy', { barcode: 'shared-code' })

        expect(findProductByOrderBarcode(
            [tableProduct, legacyProduct],
            [productBarcode(tableProduct.id, 'shared-code')],
            'shared-code'
        )).toBe(tableProduct)
    })

    it('matches cached barcodes and SKU values after normalizing scanner digits', () => {
        const cachedBarcodeProduct = product('cached', { barcodes: ['12345'] })
        const skuProduct = product('sku', { sku: 'SKU-123' })

        expect(findProductByOrderBarcode([cachedBarcodeProduct, skuProduct], [], '۱۲۳۴۵')).toBe(cachedBarcodeProduct)
        expect(findProductByOrderBarcode([cachedBarcodeProduct, skuProduct], [], 'sku-123')).toBe(skuProduct)
    })

    it('does not select a product for an unknown barcode', () => {
        expect(findProductByOrderBarcode([product('known', { barcode: 'known-code' })], [], 'unknown-code')).toBeUndefined()
    })
})
