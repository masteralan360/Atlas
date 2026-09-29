import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from './database'
import type { Product } from './models'
import { DuplicateProductSkuError, normalizeProductSku } from './productSku'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000501'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000502'

let deleteProduct: typeof import('./hooks').deleteProduct
let createProduct: typeof import('./hooks').createProduct
let linkProductVariant: typeof import('./hooks').linkProductVariant
let ProductVariantRelationshipError: typeof import('./hooks').ProductVariantRelationshipError
let unlinkProductVariant: typeof import('./hooks').unlinkProductVariant

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
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    Object.defineProperty(globalThis.URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' })
    Object.defineProperty(globalThis.window, 'URL', { configurable: true, value: globalThis.URL })
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: class Element {} })
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class HTMLElement {} })
    for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) {
        Object.defineProperty(globalThis, name, { configurable: true, value: class {} })
    }
}

function makeProduct(id: string, workspaceId = WORKSPACE_ID, parentProductId?: string | null): Product {
    const timestamp = '2026-08-09T00:00:00.000Z'
    return {
        id,
        workspaceId,
        sku: `SKU-${id}`,
        skuKey: normalizeProductSku(`SKU-${id}`),
        parentProductId,
        name: `Product ${id}`,
        description: '',
        price: 120,
        costPrice: 85,
        quantity: 7,
        minStockLevel: 2,
        unit: 'pcs',
        currency: 'usd',
        canBeReturned: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        syncStatus: 'synced',
        lastSyncedAt: timestamp,
        version: 1,
        isDeleted: false
    }
}

describe('product variants', () => {
    beforeAll(async () => {
        installBrowserGlobals()
        const hooks = await import('./hooks')
        deleteProduct = hooks.deleteProduct
        createProduct = hooks.createProduct
        linkProductVariant = hooks.linkProductVariant
        ProductVariantRelationshipError = hooks.ProductVariantRelationshipError
        unlinkProductVariant = hooks.unlinkProductVariant
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

    it('links an independent product without changing its inventory or pricing identity', async () => {
        const parent = makeProduct('parent')
        const variant = makeProduct('variant')
        await db.products.bulkPut([parent, variant])

        await linkProductVariant(parent.id, variant.id)

        await expect(db.products.get(variant.id)).resolves.toMatchObject({
            parentProductId: parent.id,
            price: 120,
            costPrice: 85,
            quantity: 7,
            sku: variant.sku
        })
    })

    it('creates a variant with the same SKU as its parent', async () => {
        const parent = makeProduct('parent')
        await db.products.add(parent)

        const variant = await createProduct(WORKSPACE_ID, {
            name: 'Product new variant',
            description: '',
            parentProductId: parent.id,
            sku: parent.sku,
            price: 120,
            costPrice: 85,
            quantity: 0,
            minStockLevel: 2,
            unit: 'pcs',
            currency: 'usd',
            canBeReturned: true
        })

        expect(variant).toMatchObject({
            parentProductId: parent.id,
            sku: parent.sku,
            skuKey: parent.skuKey
        })
    })

    it('rejects self-links, nested parents, and turning a parent into a variant', async () => {
        const parent = makeProduct('parent')
        const existingVariant = makeProduct('existing-variant', WORKSPACE_ID, parent.id)
        const candidateParent = makeProduct('candidate-parent')
        const candidateParentChild = makeProduct('candidate-parent-child', WORKSPACE_ID, candidateParent.id)
        const nestedParent = makeProduct('nested-parent', WORKSPACE_ID, parent.id)
        const otherWorkspaceProduct = makeProduct('other-workspace', OTHER_WORKSPACE_ID)
        await db.products.bulkPut([
            parent,
            existingVariant,
            candidateParent,
            candidateParentChild,
            nestedParent,
            otherWorkspaceProduct
        ])

        await expect(linkProductVariant(parent.id, parent.id)).rejects.toBeInstanceOf(ProductVariantRelationshipError)
        await expect(linkProductVariant(parent.id, candidateParent.id)).rejects.toBeInstanceOf(ProductVariantRelationshipError)
        await expect(linkProductVariant(nestedParent.id, otherWorkspaceProduct.id)).rejects.toBeInstanceOf(ProductVariantRelationshipError)
    })

    it('unlinks variants when requested or when their parent is deleted', async () => {
        const parent = makeProduct('parent')
        const firstVariant = makeProduct('first-variant', WORKSPACE_ID, parent.id)
        const secondVariant = makeProduct('second-variant', WORKSPACE_ID, parent.id)
        await db.products.bulkPut([parent, firstVariant, secondVariant])

        await unlinkProductVariant(firstVariant.id)
        await expect(db.products.get(firstVariant.id)).resolves.toMatchObject({ parentProductId: null, isDeleted: false })

        await deleteProduct(parent.id)
        await expect(db.products.get(secondVariant.id)).resolves.toMatchObject({ parentProductId: null, isDeleted: false })
    })

    it('keeps SKU-sharing variants linked and prevents deleting a parent that would create duplicate independent products', async () => {
        const parent = makeProduct('parent')
        const firstVariant = {
            ...makeProduct('first-variant', WORKSPACE_ID, parent.id),
            sku: parent.sku,
            skuKey: parent.skuKey
        }
        const secondVariant = {
            ...makeProduct('second-variant', WORKSPACE_ID, parent.id),
            sku: parent.sku,
            skuKey: parent.skuKey
        }
        await db.products.bulkPut([parent, firstVariant, secondVariant])

        await expect(unlinkProductVariant(firstVariant.id)).rejects.toBeInstanceOf(DuplicateProductSkuError)
        await expect(deleteProduct(parent.id)).rejects.toBeInstanceOf(ProductVariantRelationshipError)
    })
})
