import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { assertNoPosCommit, assertPosPayment } from '../assertions/pos'
import { POS_BATCH, POS_CURRENCIES, POS_INVENTORY, POS_METHODS, POS_PRODUCT, POS_STORAGE, POS_WORKSPACE,
    posCheckoutInput, seededPosCases, seedPosStock } from '../fixtures/pos'
import { createPosServiceNameMetadata } from '@/lib/posServiceName'

vi.mock('@/auth/supabase', () => {
    const unexpected = () => { throw new Error('Unexpected remote call in isolated Local POS scenario') }
    return { supabase: { from: unexpected, rpc: unexpected, schema: () => ({ from: unexpected }) } }
})

let checkout: typeof import('@/local-db/posCheckout')
let accounts: typeof import('@/local-db/paymentAccounts')

describe('POS checkout scenarios (independent of Instant POS)', () => {
    beforeAll(async () => {
        installTestBrowser()
        checkout = await import('@/local-db/posCheckout')
        accounts = await import('@/local-db/paymentAccounts')
    }, 90_000)
    beforeEach(async () => {
        await db.delete(); await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: 'local' })
    })
    afterEach(() => { vi.restoreAllMocks(); clearWorkspaceModeSnapshot(POS_WORKSPACE) })
    afterAll(async () => { await db.delete() })

    for (const method of POS_METHODS) for (const currency of POS_CURRENCIES) for (const selectedAccount of [false, true]) {
        it(`${method} / ${currency} / ${selectedAccount ? 'selected account' : 'no account'} saves sale, stock, payment, account and ledger exactly once`, async () => {
            await seedPosStock(currency)
            const input = posCheckoutInput({ currency, method, quantity: 2.25 })
            if (selectedAccount) input.account = await accounts.savePaymentAccount(POS_WORKSPACE, {
                name: 'POS test account', accountType: 'cash_drawer', openingBalances: []
            })
            const result = await checkout.commitPosCheckout(input)
            expect(result).toEqual({ sequenceId: 1, loanId: null })
            await db.close(); await db.open()
            expect(await db.sales.get(input.payload.id)).toMatchObject({ totalAmount: 225, origin: 'pos', settlementCurrency: currency })
            expect(await db.sale_items.where('saleId').equals(input.payload.id).first()).toMatchObject({
                quantity: 2.25, inventorySnapshot: 20, originalUnitPrice: 100, convertedUnitPrice: 100,
                originalBatchAllocations: [{ batchId: POS_BATCH, quantity: 2.25, batchNumber: 'POS-1', price: 100, costPrice: 40, currency, expiryDate: null, manufacturingDate: null }]
            })
            expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 17.75 })
            expect(await db.products.get(POS_PRODUCT)).toMatchObject({ quantity: 17.75 })
            expect(await db.stock_batches.get(POS_BATCH)).toMatchObject({ quantity: 17.75 })
            const [payment] = await assertPosPayment(input.payload.id, 225)
            expect(payment.paymentMethod).toBe(method)
            const movements = await db.payment_account_movements.toArray()
            expect(movements).toHaveLength(selectedAccount ? 1 : 0)
            if (selectedAccount) {
                expect(movements[0]).toMatchObject({ accountId: input.account!.id, paymentTransactionId: payment.id })
                expect(await db.payment_account_balances.where('accountId').equals(input.account!.id).first()).toMatchObject({ balanceAmount: 225, currency })
            }
            await checkout.commitPosCheckout(input)
            expect(await db.sales.count()).toBe(1)
            await assertPosPayment(input.payload.id, 225)
            expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 17.75 })
            expect(await db.offline_mutations.count()).toBe(0)
        })
    }

    for (const method of POS_METHODS) it(`${method}: service checkout records payment without stock`, async () => {
        await seedPosStock('usd', true)
        const input = posCheckoutInput({ service: true, method })
        input.payload.items[0].product_name = 'POS scenario item - NewService'
        input.payload.items[0].metadata = createPosServiceNameMetadata('POS scenario item', 'NewService') ?? null
        await checkout.commitPosCheckout(input)
        expect(await db.sale_items.where('saleId').equals(input.payload.id).first()).toMatchObject({
            storageId: null,
            inventorySnapshot: null,
            metadata: { posServiceName: { baseNameSnapshot: 'POS scenario item', suffix: 'NewService' } }
        })
        expect(await db.inventory.count()).toBe(0)
        expect(await db.stock_batches.count()).toBe(0)
        await assertPosPayment(input.payload.id, 100)
    })

    it('deducts a mixed-storage cart from each line source and records both inventory movements', async () => {
        await seedPosStock('usd')
        const secondStorageId = 'a7200000-0000-4000-8000-000000000013'
        const secondInventoryId = 'a7200000-0000-4000-8000-000000000014'
        const secondBatchId = 'a7200000-0000-4000-8000-000000000015'
        const timestamp = new Date().toISOString()
        const base = { workspaceId: POS_WORKSPACE, createdAt: timestamp, updatedAt: timestamp,
            version: 1, isDeleted: false, syncStatus: 'synced' as const, lastSyncedAt: timestamp }
        await db.storages.put({ id: secondStorageId, ...base, name: 'POS second storage',
            isSystem: false, isProtected: false, isPrimary: false, isMarketplace: false })
        await db.inventory.put({ id: secondInventoryId, ...base, productId: POS_PRODUCT, storageId: secondStorageId, quantity: 5 })
        await db.stock_batches.put({ id: secondBatchId, ...base, productId: POS_PRODUCT, storageId: secondStorageId,
            batchNumber: 'POS-2', quantity: 5, price: 100, costPrice: 40, currency: 'usd',
            expiryDate: null, manufacturingDate: null, notes: null, sourcePurchaseOrderId: null, sourcePurchaseOrderItemId: null })
        const serviceProductId = 'a7200000-0000-4000-8000-000000000016'
        await db.products.put({ id: serviceProductId, ...base, sku: '', name: 'POS mixed service',
            description: '', categoryId: null, price: 50, costPrice: 0, quantity: 0,
            minStockLevel: 0, unit: 'service', currency: 'usd', canBeReturned: true, isService: true } as never)
        await db.products.update(POS_PRODUCT, { quantity: 25 })

        const input = posCheckoutInput({ quantity: 1 })
        const firstLine = input.payload.items[0]
        const secondLine = {
            ...firstLine,
            storage_id: secondStorageId,
            quantity: 2,
            inventory_quantity: 2,
            total_price: 200,
            total: 200,
            inventory_snapshot: 5,
            batch_allocations: [{
                batch_id: secondBatchId, batch_number: 'POS-2', quantity: 2,
                price: 100, cost_price: 40, currency: 'usd' as const, expiry_date: null, manufacturing_date: null
            }]
        }
        const serviceLine = {
            ...firstLine,
            product_id: serviceProductId,
            storage_id: null,
            product_name: 'POS mixed service',
            product_sku: '',
            unit_price: 50,
            total_price: 50,
            cost_price: 0,
            converted_cost_price: 0,
            original_unit_price: 50,
            converted_unit_price: 50,
            total: 50,
            inventory_snapshot: null,
            batch_allocations: null
        }
        input.payload.items = [firstLine, secondLine, serviceLine]
        input.payload.total_amount = 350
        input.batchPlans = [
            { productId: POS_PRODUCT, storageId: POS_STORAGE, allocations: [{ batchId: POS_BATCH, batchNumber: 'POS-1', quantity: 1, price: 100, costPrice: 40, currency: 'usd' }] },
            { productId: POS_PRODUCT, storageId: secondStorageId, allocations: [{ batchId: secondBatchId, batchNumber: 'POS-2', quantity: 2, price: 100, costPrice: 40, currency: 'usd' }] }
        ]

        await checkout.commitPosCheckout(input)

        const saleItems = await db.sale_items.where('saleId').equals(input.payload.id).toArray()
        expect(saleItems.filter((saleItem) => saleItem.productId === POS_PRODUCT)
            .map((saleItem) => [saleItem.storageId, saleItem.quantity])
            .sort(([leftStorage], [rightStorage]) => String(leftStorage).localeCompare(String(rightStorage)))).toEqual([
            [POS_STORAGE, 1], [secondStorageId, 2]
        ])
        expect(saleItems.find((saleItem) => saleItem.productId === serviceProductId)).toMatchObject({
            storageId: null, inventorySnapshot: null, unitPrice: 50
        })
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
        expect(await db.inventory.get(secondInventoryId)).toMatchObject({ quantity: 3 })
        expect(await db.stock_batches.get(POS_BATCH)).toMatchObject({ quantity: 19 })
        expect(await db.stock_batches.get(secondBatchId)).toMatchObject({ quantity: 3 })
        expect(await db.products.get(POS_PRODUCT)).toMatchObject({ quantity: 22 })
        expect((await db.inventory_transactions.toArray()).filter((row) => row.referenceId === input.payload.id))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ storageId: POS_STORAGE, quantityDelta: -1 }),
                expect.objectContaining({ storageId: secondStorageId, quantityDelta: -2 })
            ]))
        await assertPosPayment(input.payload.id, 350)
    })

    it('blocks a Staff checkout below the minimum before sale, payment, ledger, or inventory writes', async () => {
        await seedPosStock('usd')
        await db.products.update(POS_PRODUCT, { minimumSellingPrice: 12 })
        const input = posCheckoutInput({ unitPrice: 11 })
        input.user.role = 'staff'

        await expect(checkout.commitPosCheckout(input)).rejects.toMatchObject({
            name: 'PosCheckoutError',
            cause: expect.objectContaining({ name: 'MinimumSellingPriceViolationError' })
        })

        await assertNoPosCommit()
        await assertPosPayment(input.payload.id, 0)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
        expect(await db.products.get(POS_PRODUCT)).toMatchObject({ quantity: 20 })
    })

    it('allows Staff at the exact minimum even when the selling price is below cost', async () => {
        await seedPosStock('usd')
        await db.products.update(POS_PRODUCT, { minimumSellingPrice: 12 })
        const input = posCheckoutInput({ unitPrice: 12 })
        input.user.role = 'staff'

        await checkout.commitPosCheckout(input)

        expect(await db.sale_items.where('saleId').equals(input.payload.id).first()).toMatchObject({ unitPrice: 12 })
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
        await assertPosPayment(input.payload.id, 12)
    })

    it('allows Admin checkout below the staff minimum', async () => {
        await seedPosStock('usd')
        await db.products.update(POS_PRODUCT, { minimumSellingPrice: 12 })
        const input = posCheckoutInput({ unitPrice: 11 })
        input.user.role = 'admin'

        await checkout.commitPosCheckout(input)

        expect(await db.sale_items.where('saleId').equals(input.payload.id).first()).toMatchObject({ unitPrice: 11 })
        await assertPosPayment(input.payload.id, 11)
    })

    it('pack UoM sale keeps its unit snapshot, independent pricing and deducts canonical base stock', async () => {
        await seedPosStock('iqd')
        await db.products.update(POS_PRODUCT, { minimumSellingPrice: 2_000 })
        const now = new Date().toISOString()
        await db.product_uoms.put({
            id: 'pos-uom-carton', workspaceId: POS_WORKSPACE, productId: POS_PRODUCT,
            unitRef: 'builtin:carton', unitCode: 'carton', coefficient: 20, isBase: false,
            isActive: true, isDefaultSelling: false, sellingPrice: 40_000, costPrice: 800,
            minimumSellingPrice: 30_000, createdAt: now, updatedAt: now,
            syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false
        })
        const input = posCheckoutInput({ currency: 'iqd', quantity: 1, unitPrice: 40_000 })
        input.user.role = 'staff'
        input.payload.items[0] = {
            ...input.payload.items[0],
            selling_unit_ref: 'builtin:carton',
            selling_unit_code: 'carton',
            selling_uom_id: 'pos-uom-carton',
            selling_unit_name_snapshot: 'carton',
            base_unit_ref: 'builtin:pcs',
            base_unit_code: 'pcs',
            unit_factor: 20,
            inventory_quantity: 20,
            uom_cost_price: 800,
            minimum_selling_price_snapshot: 30_000,
            cost_price: 800,
            converted_cost_price: 800,
            batch_allocations: [{
                batch_id: POS_BATCH, batch_number: 'POS-1', quantity: 20,
                price: 100, cost_price: 40, currency: 'iqd', expiry_date: null, manufacturing_date: null
            }]
        }
        input.batchPlans = [{
            productId: POS_PRODUCT,
            storageId: POS_STORAGE,
            allocations: [{ batchId: POS_BATCH, batchNumber: 'POS-1', quantity: 20, price: 100, costPrice: 40, currency: 'iqd' }]
        }]

        await checkout.commitPosCheckout(input)

        expect(await db.sale_items.where('saleId').equals(input.payload.id).first()).toMatchObject({
            quantity: 1,
            sellingUnitRef: 'builtin:carton',
            sellingUnitCode: 'carton',
            sellingUomId: 'pos-uom-carton',
            sellingUnitNameSnapshot: 'carton',
            baseUnitRef: 'builtin:pcs',
            baseUnitCode: 'pcs',
            unitFactor: 20,
            inventoryQuantity: 20,
            uomCostPrice: 800,
            minimumSellingPriceSnapshot: 30_000,
            costPrice: 800
        })
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 0 })
        expect(await db.products.get(POS_PRODUCT)).toMatchObject({ quantity: 0 })
        expect(await db.stock_batches.get(POS_BATCH)).toMatchObject({ quantity: 0 })
        await assertPosPayment(input.payload.id, 40_000)
    })

    it('rejects a UoM payload whose stock quantity does not match its immutable factor', async () => {
        await seedPosStock()
        const input = posCheckoutInput({ quantity: 1 })
        Object.assign(input.payload.items[0], { unit_factor: 20, inventory_quantity: 19 })
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        expect(await db.sales.count()).toBe(0)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('rejects a UoM payload that invents a conversion not configured for the product', async () => {
        await seedPosStock()
        const input = posCheckoutInput({ quantity: 1 })
        Object.assign(input.payload.items[0], {
            selling_unit_ref: 'builtin:carton', selling_unit_code: 'carton',
            base_unit_ref: 'builtin:pcs', base_unit_code: 'pcs',
            unit_factor: 20, inventory_quantity: 20
        })
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        expect(await db.sales.count()).toBe(0)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    for (const scenario of seededPosCases(Number(process.env.ATLAS_TEST_SEED ?? 20260918), Number(process.env.ATLAS_TEST_SAMPLES ?? 16))) {
        it(`generated POS #${scenario.index}: ${scenario.method}/${scenario.currency}/${scenario.quantity}/${scenario.service ? 'service' : 'stock'}`, async () => {
            await seedPosStock(scenario.currency, scenario.service)
            const input = posCheckoutInput(scenario)
            await checkout.commitPosCheckout(input)
            await assertPosPayment(input.payload.id, scenario.quantity * scenario.unitPrice)
            if (!scenario.service) expect((await db.inventory.get(POS_INVENTORY))?.quantity).toBeCloseTo(20 - scenario.quantity, 3)
            expect(await db.offline_mutations.count()).toBe(0)
        })
    }
})
