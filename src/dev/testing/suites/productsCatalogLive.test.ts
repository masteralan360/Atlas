import { describe, expect, it } from 'vitest'
import {
    freshProductsClient, liveProductsWorkspaceId, requireProductsLiveData,
    setupHostedProducts, withLiveProductFixture
} from '../fixtures/productsLive'

const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000b99'

describe('Products · hosted catalog lifecycle', () => {
    setupHostedProducts()

    it('persists edits, scopes reads to the verified workspace, and archives the product', async () => {
        await withLiveProductFixture(async ({ product, tag }) => {
            const hooks = await import('@/local-db/hooks')
            await hooks.updateProduct(product.id, {
                name: `${tag} edited`, description: 'Hosted product update', price: 1750, currency: 'usd'
            })

            const editedClient = await freshProductsClient()
            try {
                const edited = requireProductsLiveData<any>(await editedClient.from('products')
                    .select('id,workspace_id,sku,name,description,price,currency,is_deleted')
                    .eq('id', product.id).single(), 'edited product')
                expect(edited).toMatchObject({
                    id: product.id, workspace_id: liveProductsWorkspaceId, sku: product.sku,
                    name: `${tag} edited`, description: 'Hosted product update', price: 1750,
                    currency: 'usd', is_deleted: false
                })

                const inaccessible = requireProductsLiveData<any[]>(await editedClient.from('products')
                    .select('id').eq('workspace_id', OTHER_WORKSPACE_ID).eq('id', product.id), 'workspace-scoped product read')
                expect(inaccessible).toEqual([])
            } finally { await editedClient.auth.signOut() }

            await hooks.deleteProduct(product.id)
            const archivedClient = await freshProductsClient()
            try {
                const archived = requireProductsLiveData<any>(await archivedClient.from('products')
                    .select('is_deleted').eq('id', product.id).single(), 'archived product')
                expect(archived.is_deleted).toBe(true)
            } finally { await archivedClient.auth.signOut() }
        }, { retireOnSuccess: false, successCleanup: 'product-archived' })
    }, 120_000)

    it('rejects a duplicate SKU without creating a second hosted product row', async () => {
        await withLiveProductFixture(async ({ product }) => {
            const hooks = await import('@/local-db/hooks')
            await expect(hooks.createProduct(liveProductsWorkspaceId, {
                sku: product.sku, name: 'Duplicate SKU candidate', description: '', categoryId: null,
                category: null, storageId: null, price: 10, costPrice: 5, quantity: 0,
                minStockLevel: 0, unit: 'pcs', currency: 'usd', imageUrl: '',
                canBeReturned: true, returnRules: ''
            })).rejects.toMatchObject({ code: 'PRODUCT_SKU_DUPLICATE' })
            const client = await freshProductsClient()
            try {
                const rows = requireProductsLiveData<any[]>(await client.from('products')
                    .select('id').eq('workspace_id', liveProductsWorkspaceId).eq('sku', product.sku), 'duplicate SKU rows')
                expect(rows).toHaveLength(1)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)

    it('archives a category and clears its linked product category fields', async () => {
        await withLiveProductFixture(async ({ product, ids, tag }) => {
            const hooks = await import('@/local-db/hooks')
            const category = await hooks.createCategory(liveProductsWorkspaceId, {
                name: `${tag} category`, description: 'Hosted product category cleanup'
            })
            ids.categoryId = category.id
            recordProductFixture(ids)
            await hooks.updateProduct(product.id, { categoryId: category.id, category: category.name })
            const client = await freshProductsClient()
            try {
                const linked = requireProductsLiveData<any>(await client.from('products')
                    .select('category_id,category').eq('id', product.id).single(), 'linked product category')
                expect(linked).toMatchObject({ category_id: category.id, category: category.name })
            } finally { await client.auth.signOut() }

            await hooks.deleteCategory(category.id)
            const archivedClient = await freshProductsClient()
            try {
                const archivedCategory = requireProductsLiveData<any>(await archivedClient.from('categories')
                    .select('is_deleted').eq('id', category.id).single(), 'archived product category')
                expect(archivedCategory.is_deleted).toBe(true)
                const detachedProduct = requireProductsLiveData<any>(await archivedClient.from('products')
                    .select('category_id,category').eq('id', product.id).single(), 'detached product category')
                expect(detachedProduct).toMatchObject({ category_id: null, category: null })
            } finally { await archivedClient.auth.signOut() }
        })
    }, 120_000)
})
