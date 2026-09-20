import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { assertPosPayment } from '../assertions/pos'
import { POS_BATCH, POS_CURRENCIES, POS_INVENTORY, POS_METHODS, POS_PRODUCT, POS_STORAGE, POS_WORKSPACE,
    posCheckoutInput, seededPosCases, seedPosStock } from '../fixtures/pos'

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
        await checkout.commitPosCheckout(input)
        expect(await db.sale_items.where('saleId').equals(input.payload.id).first()).toMatchObject({ storageId: null, inventorySnapshot: null })
        expect(await db.inventory.count()).toBe(0)
        expect(await db.stock_batches.count()).toBe(0)
        await assertPosPayment(input.payload.id, 100)
    })

    it('related parent-unit sale keeps the sold-unit snapshot and deducts canonical child stock', async () => {
        await seedPosStock('iqd')
        const now = new Date().toISOString()
        await db.products.update(POS_PRODUCT, { unit: 'sheet' })
        await db.unit_relationships.put({
            id: 'pos-unit-relationship', workspaceId: POS_WORKSPACE, name: 'Packaging',
            parentUnitRef: 'builtin:carton', parentUnitCode: 'carton',
            childUnitRef: 'builtin:sheet', childUnitCode: 'sheet', isArchived: false,
            createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now,
            version: 1, isDeleted: false
        })
        await db.product_unit_conversions.put({
            id: 'pos-unit-conversion', workspaceId: POS_WORKSPACE, productId: POS_PRODUCT,
            relationshipId: 'pos-unit-relationship', factor: 20, parentPrice: 40_000,
            createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now,
            version: 1, isDeleted: false
        })
        const input = posCheckoutInput({ currency: 'iqd', quantity: 1, unitPrice: 40_000 })
        input.payload.items[0] = {
            ...input.payload.items[0],
            selling_unit_ref: 'builtin:carton',
            selling_unit_code: 'carton',
            base_unit_ref: 'builtin:sheet',
            base_unit_code: 'sheet',
            unit_factor: 20,
            inventory_quantity: 20,
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
            baseUnitRef: 'builtin:sheet',
            baseUnitCode: 'sheet',
            unitFactor: 20,
            inventoryQuantity: 20,
            costPrice: 800
        })
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 0 })
        expect(await db.products.get(POS_PRODUCT)).toMatchObject({ quantity: 0 })
        expect(await db.stock_batches.get(POS_BATCH)).toMatchObject({ quantity: 0 })
        await assertPosPayment(input.payload.id, 40_000)
    })

    it('rejects a related-unit payload whose stock quantity does not match its immutable factor', async () => {
        await seedPosStock()
        const input = posCheckoutInput({ quantity: 1 })
        Object.assign(input.payload.items[0], { unit_factor: 20, inventory_quantity: 19 })
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        expect(await db.sales.count()).toBe(0)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('rejects a related-unit payload that invents a conversion not configured for the product', async () => {
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
