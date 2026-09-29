import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from './database'
import type { Product } from './models'
import { DuplicateProductSkuError, normalizeProductSku } from './productSku'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000401'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000402'

let findActiveProductBySku: typeof import('./hooks').findActiveProductBySku
let updateProduct: typeof import('./hooks').updateProduct

function installBrowserGlobals() {
    const rows = new Map<string, string>()
    const storage = {
        get length() { return rows.size },
        getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => rows.set(key, value),
        removeItem: (key: string) => rows.delete(key),
        clear: () => rows.clear(),
        key: (index: number) => Array.from(rows.keys())[index] ?? null
    }

    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: storage,
            sessionStorage: storage,
            location: { origin: 'http://localhost', hash: '', pathname: '/' },
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible',
            dir: 'ltr',
            documentElement: { lang: 'en', dir: 'ltr' },
            head: { appendChild: () => undefined },
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined, style: {} }),
            createTextNode: () => ({}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: false }
    })
    Object.defineProperty(globalThis.URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' })
    Object.defineProperty(globalThis.window, 'URL', { configurable: true, value: globalThis.URL })
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: class Element {} })
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class HTMLElement {} })
    for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) {
        Object.defineProperty(globalThis, name, { configurable: true, value: class {} })
    }
}

function makeProduct(id: string, workspaceId: string, sku: string, isDeleted = false, parentProductId?: string | null): Product {
    const timestamp = '2026-07-13T00:00:00.000Z'
    return {
        id,
        workspaceId,
        sku,
        skuKey: normalizeProductSku(sku),
        parentProductId,
        name: sku,
        description: '',
        price: 0,
        costPrice: 0,
        quantity: 0,
        minStockLevel: 0,
        unit: 'pcs',
        currency: 'usd',
        canBeReturned: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        syncStatus: 'synced',
        lastSyncedAt: timestamp,
        version: 1,
        isDeleted
    }
}

describe('workspace product SKU lookup', () => {
    beforeAll(async () => {
        installBrowserGlobals()
        const hooks = await import('./hooks')
        findActiveProductBySku = hooks.findActiveProductBySku
        updateProduct = hooks.updateProduct
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        writeWorkspaceModeSnapshot({ workspaceId: OTHER_WORKSPACE_ID, dataMode: 'local' })
    })

    afterAll(async () => {
        await db.delete()
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        clearWorkspaceModeSnapshot(OTHER_WORKSPACE_ID)
    })

    it('matches normalized SKUs through the workspace compound index and rejects a duplicate in another product family', async () => {
        const matchingProduct = makeProduct('product-1', WORKSPACE_ID, '  SKU-001  ')
        const editableProduct = makeProduct('product-4', WORKSPACE_ID, 'SKU-002')
        await db.products.bulkPut([
            matchingProduct,
            makeProduct('product-2', OTHER_WORKSPACE_ID, 'sku-001'),
            makeProduct('product-3', WORKSPACE_ID, 'SKU-001', true),
            editableProduct
        ])

        await expect(findActiveProductBySku(WORKSPACE_ID, 'sku-001'))
            .resolves.toMatchObject({ id: matchingProduct.id })
        await expect(findActiveProductBySku(WORKSPACE_ID, 'SKU-001', { excludeId: matchingProduct.id }))
            .resolves.toBeUndefined()
        await expect(updateProduct(editableProduct.id, { sku: 'sku-001' }))
            .rejects.toBeInstanceOf(DuplicateProductSkuError)
    })

    it('allows a variant to share its direct parent SKU but rejects an unrelated parent', async () => {
        const parent = makeProduct('parent', WORKSPACE_ID, 'SKU-FAMILY')
        const variant = makeProduct('variant', WORKSPACE_ID, 'SKU-VARIANT', false, parent.id)
        const unrelatedParent = makeProduct('unrelated-parent', WORKSPACE_ID, 'SKU-UNRELATED')
        await db.products.bulkPut([parent, variant, unrelatedParent])

        await expect(updateProduct(variant.id, { sku: parent.sku }))
            .resolves.toBeUndefined()
        await expect(updateProduct(unrelatedParent.id, { sku: parent.sku }))
            .rejects.toBeInstanceOf(DuplicateProductSkuError)
    })
})
