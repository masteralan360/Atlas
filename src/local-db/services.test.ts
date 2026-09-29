import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from './database'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000611'

let createProduct: typeof import('./hooks').createProduct

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
        createProduct = (await import('./hooks')).createProduct
    })

    beforeEach(async () => {
        installBrowserGlobals()
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    })

    afterEach(() => clearWorkspaceModeSnapshot(WORKSPACE_ID))
    afterAll(async () => { await db.delete() })

    it('creates a sellable service without SKU, storage, inventory, or a cost', async () => {
        const service = await createProduct(WORKSPACE_ID, {
            isService: true,
            name: 'Consultation',
            description: '',
            categoryId: null,
            category: null,
            sku: 'IGNORED',
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
            sku: '',
            unit: '',
            quantity: 0,
            minStockLevel: 0,
            storageId: null,
            costPrice: null,
        })
        expect(await db.inventory.where('productId').equals(service.id).count()).toBe(0)
    })
})
