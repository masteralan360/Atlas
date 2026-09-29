import { describe, expect, it } from 'vitest'
import {
    freshProductsClient, liveProductsWorkspaceId, recordProductFixture, requireProductsLiveData,
    setupHostedProducts, withLiveProductFixture
} from '../fixtures/productsLive'

describe('Products · hosted identifiers and variants', () => {
    setupHostedProducts()

    it('persists barcode revisions and a direct variant relationship', async () => {
        await withLiveProductFixture(async ({ product, ids, tag }) => {
            const hooks = await import('@/local-db/hooks')
            const variant = await hooks.createProduct(liveProductsWorkspaceId, {
                sku: `DTV-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} variant`, description: '',
                categoryId: null, category: null, storageId: null, price: 1250, costPrice: 700,
                quantity: 0, minStockLevel: 0, unit: 'pcs', currency: 'iqd', imageUrl: '',
                canBeReturned: true, returnRules: '', parentProductId: product.id
            })
            ids.variantId = variant.id
            recordProductFixture(ids)

            const barcode = await hooks.addProductBarcode(liveProductsWorkspaceId, product.id,
                `DT${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`, 'Hosted primary')
            ids.barcodeId = barcode.id
            recordProductFixture(ids)
            const revisedValue = `DT${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`
            await hooks.updateProductBarcode(barcode.id, { barcode: revisedValue, label: 'Revised primary' })

            const client = await freshProductsClient()
            try {
                const storedVariant = requireProductsLiveData<any>(await client.from('products')
                    .select('workspace_id,parent_product_id,name').eq('id', variant.id).single(), 'variant product')
                expect(storedVariant).toMatchObject({
                    workspace_id: liveProductsWorkspaceId, parent_product_id: product.id, name: `${tag} variant`
                })
                const storedBarcode = requireProductsLiveData<any>(await client.from('product_barcodes')
                    .select('workspace_id,product_id,barcode,label,is_primary,is_deleted')
                    .eq('id', barcode.id).single(), 'product barcode')
                expect(storedBarcode).toMatchObject({
                    workspace_id: liveProductsWorkspaceId, product_id: product.id,
                    barcode: revisedValue, label: 'Revised primary', is_primary: true, is_deleted: false
                })
            } finally { await client.auth.signOut() }

            await hooks.deleteProductBarcode(barcode.id)
            await hooks.deleteProduct(variant.id)
            const retiredClient = await freshProductsClient()
            try {
                const retiredBarcode = requireProductsLiveData<any>(await retiredClient.from('product_barcodes')
                    .select('is_deleted').eq('id', barcode.id).single(), 'retired barcode')
                expect(retiredBarcode.is_deleted).toBe(true)
            } finally { await retiredClient.auth.signOut() }
        })
    }, 120_000)
})
