import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sale } from '@/types'
import { db } from '@/local-db/database'
import { getLedgerPaymentTransactionEffect, getLedgerPaymentTransactions } from '@/lib/ledgerPaymentTransactions'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { POS_INVENTORY, POS_PRODUCT, POS_STORAGE, POS_TIME, POS_WORKSPACE, financePosInput, posCheckoutInput, seedPosStock } from '../fixtures/pos'

vi.mock('@/auth/supabase', () => {
    const unexpected = () => { throw new Error('Unexpected remote request in Local POS refund') }
    return { supabase: { from: unexpected, rpc: unexpected, schema: () => ({ from: unexpected }) } }
})
let checkout: typeof import('@/local-db/posCheckout')
let returns: typeof import('@/local-db/posSaleReturns')
let accounts: typeof import('@/local-db/paymentAccounts')

async function arrange(account = false, financed = false) {
    await seedPosStock()
    const input = posCheckoutInput({ quantity: 2 })
    if (account) input.account = await accounts.savePaymentAccount(POS_WORKSPACE, { name: 'Refund drawer', accountType: 'cash_drawer', openingBalances: [] })
    if (financed) financePosInput(input)
    await checkout.commitPosCheckout(input)
    const [item] = await db.sale_items.where('saleId').equals(input.payload.id).toArray()
    const sale = { id: input.payload.id, workspace_id: POS_WORKSPACE, cashier_id: input.user.id,
        total_amount: input.payload.total_amount, created_at: POS_TIME, origin: 'pos', payment_method: financed ? 'loan' : 'cash',
        settlement_currency: 'usd', totalAmount: 200,
        items: [{ ...input.payload.items[0], id: item.id, sale_id: input.payload.id }] } as Sale
    const refund = (amount: number, quantity: number, returnId = crypto.randomUUID()) => ({
        returnId, sale, reason: 'Customer returned item', timestamp: POS_TIME, refundAmount: amount,
        linePayloads: [{ id: crypto.randomUUID(), sale_item_id: item.id, quantity }],
        restoredPlans: [{ storageId: item.storageId ?? null, restoredBatchAllocations: [] }], pendingSync: false
    })
    return { input, sale, refund }
}

async function assertRefundLedger(saleId: string, amounts: number[], net: number) {
    const payments = await db.payment_transactions.where('sourceRecordId').equals(saleId).toArray()
    expect(payments.map(row => row.amount).sort((a, b) => a - b)).toEqual(amounts.sort((a, b) => a - b))
    const original = payments.find(row => !row.reversalOfTransactionId)!
    for (const row of payments.filter(row => row.reversalOfTransactionId)) expect(row.reversalOfTransactionId).toBe(original.id)
    const ledger = getLedgerPaymentTransactions(payments)
    expect(ledger).toHaveLength(payments.length)
    expect(ledger.reduce((sum, row) => {
        const effect = getLedgerPaymentTransactionEffect(row)
        return sum + (effect.direction === 'incoming' ? effect.amount : -effect.amount)
    }, 0)).toBe(net)
}

describe('POS return records and refund audit entries used by Sales', () => {
    beforeAll(async () => {
        installTestBrowser(); checkout = await import('@/local-db/posCheckout')
        returns = await import('@/local-db/posSaleReturns'); accounts = await import('@/local-db/paymentAccounts')
    }, 30_000)
    beforeEach(async () => { await db.delete(); await db.open(); writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: 'local' }) })
    afterEach(() => clearWorkspaceModeSnapshot(POS_WORKSPACE))
    afterAll(async () => { await db.delete() })

    it('partial then full refunds retain the original payment and exact linked counter-entries', async () => {
        const { input, refund } = await arrange(true)
        const partial = refund(50, 0.5)
        await returns.persistSaleReturnLedger(partial)
        await assertRefundLedger(input.payload.id, [200, -50], 150)
        expect(await db.sale_returns.get(partial.returnId)).toMatchObject({ refundAmount: 50, status: 'posted' })
        expect(await db.sale_return_items.where('returnId').equals(partial.returnId).first()).toMatchObject({ quantity: 0.5, unitRefundAmount: 100, refundAmount: 50 })
        await returns.persistSaleReturnLedger(refund(150, 1.5))
        await assertRefundLedger(input.payload.id, [200, -50, -150], 0)
        expect(await db.payment_account_balances.where('accountId').equals(input.account!.id).first()).toMatchObject({ balanceAmount: 0 })
        expect(await db.payment_account_movements.where('accountId').equals(input.account!.id).count()).toBe(3)
    })

    it('retrying the same return ID cannot post a second refund', async () => {
        const { input, refund } = await arrange()
        const full = refund(200, 2)
        await returns.persistSaleReturnLedger(full)
        await returns.persistSaleReturnLedger(full)
        await assertRefundLedger(input.payload.id, [200, -200], 0)
        expect(await db.sale_returns.count()).toBe(1)
    })

    it('rejects over-reversal and leaves new return records absent', async () => {
        const { input, refund } = await arrange()
        await returns.persistSaleReturnLedger(refund(150, 1.5))
        const invalid = refund(100, 1)
        await expect(returns.persistSaleReturnLedger(invalid)).rejects.toThrow()
        expect(await db.sale_returns.get(invalid.returnId)).toBeUndefined()
        expect(await db.sale_return_items.where('returnId').equals(invalid.returnId).count()).toBe(0)
        await assertRefundLedger(input.payload.id, [200, -150], 50)
    })

    it('rejects mismatched refund math and invalid quantities', async () => {
        const { input, refund } = await arrange()
        for (const invalid of [refund(100, 0.5), refund(0, 0), refund(300, 3)]) {
            await expect(returns.persistSaleReturnLedger(invalid)).rejects.toThrow()
            expect(await db.sale_returns.get(invalid.returnId)).toBeUndefined()
        }
        await assertRefundLedger(input.payload.id, [200], 200)
    })

    it('financed return records do not create a cash refund; loan handling remains independent', async () => {
        const { input, refund } = await arrange(false, true)
        await returns.persistSaleReturnLedger(refund(100, 1))
        expect(await db.payment_transactions.where('sourceRecordId').equals(input.payload.id).count()).toBe(0)
        expect(await db.sale_returns.count()).toBe(1)
    })

    it('refund calculations preserve zero converted prices and fractional quantities', () => {
        const item = { ...posCheckoutInput().payload.items[0], id: 'return-line', sale_id: 'sale' }
        expect(returns.calculateSaleReturnAmount([{ ...item, converted_unit_price: 0 }], [0.5])).toBe(0)
        expect(returns.calculateSaleReturnAmount([{ ...item, converted_unit_price: 12.34 }], [0.25])).toBeCloseTo(3.085, 6)
        expect(returns.calculateSaleReturnAmount([{ ...item, converted_unit_price: undefined }], [0.25])).toBe(25)
    })

    it('a zero-value returned line records the return without a cash counter-entry', async () => {
        const { input, sale, refund } = await arrange()
        sale.items![0].converted_unit_price = 0
        const freeReturn = refund(0, 0.5)
        await returns.persistSaleReturnLedger(freeReturn)
        expect(await db.sale_return_items.where('returnId').equals(freeReturn.returnId).first()).toMatchObject({ unitRefundAmount: 0, refundAmount: 0 })
        await assertRefundLedger(input.payload.id, [200], 200)
    })

    it('Local return scope rolls stock, sale header and refund entries back together on failure', async () => {
        const { input, refund } = await arrange()
        const { adjustInventoryQuantity } = await import('@/local-db/inventory')
        await expect(returns.commitLocalSaleReturn(POS_WORKSPACE, async () => {
            await adjustInventoryQuantity({ workspaceId: POS_WORKSPACE, productId: POS_PRODUCT, storageId: POS_STORAGE,
                quantityDelta: 2, timestamp: POS_TIME, skipRemoteSync: true, skipReorderCheck: true })
            await returns.persistSaleReturnLedger(refund(200, 2))
            await db.sales.update(input.payload.id, { totalAmount: 0, returnedAmount: 200, returnStatus: 'full' })
            throw new Error('Injected return failure')
        })).rejects.toThrow('Injected return failure')
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 18 })
        expect(await db.sales.get(input.payload.id)).toMatchObject({ totalAmount: 200, returnedAmount: 0 })
        expect(await db.sale_returns.count()).toBe(0)
        await assertRefundLedger(input.payload.id, [200], 200)
    })

    it('Local return scope commits stock, sale header and refund ledger together', async () => {
        const { input, refund } = await arrange()
        const { adjustInventoryQuantity } = await import('@/local-db/inventory')
        await returns.commitLocalSaleReturn(POS_WORKSPACE, async () => {
            await adjustInventoryQuantity({ workspaceId: POS_WORKSPACE, productId: POS_PRODUCT, storageId: POS_STORAGE,
                quantityDelta: 2, timestamp: POS_TIME, skipRemoteSync: true, skipReorderCheck: true })
            await returns.persistSaleReturnLedger(refund(200, 2))
            await db.sales.update(input.payload.id, { totalAmount: 0, returnedAmount: 200, returnStatus: 'full' })
        })
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
        expect(await db.sales.get(input.payload.id)).toMatchObject({ totalAmount: 0, returnedAmount: 200 })
        await assertRefundLedger(input.payload.id, [200, -200], 0)
    })
})
