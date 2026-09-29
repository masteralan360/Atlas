import { describe, expect, it } from 'vitest'
import {
    freshProductsClient, liveProductsWorkspaceId, recordProductFixture, requireProductsLiveData,
    setupHostedProducts
} from '../fixtures/productsLive'

describe('Products · hosted units and inventory', () => {
    setupHostedProducts()

    it('persists a product unit conversion against its workspace relationship', async () => {
        const relationships = await import('@/local-db/unitRelationships')
        const hooks = await import('@/local-db/hooks')
        const tag = `DEV TEST PRODUCT ${process.env.ATLAS_LIVE_RUN_ID?.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
        const ids: Record<string, string | null> = {
            productId: null, unitRelationshipId: null, parentUnitId: null, childUnitId: null
        }
        let passed = false
        try {
            const parentUnit = await hooks.createUnit(liveProductsWorkspaceId, {
                code: `livebox${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
                icon: 'Box', isDynamic: false
            })
            ids.parentUnitId = parentUnit.id
            recordProductFixture(ids)
            const childUnit = await hooks.createUnit(liveProductsWorkspaceId, {
                code: `livepiece${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
                icon: 'Package', isDynamic: false
            })
            ids.childUnitId = childUnit.id
            recordProductFixture(ids)
            const relationship = await relationships.saveUnitRelationship(liveProductsWorkspaceId, {
                name: `${tag} carton conversion`,
                parentUnitRef: `custom:${parentUnit.id}`, parentUnitCode: parentUnit.code,
                childUnitRef: `custom:${childUnit.id}`, childUnitCode: childUnit.code
            })
            ids.unitRelationshipId = relationship.id
            recordProductFixture(ids)
            const product = await hooks.createProduct(liveProductsWorkspaceId, {
                sku: `DTU-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} unit product`, description: '',
                categoryId: null, category: null, storageId: null, price: 1500, costPrice: 800,
                quantity: 0, minStockLevel: 0, unit: childUnit.code, currency: 'iqd', imageUrl: '',
                canBeReturned: true, returnRules: ''
            })
            ids.productId = product.id
            recordProductFixture(ids)
            const conversion = await relationships.replaceProductUnitConversion(liveProductsWorkspaceId, product.id, {
                relationshipId: relationship.id, factor: 12, parentPrice: 15_000, childIsDynamic: false
            })
            expect(conversion).toMatchObject({
                productId: product.id, relationshipId: relationship.id, factor: 12, parentPrice: 15_000
            })

            const client = await freshProductsClient()
            try {
                const saved = requireProductsLiveData<any>(await client.from('product_unit_conversions')
                    .select('workspace_id,product_id,relationship_id,factor,parent_price,is_deleted')
                    .eq('product_id', product.id).single(), 'product unit conversion')
                expect(saved).toMatchObject({
                    workspace_id: liveProductsWorkspaceId, product_id: product.id,
                    relationship_id: relationship.id, factor: 12, parent_price: 15_000, is_deleted: false
                })
            } finally { await client.auth.signOut() }

            await relationships.replaceProductUnitConversion(liveProductsWorkspaceId, product.id, null)
            await hooks.deleteProduct(product.id)
            await relationships.deleteUnitRelationship(relationship.id)
            await hooks.deleteUnit(parentUnit.id)
            await hooks.deleteUnit(childUnit.id)
            passed = true
        } finally {
            recordProductFixture(ids, passed ? 'product-archived; unit-relationship-removed' : 'retained-for-inspection')
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
