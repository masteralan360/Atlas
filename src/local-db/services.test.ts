import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from './database'
import { DuplicateProductSkuError } from './productSku'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000611'

let createProduct: typeof import('./hooks').createProduct
let updateProduct: typeof import('./hooks').updateProduct
let findActiveProductBySku: typeof import('./hooks').findActiveProductBySku

function installBrowserGlobals() {
    const rows = new Map<string, string>()
    const storage = {
        get length() { return rows.size },
        getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => rows.set(key, value),
        removeItem: (key: string) => rows.delete(key),
        clear: () => rows.clear(),
        key: (index: number) => Array.from(rows.keys())[index] ?? null,
    }

    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: storage,
            sessionStorage: storage,
            location: { hash: '', origin: 'http://localhost', pathname: '/' },
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        },
    })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible', dir: 'ltr', documentElement: { lang: 'en', dir: 'ltr' },
            head: { appendChild: () => undefined },
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined, style: {} }),
            createTextNode: () => ({}),
            addEventListener: () => undefined, removeEventListener: () => undefined
        },
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

describe('service catalog items', () => {
    beforeAll(async () => {
        installBrowserGlobals()
        const hooks = await import('./hooks')
        createProduct = hooks.createProduct
        updateProduct = hooks.updateProduct
        findActiveProductBySku = hooks.findActiveProductBySku
    })

    beforeEach(async () => {
        installBrowserGlobals()
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    })

    afterEach(() => clearWorkspaceModeSnapshot(WORKSPACE_ID))
    afterAll(async () => { await db.delete() })

    it('creates a sellable service with an optional SKU but without storage, inventory, or a cost', async () => {
        const service = await createProduct(WORKSPACE_ID, {
            isService: true,
            name: 'Consultation',
            description: '',
            categoryId: null,
            category: null,
            sku: '  SVC-001  ',
            price: 25,
            costPrice: null,
            quantity: 50,
            minStockLevel: 5,
            unit: 'hour',
            currency: 'usd',
            storageId: '00000000-0000-4000-8000-000000000612',
            parentProductId: null,
            canBeReturned: true,
            createdBy: null,
        })

        expect(service).toMatchObject({
            isService: true,
            sku: 'SVC-001',
            skuKey: 'svc-001',
            unit: '',
            quantity: 0,
            minStockLevel: 0,
            storageId: null,
            costPrice: null,
        })
        await expect(findActiveProductBySku(WORKSPACE_ID, ' svc-001 ')).resolves.toMatchObject({ id: service.id })
        await updateProduct(service.id, { price: 30 })
        expect(await db.products.get(service.id)).toMatchObject({ sku: 'SVC-001', skuKey: 'svc-001', price: 30 })
        expect(await db.inventory.where('productId').equals(service.id).count()).toBe(0)
    })

    it('allows a blank SKU and enforces workspace-wide service and product SKU uniqueness', async () => {
        const service = await createProduct(WORKSPACE_ID, {
            isService: true, name: 'Consultation', description: '', categoryId: null, category: null,
            sku: '', price: 25, costPrice: null, quantity: 0, minStockLevel: 0, unit: '', currency: 'usd',
            storageId: null, parentProductId: null, canBeReturned: true, createdBy: null
        })
        expect(service).toMatchObject({ isService: true, sku: '', skuKey: '' })
        await expect(createProduct(WORKSPACE_ID, {
            isService: true, name: 'Translation', description: '', categoryId: null, category: null,
            sku: '', price: 25, costPrice: null, quantity: 0, minStockLevel: 0, unit: '', currency: 'usd',
            storageId: null, parentProductId: null, canBeReturned: true, createdBy: null
        })).resolves.toMatchObject({ isService: true, sku: '' })

        const product = await createProduct(WORKSPACE_ID, {
            name: 'Catalog product', description: '', categoryId: null, category: null,
            sku: 'CAT-001', price: 10, costPrice: 5, quantity: 0, minStockLevel: 0, unit: 'pcs', currency: 'usd',
            storageId: null, parentProductId: null, canBeReturned: true, createdBy: null
        })
        const competingService = await createProduct(WORKSPACE_ID, {
            isService: true, name: 'Repair', description: '', categoryId: null, category: null,
            sku: 'SERVICE-001', price: 25, costPrice: null, quantity: 0, minStockLevel: 0, unit: '', currency: 'usd',
            storageId: null, parentProductId: null, canBeReturned: true, createdBy: null
        })

        await expect(createProduct(WORKSPACE_ID, {
            isService: true, name: 'Duplicate service', description: '', categoryId: null, category: null,
            sku: ' service-001 ', price: 25, costPrice: null, quantity: 0, minStockLevel: 0, unit: '', currency: 'usd',
            storageId: null, parentProductId: null, canBeReturned: true, createdBy: null
        })).rejects.toBeInstanceOf(DuplicateProductSkuError)
        await expect(createProduct(WORKSPACE_ID, {
            isService: true, name: 'Duplicate', description: '', categoryId: null, category: null,
            sku: ' cat-001 ', price: 25, costPrice: null, quantity: 0, minStockLevel: 0, unit: '', currency: 'usd',
            storageId: null, parentProductId: null, canBeReturned: true, createdBy: null
        })).rejects.toBeInstanceOf(DuplicateProductSkuError)
        await expect(updateProduct(competingService.id, { sku: ' cat-001 ' }))
            .rejects.toBeInstanceOf(DuplicateProductSkuError)

        await updateProduct(competingService.id, { sku: ' SERVICE-002 ' })
        expect(await db.products.get(competingService.id)).toMatchObject({ sku: 'SERVICE-002', skuKey: 'service-002' })
        await updateProduct(competingService.id, { sku: '' })
        expect(await db.products.get(competingService.id)).toMatchObject({ sku: '', skuKey: '' })
        expect(await db.products.get(product.id)).toMatchObject({ sku: 'CAT-001' })
        expect(await db.products.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(4)
    })
})
