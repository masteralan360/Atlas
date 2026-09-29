import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import type { Product } from './models'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000101'
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000102'

let createPriceBook: typeof import('./priceBooks').createPriceBook
let hardDeletePriceBook: typeof import('./priceBooks').hardDeletePriceBook
let replaceProductPriceBookItems: typeof import('./priceBooks').replaceProductPriceBookItems
let updatePriceBook: typeof import('./priceBooks').updatePriceBook
let deleteProduct: typeof import('./hooks').deleteProduct
let createBusinessPartner: typeof import('./businessPartners').createBusinessPartner
let updateBusinessPartner: typeof import('./businessPartners').updateBusinessPartner
let rekeyPriceBookItemReferences: typeof import('./priceBookReferences').rekeyPriceBookItemReferences

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

function makeProduct(): Product {
    const timestamp = '2026-01-01T00:00:00.000Z'
    return {
        id: '00000000-0000-4000-8000-000000000201',
        workspaceId: WORKSPACE_ID,
        sku: 'PRICE-BOOK-TEST',
        name: 'Price Book Test Product',
        description: '',
        price: 12,
        costPrice: 8,
        quantity: 1,
        minStockLevel: 0,
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

describe('Price Book local data', () => {
    beforeAll(async () => {
        installBrowserGlobals()
        const module = await import('./priceBooks')
        const partners = await import('./businessPartners')
        createPriceBook = module.createPriceBook
        hardDeletePriceBook = module.hardDeletePriceBook
        replaceProductPriceBookItems = module.replaceProductPriceBookItems
        updatePriceBook = module.updatePriceBook
        deleteProduct = (await import('./hooks')).deleteProduct
        createBusinessPartner = partners.createBusinessPartner
        updateBusinessPartner = partners.updateBusinessPartner
        rekeyPriceBookItemReferences = (await import('./priceBookReferences')).rekeyPriceBookItemReferences
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        writeWorkspaceModeSnapshot({ workspaceId: OTHER_WORKSPACE_ID, dataMode: 'local' })
        await db.products.put(makeProduct())
    })

    afterEach(() => {
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        clearWorkspaceModeSnapshot(OTHER_WORKSPACE_ID)
    })

    afterAll(async () => {
        await db.delete()
    })

    it('creates and updates uniquely named books within a workspace', async () => {
        const book = await createPriceBook(WORKSPACE_ID, { name: ' Wholesale ' })
        expect(book.name).toBe('Wholesale')

        await expect(createPriceBook(WORKSPACE_ID, { name: 'wholesale' }))
            .rejects.toThrow('already exists')

        await updatePriceBook(book.id, { name: 'VIP' })
        expect(await db.price_books.get(book.id)).toMatchObject({ name: 'VIP' })
    })

    it('reconciles, soft-deletes, and resurrects a unique product mapping with zero values', async () => {
        const book = await createPriceBook(WORKSPACE_ID, { name: 'VIP' })
        const [created] = await replaceProductPriceBookItems(WORKSPACE_ID, makeProduct().id, [{
            priceBookId: book.id,
            costPrice: 0,
            price: 0,
            currency: 'iqd'
        }])

        expect(created).toMatchObject({ costPrice: 0, price: 0, currency: 'iqd', isDeleted: false })

        await replaceProductPriceBookItems(WORKSPACE_ID, makeProduct().id, [])
        expect(await db.price_book_items.get(created.id)).toMatchObject({ isDeleted: true })

        const [resurrected] = await replaceProductPriceBookItems(WORKSPACE_ID, makeProduct().id, [{
            priceBookId: book.id,
            costPrice: 3,
            price: 5,
            currency: 'usd'
        }])
        expect(resurrected.id).toBe(created.id)
        expect(resurrected).toMatchObject({ costPrice: 3, price: 5, isDeleted: false })
    })

    it('preserves a missing Price Book cost as null instead of converting it to zero', async () => {
        const book = await createPriceBook(WORKSPACE_ID, { name: 'Missing Cost Tier' })
        const [item] = await replaceProductPriceBookItems(WORKSPACE_ID, makeProduct().id, [{
            priceBookId: book.id,
            costPrice: null,
            price: 15,
            currency: 'usd'
        }])

        expect(item).toMatchObject({ costPrice: null, price: 15, isDeleted: false })
    })

    it('retires Price Book overrides when its product is deleted', async () => {
        const book = await createPriceBook(WORKSPACE_ID, { name: 'Retired product overrides' })
        const [item] = await replaceProductPriceBookItems(WORKSPACE_ID, makeProduct().id, [{
            priceBookId: book.id,
            costPrice: 8,
            price: 12,
            currency: 'usd'
        }])

        await deleteProduct(makeProduct().id)

        expect(await db.price_book_items.get(item.id)).toMatchObject({ isDeleted: true })
    })

    it('rejects duplicate rows and cross-workspace books', async () => {
        const book = await createPriceBook(WORKSPACE_ID, { name: 'Retail' })
        await expect(replaceProductPriceBookItems(WORKSPACE_ID, makeProduct().id, [
            { priceBookId: book.id, costPrice: 1, price: 2, currency: 'usd' },
            { priceBookId: book.id, costPrice: 2, price: 3, currency: 'usd' }
        ])).rejects.toThrow('only have one item')

        const otherBook = await createPriceBook(OTHER_WORKSPACE_ID, { name: 'Other' })
        await expect(replaceProductPriceBookItems(WORKSPACE_ID, makeProduct().id, [
            { priceBookId: otherBook.id, costPrice: 1, price: 2, currency: 'usd' }
        ])).rejects.toThrow('not available')
    })

    it('round-trips an optional partner assignment and preserves it when omitted from updates', async () => {
        const book = await createPriceBook(WORKSPACE_ID, { name: 'Partner Tier' })
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Tiered Partner',
            phone: '07500000101',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'customer',
            priceBookId: book.id
        })

        expect(partner.priceBookId).toBe(book.id)
        const renamed = await updateBusinessPartner(partner.id, { partnerName: 'Renamed Tiered Partner' })
        expect(renamed.priceBookId).toBe(book.id)

        const cleared = await updateBusinessPartner(partner.id, { priceBookId: null })
        expect(cleared.priceBookId).toBeNull()
    })

    it('hard-deletes the book and its items while clearing assigned partners', async () => {
        const book = await createPriceBook(WORKSPACE_ID, { name: 'Retired Tier' })
        const [item] = await replaceProductPriceBookItems(WORKSPACE_ID, makeProduct().id, [{
            priceBookId: book.id,
            costPrice: 8,
            price: 12,
            currency: 'usd'
        }])
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Retired Tier Partner',
            phone: '07500000103',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'customer',
            priceBookId: book.id
        })

        await hardDeletePriceBook(book.id)

        expect(await db.price_books.get(book.id)).toBeUndefined()
        expect(await db.price_book_items.get(item.id)).toBeUndefined()
        expect((await db.business_partners.get(partner.id))?.priceBookId).toBeNull()
    })

    it('rekeys persisted and queued order provenance when a server item ID wins', async () => {
        const timestamp = '2026-01-01T00:00:00.000Z'
        const previousId = '00000000-0000-4000-8000-000000000401'
        const canonicalId = '00000000-0000-4000-8000-000000000402'
        const order = {
            id: '00000000-0000-4000-8000-000000000403',
            workspaceId: WORKSPACE_ID,
            items: [{ id: 'line-1', priceBookItemId: previousId }],
            createdAt: timestamp,
            updatedAt: timestamp,
            syncStatus: 'pending',
            lastSyncedAt: null,
            version: 1,
            isDeleted: false
        }
        await db.sales_orders.put(order as never)
        await db.offline_mutations.put({
            id: '00000000-0000-4000-8000-000000000404',
            workspaceId: WORKSPACE_ID,
            entityType: 'sales_orders',
            entityId: order.id,
            operation: 'create',
            payload: { ...order, items: [{ id: 'line-1', price_book_item_id: previousId }] },
            createdAt: timestamp,
            status: 'pending'
        })

        await rekeyPriceBookItemReferences(previousId, canonicalId)

        expect((await db.sales_orders.get(order.id))?.items[0].priceBookItemId).toBe(canonicalId)
        const queued = await db.offline_mutations.get('00000000-0000-4000-8000-000000000404')
        expect((queued?.payload.items as Array<Record<string, unknown>>)[0].price_book_item_id).toBe(canonicalId)
    })
})
