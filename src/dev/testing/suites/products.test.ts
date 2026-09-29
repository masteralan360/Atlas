import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installTestBrowser } from '../fixtures/browser'
import { db } from '@/local-db/database'
import type { Product } from '@/local-db/models'
import { DuplicateProductSkuError } from '@/local-db/productSku'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000b01'
const USER_ID = '00000000-0000-4000-8000-000000000b02'

let createProduct: typeof import('@/local-db/hooks').createProduct
let updateProduct: typeof import('@/local-db/hooks').updateProduct
let deleteProduct: typeof import('@/local-db/hooks').deleteProduct
let createCategory: typeof import('@/local-db/hooks').createCategory
let deleteCategory: typeof import('@/local-db/hooks').deleteCategory

function getSeed() {
    const value = Number(process.env.ATLAS_TEST_SEED)
    return Number.isInteger(value) && value >= 0 ? value >>> 0 : 20260928
}

function getSampleCount() {
    const value = Number(process.env.ATLAS_TEST_SAMPLES)
    return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 16
}

function createRandom(seed: number) {
    let state = seed || 0x6d2b79f5
    return () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        return (state >>> 0) / 0x1_0000_0000
    }
}

function productInput(sku: string, index: number): Omit<Product,
    'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'> {
    return {
        sku,
        name: `Generated product ${index}`,
        description: `Catalog lifecycle sample ${index}`,
        categoryId: null,
        category: null,
        storageId: null,
        price: 100 + index / 10,
        costPrice: index % 4 === 0 ? 0 : 40 + index / 100,
        quantity: 0,
        minStockLevel: index % 5,
        unit: 'pcs',
        currency: (['usd', 'iqd', 'eur', 'try'] as const)[index % 4],
        imageUrl: '',
        canBeReturned: index % 2 === 0,
        returnRules: index % 2 === 0 ? 'Keep the label attached' : ''
    }
}

describe('Products · catalog lifecycle', () => {
    beforeAll(async () => {
        installTestBrowser()
        const hooks = await import('@/local-db/hooks')
        createProduct = hooks.createProduct
        updateProduct = hooks.updateProduct
        deleteProduct = hooks.deleteProduct
        createCategory = hooks.createCategory
        deleteCategory = hooks.deleteCategory
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        setActiveBusinessWorkspace(WORKSPACE_ID)
        setActiveBusinessUser(USER_ID, 'admin', WORKSPACE_ID)
        setNetworkStatus(false)
    })

    afterAll(async () => {
        await db.delete()
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        setActiveBusinessUser(null)
        setActiveBusinessWorkspace(null)
        setNetworkStatus(true)
    })

    it('creates, edits, and archives reproducible products without losing catalog fields', async () => {
        const seed = getSeed()
        const samples = getSampleCount()
        const nextRandom = createRandom(seed)
        for (let index = 0; index < samples; index += 1) {
            const sku = `DEV-P-${seed.toString(16)}-${index.toString().padStart(3, '0')}`
            const source = productInput(sku, Math.floor(nextRandom() * 100_000))
            const created = await createProduct(WORKSPACE_ID, source)

            expect(created).toMatchObject({
                workspaceId: WORKSPACE_ID,
                sku,
                quantity: 0,
                price: source.price,
                costPrice: source.costPrice,
                currency: source.currency,
                isDeleted: false
            })
            expect(await db.inventory.where('productId').equals(created.id).count()).toBe(0)

            await updateProduct(created.id, {
                name: `${source.name} edited`,
                description: 'Updated description',
                price: source.price + 7.25,
                canBeReturned: !source.canBeReturned,
                quantity: 999
            })
            expect(await db.products.get(created.id)).toMatchObject({
                name: `${source.name} edited`,
                description: 'Updated description',
                price: source.price + 7.25,
                canBeReturned: !source.canBeReturned,
                quantity: 0,
                version: 2
            })

            await deleteProduct(created.id)
            expect(await db.products.get(created.id)).toMatchObject({ isDeleted: true, version: 3 })
        }
    }, 60_000)

    it('rejects an active duplicate SKU without creating a second catalog row', async () => {
        await createProduct(WORKSPACE_ID, productInput('SKU-DUPLICATE', 1))

        await expect(createProduct(WORKSPACE_ID, productInput(' sku-duplicate ', 2)))
            .rejects.toBeInstanceOf(DuplicateProductSkuError)
        await expect(db.products.where('workspaceId').equals(WORKSPACE_ID).count()).resolves.toBe(1)
    })

    it('clears linked product categories when a category is archived', async () => {
        const category = await createCategory(WORKSPACE_ID, { name: 'Test category', description: 'Product grouping' })
        const product = await createProduct(WORKSPACE_ID, {
            ...productInput('SKU-CATEGORY', 1), categoryId: category.id, category: category.name
        })

        await deleteCategory(category.id)

        expect(await db.categories.get(category.id)).toMatchObject({ isDeleted: true })
        expect(await db.products.get(product.id)).toMatchObject({ categoryId: null, category: null })
        await deleteProduct(product.id)
    })
})
