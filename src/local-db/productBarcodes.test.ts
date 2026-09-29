import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from './database'
import type { Product } from './models'
import { DuplicateProductBarcodeError } from './productBarcodes'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000b11'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000b12'
const timestamp = '2026-09-28T00:00:00.000Z'

let addProductBarcode: typeof import('./hooks').addProductBarcode
let updateProductBarcode: typeof import('./hooks').updateProductBarcode
let deleteProductBarcode: typeof import('./hooks').deleteProductBarcode

function product(id: string, workspaceId: string): Product {
    return {
        id, workspaceId, sku: `SKU-${id}`, skuKey: `sku-${id}`, name: `Product ${id}`,
        description: '', price: 25, costPrice: 10, quantity: 0, minStockLevel: 0,
        unit: 'pcs', currency: 'usd', canBeReturned: true, barcode: '', barcodes: [],
        createdAt: timestamp, updatedAt: timestamp, syncStatus: 'synced',
        lastSyncedAt: timestamp, version: 1, isDeleted: false
    }
}

describe('product barcode records and catalog cache', () => {
    beforeAll(async () => {
        installTestBrowser()
        const hooks = await import('./hooks')
        addProductBarcode = hooks.addProductBarcode
        updateProductBarcode = hooks.updateProductBarcode
        deleteProductBarcode = hooks.deleteProductBarcode
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        writeWorkspaceModeSnapshot({ workspaceId: OTHER_WORKSPACE_ID, dataMode: 'local' })
        await db.products.bulkPut([product('product-a', WORKSPACE_ID), product('product-b', WORKSPACE_ID), product('product-c', OTHER_WORKSPACE_ID)])
    })

    afterAll(async () => {
        await db.delete()
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        clearWorkspaceModeSnapshot(OTHER_WORKSPACE_ID)
    })

    it('normalizes values, selects one primary barcode, and restores the cache after deletion', async () => {
        const primary = await addProductBarcode(WORKSPACE_ID, 'product-a', ' 0123456789 ', ' Main label ')
        const secondary = await addProductBarcode(WORKSPACE_ID, 'product-a', '0987654321', 'Backup')
        expect(primary).toMatchObject({ barcode: '0123456789', label: 'Main label', isPrimary: true })
        expect(secondary.isPrimary).toBe(false)
        expect(await db.products.get('product-a')).toMatchObject({ barcode: '0123456789', barcodes: ['0123456789', '0987654321'] })

        await expect(addProductBarcode(WORKSPACE_ID, 'product-b', '0123456789'))
            .rejects.toBeInstanceOf(DuplicateProductBarcodeError)

        await updateProductBarcode(secondary.id, { isPrimary: true, label: 'Primary backup' })
        expect(await db.product_barcodes.get(primary.id)).toMatchObject({ isPrimary: false })
        expect(await db.product_barcodes.get(secondary.id)).toMatchObject({ isPrimary: true, label: 'Primary backup' })
        expect(await db.products.get('product-a')).toMatchObject({ barcode: '0987654321', barcodes: ['0987654321', '0123456789'] })

        await deleteProductBarcode(secondary.id)
        expect(await db.product_barcodes.get(secondary.id)).toMatchObject({ isDeleted: true, isPrimary: false })
        expect(await db.product_barcodes.get(primary.id)).toMatchObject({ isDeleted: false, isPrimary: true })
        expect(await db.products.get('product-a')).toMatchObject({ barcode: '0123456789', barcodes: ['0123456789'] })
    })

    it('does not match a barcode across workspaces and rejects blank values', async () => {
        await addProductBarcode(WORKSPACE_ID, 'product-a', '5551234')
        await expect(addProductBarcode(OTHER_WORKSPACE_ID, 'product-c', '5551234'))
            .resolves.toMatchObject({ workspaceId: OTHER_WORKSPACE_ID })
        await expect(addProductBarcode(WORKSPACE_ID, 'product-b', '   ')).rejects.toThrow('Barcode is required')
        expect(await db.product_barcodes.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(1)
    })
})
