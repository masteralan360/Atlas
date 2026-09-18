import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { assertPosPayment } from '../assertions/pos'
import { POS_BATCH, POS_CURRENCIES, POS_INVENTORY, POS_METHODS, POS_PRODUCT, POS_WORKSPACE,
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
    }, 30_000)
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
