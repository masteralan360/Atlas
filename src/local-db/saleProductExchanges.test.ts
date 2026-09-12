import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

let processSaleProductExchange: typeof import('./saleProductExchanges').processSaleProductExchange

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000401'
const STORAGE_ID = '00000000-0000-4000-8000-000000000402'
const SALE_ID = '00000000-0000-4000-8000-000000000403'
const RETURNED_PRODUCT_ID = '00000000-0000-4000-8000-000000000404'
const REPLACEMENT_PRODUCT_ID = '00000000-0000-4000-8000-000000000405'
const SALE_ITEM_ID = '00000000-0000-4000-8000-000000000406'

function installBrowserStorage() {
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
            URL: globalThis.URL,
            addEventListener: () => undefined,
        },
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    Object.defineProperty(globalThis, 'Element', {
        configurable: true,
        value: class Element {
            matches() { return false }
        },
    })
    Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, value: class DOMMatrix {} })
    Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class ImageData {} })
    Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: class Path2D {} })
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
        configurable: true,
        value: () => 'blob:atlas-test',
    })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible',
            dir: 'ltr',
            documentElement: { lang: 'en', dir: 'ltr', style: {} },
            head: { appendChild: () => undefined },
            createElement: () => ({ style: {}, appendChild: () => undefined, setAttribute: () => undefined }),
            createTextNode: () => ({}),
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        },
    })
}

async function seedCashSale() {
    const now = '2026-07-27T10:00:00.000Z'
    const base = { workspaceId: WORKSPACE_ID, createdAt: now, updatedAt: now, version: 1, isDeleted: false, syncStatus: 'synced' as const, lastSyncedAt: now }
    await db.storages.put({ id: STORAGE_ID, ...base, name: 'Main Storage', isSystem: false, isProtected: false, isPrimary: true, isMarketplace: false })
    await db.products.bulkPut([
        {
            id: RETURNED_PRODUCT_ID, ...base, sku: 'RETURN-1', name: 'Returned product', description: '', categoryId: null,
            price: 10, costPrice: 4, quantity: 1, minStockLevel: 0, unit: 'pcs', currency: 'usd', canBeReturned: true,
        },
        {
            id: REPLACEMENT_PRODUCT_ID, ...base, sku: 'REPLACE-1', name: 'Replacement product', description: '', categoryId: null,
            price: 15, costPrice: 6, quantity: 3, minStockLevel: 0, unit: 'pcs', currency: 'usd', canBeReturned: true,
        },
    ])
    await db.inventory.bulkPut([
        { id: '00000000-0000-4000-8000-000000000407', ...base, productId: RETURNED_PRODUCT_ID, storageId: STORAGE_ID, quantity: 0 },
        { id: '00000000-0000-4000-8000-000000000408', ...base, productId: REPLACEMENT_PRODUCT_ID, storageId: STORAGE_ID, quantity: 3 },
    ])
    await db.sales.put({
        id: SALE_ID, ...base, cashierId: 'cashier', totalAmount: 10, originalTotalAmount: 10, returnedAmount: 0,
        returnStatus: 'none', settlementCurrency: 'usd', origin: 'pos', payment_method: 'cash',
        systemVerified: true, systemReviewStatus: 'approved', systemReviewReason: null,
    })
    await db.sale_items.put({
        id: SALE_ITEM_ID, workspaceId: WORKSPACE_ID, saleId: SALE_ID, productId: RETURNED_PRODUCT_ID, storageId: STORAGE_ID,
        createdAt: now, updatedAt: now,
        quantity: 1, unitPrice: 10, totalPrice: 10, costPrice: 4, convertedCostPrice: 4,
        originalCurrency: 'usd', originalUnitPrice: 10, convertedUnitPrice: 10, settlementCurrency: 'usd', inventorySnapshot: 1,
        batchAllocations: null, originalBatchAllocations: null, returnedQuantity: 0,
    })
}

describe('sale product exchanges', () => {
    beforeAll(async () => {
        installBrowserStorage()
        processSaleProductExchange = (await import('./saleProductExchanges')).processSaleProductExchange
    }, 30_000)

    beforeEach(async () => {
        installBrowserStorage()
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        await seedCashSale()
    })

    afterEach(() => clearWorkspaceModeSnapshot(WORKSPACE_ID))
    afterAll(async () => { await db.delete() })

    it('posts the return, replacement stock, and only the net cash settlement together', async () => {
        const result = await processSaleProductExchange({
            workspaceId: WORKSPACE_ID, saleId: SALE_ID, returnSaleItemId: SALE_ITEM_ID, returnQuantity: 1,
            replacementProductId: REPLACEMENT_PRODUCT_ID, replacementStorageId: STORAGE_ID, replacementQuantity: 1,
            replacementUnitAmount: 15, settlementMethod: 'cash', createdBy: 'cashier',
        })

        expect(result).toMatchObject({ returnAmount: 10, replacementAmount: 15, differenceAmount: 5, cashSettlementAmount: 5 })
        expect(await db.sale_product_exchanges.get(result.exchangeId)).toMatchObject({
            saleId: SALE_ID, returnId: result.returnId, status: 'posted', differenceAmount: 5,
        })
        expect(await db.sale_returns.get(result.returnId)).toMatchObject({ source: 'exchange', refundAmount: 10 })
        expect(await db.inventory.where('[productId+storageId]').equals([RETURNED_PRODUCT_ID, STORAGE_ID]).first()).toMatchObject({ quantity: 1 })
        expect(await db.inventory.where('[productId+storageId]').equals([REPLACEMENT_PRODUCT_ID, STORAGE_ID]).first()).toMatchObject({ quantity: 2 })
        expect(await db.payment_transactions.where('sourceRecordId').equals(result.exchangeId).first()).toMatchObject({
            sourceType: 'sale_exchange', direction: 'incoming', amount: 5, paymentMethod: 'cash',
        })
    })

    it('rejects a replacement amount that does not match the current product price', async () => {
        await expect(processSaleProductExchange({
            workspaceId: WORKSPACE_ID, saleId: SALE_ID, returnSaleItemId: SALE_ITEM_ID, returnQuantity: 1,
            replacementProductId: REPLACEMENT_PRODUCT_ID, replacementStorageId: STORAGE_ID, replacementQuantity: 1,
            replacementUnitAmount: 1, settlementMethod: 'cash',
        })).rejects.toThrow('Replacement unit amount must match the current product price')
        expect(await db.sale_product_exchanges.count()).toBe(0)
    })
})
