import { describe, expect, it } from 'vitest'
import {
    freshProductsClient, liveProductsWorkspaceId, recordProductFixture, requireProductsLiveData,
    setupHostedProducts
} from '../fixtures/productsLive'

describe('Products · hosted units and inventory', () => {
    setupHostedProducts()

    it('persists independent product UoM price and coefficient rows', async () => {
        const hooks = await import('@/local-db/hooks')
        const { replaceProductUoms } = await import('@/local-db/productUoms')
        const tag = `DEV TEST PRODUCT ${process.env.ATLAS_LIVE_RUN_ID?.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
        const ids: Record<string, string | null> = { productId: null, productUomId: null }
        let passed = false
        try {
            const product = await hooks.createProduct(liveProductsWorkspaceId, {
                sku: `DTU-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} unit product`, description: '',
                categoryId: null, category: null, storageId: null, price: 1500, costPrice: 800,
                quantity: 0, minStockLevel: 0, unit: 'pcs', currency: 'iqd', imageUrl: '',
                canBeReturned: true, returnRules: ''
            })
            ids.productId = product.id
            recordProductFixture(ids)
            const uoms = await replaceProductUoms(liveProductsWorkspaceId, product.id, [
                { unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1, isBase: true,
                    isActive: true, isDefaultSelling: true, sellingPrice: 1500,
                    costPrice: 800, minimumSellingPrice: 1200 },
                { unitRef: 'builtin:box', unitCode: 'box', coefficient: 12, isBase: false,
                    isActive: true, isDefaultSelling: false, sellingPrice: 15_000,
                    costPrice: 9_600, minimumSellingPrice: 13_000, sku: `DTUB-${crypto.randomUUID().slice(0, 8)}` },
            ])
            const box = uoms.find((row) => row.unitCode === 'box')
            if (!box) throw new Error('product_uom_box_missing')
            ids.productUomId = box.id
            recordProductFixture(ids)

            const client = await freshProductsClient()
            try {
                const saved = requireProductsLiveData<any>(await client.from('product_uoms')
                    .select('workspace_id,product_id,unit_ref,coefficient,is_base,selling_price,cost_price,minimum_selling_price,sku,is_active,is_deleted')
                    .eq('id', box.id).single(), 'product UoM')
                expect(saved).toMatchObject({
                    workspace_id: liveProductsWorkspaceId, product_id: product.id, unit_ref: 'builtin:box',
                    coefficient: 12, is_base: false, selling_price: 15_000,
                    cost_price: 9_600, minimum_selling_price: 13_000,
                    sku: expect.stringMatching(/^DTUB-/), is_active: true, is_deleted: false
                })
            } finally { await client.auth.signOut() }

            await hooks.deleteProduct(product.id)
            passed = true
        } finally {
            recordProductFixture(ids, passed ? 'product-archived' : 'retained-for-inspection')
        }
    }, 120_000)

    it('records opening stock and archives the remaining quantity with a separate movement', async () => {
        const hooks = await import('@/local-db/hooks')
        const tag = `DEV TEST PRODUCT ${process.env.ATLAS_LIVE_RUN_ID?.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
        const ids: Record<string, string | null> = { productId: null, storageId: null }
        let passed = false
        try {
            const storage = await hooks.createStorage(liveProductsWorkspaceId, { name: `${tag} storage` })
            ids.storageId = storage.id
            recordProductFixture(ids)
            const product = await hooks.createProduct(liveProductsWorkspaceId, {
                sku: `DTI-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} stock product`, description: '',
                categoryId: null, category: null, storageId: storage.id, storageName: storage.name,
                price: 250, costPrice: 125, quantity: 12.5, minStockLevel: 1,
                unit: 'pcs', currency: 'usd', imageUrl: '', canBeReturned: true, returnRules: ''
            })
            ids.productId = product.id
            recordProductFixture(ids)

            const openingClient = await freshProductsClient()
            try {
                const inventory = requireProductsLiveData<any>(await openingClient.from('inventory')
                    .select('workspace_id,product_id,storage_id,quantity,is_deleted')
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'opening inventory')
                expect(inventory).toMatchObject({
                    workspace_id: liveProductsWorkspaceId, product_id: product.id,
                    storage_id: storage.id, quantity: 12.5, is_deleted: false
                })
                const openingMovements = requireProductsLiveData<any[]>(await openingClient.from('inventory_transactions')
                    .select('quantity_delta,previous_quantity,new_quantity,reference_type')
                    .eq('workspace_id', liveProductsWorkspaceId).eq('product_id', product.id)
                    .eq('reference_type', 'product_initial_stock'), 'opening stock movement')
                expect(openingMovements).toContainEqual(expect.objectContaining({
                    quantity_delta: 12.5, previous_quantity: 0, new_quantity: 12.5,
                    reference_type: 'product_initial_stock'
                }))
            } finally { await openingClient.auth.signOut() }

            await hooks.deleteProduct(product.id)
            const archivedClient = await freshProductsClient()
            try {
                const archivedInventory = requireProductsLiveData<any>(await archivedClient.from('inventory')
                    .select('quantity,is_deleted').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'archived inventory')
                expect(archivedInventory).toMatchObject({ quantity: 0, is_deleted: true })
                const archiveMovements = requireProductsLiveData<any[]>(await archivedClient.from('inventory_transactions')
                    .select('quantity_delta,previous_quantity,new_quantity,reference_type')
                    .eq('workspace_id', liveProductsWorkspaceId).eq('product_id', product.id)
                    .eq('reference_type', 'product_archive'), 'archive inventory movement')
                expect(archiveMovements).toContainEqual(expect.objectContaining({
                    quantity_delta: -12.5, previous_quantity: 12.5, new_quantity: 0,
                    reference_type: 'product_archive'
                }))
            } finally { await archivedClient.auth.signOut() }
            passed = true
        } finally {
            recordProductFixture(ids, passed ? 'product-archived; storage-retained' : 'retained-for-inspection')
        }
    }, 120_000)
})
