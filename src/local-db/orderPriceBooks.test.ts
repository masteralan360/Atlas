import 'fake-indexeddb/auto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import type { BusinessPartner, PriceBook, PriceBookItem, Product, PurchaseOrder } from './models'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000301'

let createBusinessPartner: typeof import('./businessPartners').createBusinessPartner
let createProduct: typeof import('./hooks').createProduct
let createStorage: typeof import('./hooks').createStorage
let createPurchaseOrder: typeof import('./orders').createPurchaseOrder
let findPartnerProductPriceBookItem: typeof import('./priceBooks').findPartnerProductPriceBookItem

function installBrowserStorage() {
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
            URL: globalThis.URL,
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
            documentElement: { lang: 'en', dir: 'ltr', style: {} },
            head: { appendChild: () => undefined },
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            createElement: () => ({
                type: '',
                style: {},
                appendChild: () => undefined,
                setAttribute: () => undefined
            }),
            createTextNode: () => ({}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    Object.defineProperty(globalThis, 'Element', {
        configurable: true,
        value: class Element {
            matches() { return false }
        }
    })
    Object.defineProperty(globalThis, 'DOMMatrix', {
        configurable: true,
        value: class DOMMatrix {}
    })
    Object.defineProperty(globalThis, 'ImageData', {
        configurable: true,
        value: class ImageData {}
    })
    Object.defineProperty(globalThis, 'Path2D', {
        configurable: true,
        value: class Path2D {}
    })
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
        configurable: true,
        value: () => 'blob:test'
    })
}

async function createPurchaseFixture() {
    const storage = await createStorage(WORKSPACE_ID, { name: 'Price Book Receipt Storage' })
    const product = await createProduct(WORKSPACE_ID, {
        sku: 'PB-RECEIPT-001',
        name: 'Price Book Receipt Product',
        description: '',
        categoryId: null,
        category: null,
        storageId: storage.id,
        storageName: storage.name,
        price: 20_000,
        costPrice: 10_000,
        quantity: 0,
        minStockLevel: 0,
        unit: 'pcs',
        currency: 'iqd',
        barcode: '',
        barcodes: [],
        imageUrl: '',
        canBeReturned: true,
        returnRules: '',
        createdBy: null
    })
    const supplier = await createBusinessPartner(WORKSPACE_ID, {
        partnerName: 'Price Book Supplier',
        phone: '07500000301',
        defaultCurrency: 'usd',
        creditLimit: 0,
        receivableCreditLimit: null,
        payableCreditLimit: null,
        role: 'supplier'
    })

    return { product, storage, supplier }
}

function receivedPurchaseOrderInput(
    fixture: Awaited<ReturnType<typeof createPurchaseFixture>>,
    item: {
        originalCurrency: 'usd' | 'iqd'
        originalUnitPrice: number
        convertedUnitPrice: number
        batchSalePrice: number
        priceBookId?: string | null
        priceBookItemId?: string | null
    },
    exchangeRates: PurchaseOrder['exchangeRates']
): Omit<PurchaseOrder, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'orderNumber'> {
    return {
        businessPartnerId: fixture.supplier.id,
        supplierId: fixture.supplier.id,
        supplierName: fixture.supplier.partnerName,
        destinationStorageId: fixture.storage.id,
        items: [{
            id: crypto.randomUUID(),
            productId: fixture.product.id,
            priceBookId: item.priceBookId ?? null,
            priceBookItemId: item.priceBookItemId ?? null,
            storageId: fixture.storage.id,
            productName: fixture.product.name,
            productSku: fixture.product.sku,
            quantity: 2,
            lineTotal: item.convertedUnitPrice * 2,
            originalCurrency: item.originalCurrency,
            originalUnitPrice: item.originalUnitPrice,
            convertedUnitPrice: item.convertedUnitPrice,
            settlementCurrency: 'usd',
            batchNumber: null,
            batchSalePrice: item.batchSalePrice,
            batchExpiryDate: null,
            batchManufacturingDate: null
        }],
        subtotal: item.convertedUnitPrice * 2,
        discount: 0,
        total: item.convertedUnitPrice * 2,
        currency: 'usd',
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        exchangeRates,
        status: 'received',
        approvalStatus: null,
        approvalRequestedBy: null,
        approvalRequestedAt: null,
        approvalReviewedBy: null,
        approvalReviewedAt: null,
        expectedDeliveryDate: null,
        actualDeliveryDate: null,
        isPaid: true,
        paymentStatus: 'paid',
        paidAmount: item.convertedUnitPrice * 2,
        balanceAmount: 0,
        paidAt: new Date().toISOString(),
        paymentMethod: 'cash',
        initialPaymentAmount: 0,
        linkedLoanId: null,
        isInstallmentBased: false,
        installmentCount: 0,
        installmentFrequency: null,
        firstDueDate: null,
        nextDueDate: null,
        notes: '',
        isLocked: false,
        createdBy: null
    }
}

describe('Price Book order pricing', () => {
    beforeAll(async () => {
        installBrowserStorage()
        const partners = await import('./businessPartners')
        const hooks = await import('./hooks')
        const orders = await import('./orders')
        const priceBooks = await import('./priceBooks')
        createBusinessPartner = partners.createBusinessPartner
        createProduct = hooks.createProduct
        createStorage = hooks.createStorage
        createPurchaseOrder = orders.createPurchaseOrder
        findPartnerProductPriceBookItem = priceBooks.findPartnerProductPriceBookItem
    }, 30_000)

    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    })

    afterEach(() => clearWorkspaceModeSnapshot(WORKSPACE_ID))
    afterAll(async () => db.delete())

    it('returns a zero-valued matching item only while the capability is enabled', () => {
        const partner = { priceBookId: 'book-1' } as Pick<BusinessPartner, 'priceBookId'>
        const product = { id: 'product-1' } as Product
        const priceBook = { id: 'book-1', isDeleted: false } as PriceBook
        const item = {
            id: 'item-1',
            priceBookId: 'book-1',
            productId: 'product-1',
            costPrice: 0,
            price: 0,
            currency: 'usd',
            isDeleted: false
        } as PriceBookItem

        expect(findPartnerProductPriceBookItem(false, partner, product, [priceBook], [item])).toBeUndefined()
        expect(findPartnerProductPriceBookItem(true, partner, product, [priceBook], [item])).toBe(item)
    })

    it('converts a Price Book purchase cost into product currency when receiving stock', async () => {
        const fixture = await createPurchaseFixture()
        const order = await createPurchaseOrder(WORKSPACE_ID, receivedPurchaseOrderInput(
            fixture,
            {
                originalCurrency: 'usd',
                originalUnitPrice: 10,
                convertedUnitPrice: 10,
                batchSalePrice: 30_000,
                priceBookId: 'price-book-1',
                priceBookItemId: 'price-book-item-1'
            },
            [{
                pair: 'USD/IQD',
                rate: 150_000,
                priceBasisAmount: 100,
                source: 'test',
                timestamp: '2026-07-12T00:00:00.000Z'
            }]
        ))

        const batch = await db.stock_batches
            .where('[sourcePurchaseOrderId+sourcePurchaseOrderItemId]')
            .equals([order.id, order.items[0].id])
            .first()
        const receiptTransaction = await db.inventory_transactions
            .where('referenceId')
            .equals(order.id)
            .first()

        expect(order.items[0]).toMatchObject({
            priceBookId: 'price-book-1',
            priceBookItemId: 'price-book-item-1'
        })
        expect(batch).toMatchObject({
            costPrice: 15_000,
            price: 30_000,
            currency: 'iqd',
            quantity: 2
        })
        expect(receiptTransaction).toMatchObject({
            workspaceId: WORKSPACE_ID,
            productId: fixture.product.id,
            storageId: fixture.storage.id,
            transactionType: 'purchase',
            quantityDelta: 2,
            previousQuantity: 0,
            newQuantity: 2,
            referenceId: order.id,
            referenceType: 'purchase_order'
        })
    })

    it('rounds and aggregates duplicate receipt lines into one inventory position and ledger row', async () => {
        const fixture = await createPurchaseFixture()
        const input = receivedPurchaseOrderInput(
            fixture,
            {
                originalCurrency: 'iqd',
                originalUnitPrice: fixture.product.costPrice ?? 0,
                convertedUnitPrice: 10,
                batchSalePrice: fixture.product.price
            },
            null
        )
        input.items = [
            { ...input.items[0], receivedQuantity: 1.1111114 },
            { ...input.items[0], id: crypto.randomUUID(), receivedQuantity: 2.2222224 }
        ]

        const order = await createPurchaseOrder(WORKSPACE_ID, input)
        const inventory = await db.inventory
            .where('[productId+storageId]')
            .equals([fixture.product.id, fixture.storage.id])
            .first()
        const transactions = await db.inventory_transactions
            .where('referenceId')
            .equals(order.id)
            .toArray()

        expect(inventory?.quantity).toBe(3.333333)
        expect(transactions).toHaveLength(1)
        expect(transactions[0]).toMatchObject({
            transactionType: 'purchase',
            quantityDelta: 3.333333,
            previousQuantity: 0,
            newQuantity: 3.333333
        })
    })

    it('rolls back the local order, inventory, and receipt ledger when a line is not receivable', async () => {
        const fixture = await createPurchaseFixture()
        const input = receivedPurchaseOrderInput(
            fixture,
            {
                originalCurrency: 'iqd',
                originalUnitPrice: fixture.product.costPrice ?? 0,
                convertedUnitPrice: 10,
                batchSalePrice: fixture.product.price
            },
            null
        )
        input.items[0] = { ...input.items[0], receivedQuantity: 0 }

        await expect(createPurchaseOrder(WORKSPACE_ID, input)).rejects.toThrow(
            'Received quantity must be greater than zero'
        )

        expect(await db.purchase_orders.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(0)
        expect(await db.inventory.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(0)
        expect(await db.inventory_transactions.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(0)
    })

    it('creates a receipt batch when only the Price Book selling price differs', async () => {
        const fixture = await createPurchaseFixture()
        const order = await createPurchaseOrder(WORKSPACE_ID, receivedPurchaseOrderInput(
            fixture,
            {
                originalCurrency: 'iqd',
                originalUnitPrice: fixture.product.costPrice ?? 0,
                convertedUnitPrice: 10,
                batchSalePrice: 25_000,
                priceBookId: 'price-book-1',
                priceBookItemId: 'price-book-item-1'
            },
            null
        ))

        const batch = await db.stock_batches
            .where('[sourcePurchaseOrderId+sourcePurchaseOrderItemId]')
            .equals([order.id, order.items[0].id])
            .first()

        expect(batch).toMatchObject({
            costPrice: fixture.product.costPrice,
            price: 25_000,
            currency: 'iqd'
        })
    })

    it('does not create a receipt batch for an unmarked legacy selling-price-only difference', async () => {
        const fixture = await createPurchaseFixture()
        const order = await createPurchaseOrder(WORKSPACE_ID, receivedPurchaseOrderInput(
            fixture,
            {
                originalCurrency: 'iqd',
                originalUnitPrice: fixture.product.costPrice ?? 0,
                convertedUnitPrice: 10,
                batchSalePrice: 25_000
            },
            null
        ))

        const batch = await db.stock_batches
            .where('[sourcePurchaseOrderId+sourcePurchaseOrderItemId]')
            .equals([order.id, order.items[0].id])
            .first()
        const inventory = await db.inventory
            .where('[productId+storageId]')
            .equals([fixture.product.id, fixture.storage.id])
            .first()

        expect(batch).toBeUndefined()
        expect(inventory?.workspaceId).toBe(WORKSPACE_ID)
        expect(inventory?.quantity).toBe(2)
    })

    it('preserves legacy unmarked receipt cost semantics even when source currency differs', async () => {
        const fixture = await createPurchaseFixture()
        const order = await createPurchaseOrder(WORKSPACE_ID, receivedPurchaseOrderInput(
            fixture,
            {
                originalCurrency: 'usd',
                originalUnitPrice: fixture.product.costPrice ?? 0,
                convertedUnitPrice: 10,
                batchSalePrice: fixture.product.price
            },
            [{
                pair: 'USD/IQD',
                rate: 150_000,
                priceBasisAmount: 100,
                source: 'test',
                timestamp: '2026-07-12T00:00:00.000Z'
            }]
        ))

        const batch = await db.stock_batches
            .where('[sourcePurchaseOrderId+sourcePurchaseOrderItemId]')
            .equals([order.id, order.items[0].id])
            .first()

        expect(batch).toBeUndefined()
    })

    it('treats partial Price Book provenance as an unmarked legacy line', async () => {
        const fixture = await createPurchaseFixture()
        const order = await createPurchaseOrder(WORKSPACE_ID, receivedPurchaseOrderInput(
            fixture,
            {
                originalCurrency: 'iqd',
                originalUnitPrice: fixture.product.costPrice ?? 0,
                convertedUnitPrice: 10,
                batchSalePrice: 25_000,
                priceBookId: 'price-book-1'
            },
            null
        ))

        const batch = await db.stock_batches
            .where('[sourcePurchaseOrderId+sourcePurchaseOrderItemId]')
            .equals([order.id, order.items[0].id])
            .first()

        expect(batch).toBeUndefined()
    })
})
