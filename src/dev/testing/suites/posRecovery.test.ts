import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { assertNoPosCommit, assertPosPayment } from '../assertions/pos'
import { PosSqliteAdapterStub } from '../fixtures/sqlite'
import { POS_BATCH, POS_INVENTORY, POS_PRODUCT, POS_WORKSPACE,
    financePosInput, posCheckoutInput, seedPosStock } from '../fixtures/pos'

vi.mock('@/auth/supabase', () => {
    const unexpected = () => { throw new Error('Unexpected remote call in isolated Local POS scenario') }
    return { supabase: { from: unexpected, rpc: unexpected, schema: () => ({ from: unexpected }) } }
})

let checkout: typeof import('@/local-db/posCheckout')
let sqlite: typeof import('@/local-db/localModeSqlite')

describe('POS failure and recovery (independent of Instant POS)', () => {
    beforeAll(async () => {
        installTestBrowser()
        checkout = await import('@/local-db/posCheckout')
        sqlite = await import('@/local-db/localModeSqlite')
    }, 30_000)
    beforeEach(async () => {
        await db.delete(); await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: 'local' })
    })
    afterEach(() => { sqlite.setLocalModeSqliteConnectionForTests(); vi.restoreAllMocks(); clearWorkspaceModeSnapshot(POS_WORKSPACE) })
    afterAll(async () => { await db.delete() })

    for (const quantity of [0, -1, NaN, Infinity, 20.01]) it(`invalid/unavailable quantity ${quantity} leaves all records and stock untouched`, async () => {
        await seedPosStock()
        await expect(checkout.commitPosCheckout(posCheckoutInput({ quantity }))).rejects.toThrow()
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
        expect(await db.stock_batches.get(POS_BATCH)).toMatchObject({ quantity: 20 })
    })

    it('rolls back headers, items and inventory when batch commitment fails', async () => {
        await seedPosStock()
        const input = posCheckoutInput()
        input.batchPlans[0].allocations[0].quantity = 21
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('rolls back sale and stock when payment posting rejects a missing account', async () => {
        await seedPosStock()
        const input = posCheckoutInput()
        input.account = { id: crypto.randomUUID(), name: 'Deleted account' }
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('rolls back financed sale and stock when loan registration fails', async () => {
        await seedPosStock()
        const input = financePosInput(posCheckoutInput(), 3)
        input.loanRegistration!.borrowerName = ''
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('rejects a changed payload using an already committed sale ID', async () => {
        await seedPosStock()
        const input = posCheckoutInput()
        await checkout.commitPosCheckout(input)
        input.payload.payment_method = 'fib'
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        await assertPosPayment(input.payload.id, 100)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
    })

    it('a free service creates no zero-value payment', async () => {
        await seedPosStock('usd', true)
        const input = posCheckoutInput({ service: true, unitPrice: 0 })
        await checkout.commitPosCheckout(input)
        await assertPosPayment(input.payload.id, 0)
    })

    it('rejects missing product and service/physical storage mismatch', async () => {
        await seedPosStock()
        const input = posCheckoutInput({ service: true })
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        await db.products.delete(POS_PRODUCT)
        await expect(checkout.commitPosCheckout(posCheckoutInput())).rejects.toThrow()
        await assertNoPosCommit()
    })

    it('aggregates duplicate product/storage lines before checking inventory', async () => {
        await seedPosStock()
        const input = posCheckoutInput({ quantity: 11 })
        input.payload.items.push({ ...input.payload.items[0] })
        input.payload.total_amount = 2200
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('serializes simultaneous submissions of the same sale ID', async () => {
        await seedPosStock()
        const input = posCheckoutInput()
        await Promise.all([checkout.commitPosCheckout(input), checkout.commitPosCheckout(input)])
        expect(await db.sales.count()).toBe(1)
        await assertPosPayment(input.payload.id, 100)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
    })

    it('sends the entire Local sale write set to one SQLite adapter transaction', async () => {
        await seedPosStock()
        const adapter = new PosSqliteAdapterStub()
        sqlite.setLocalModeSqliteConnectionForTests(adapter)
        const input = posCheckoutInput()
        await checkout.commitPosCheckout(input)
        expect(adapter.events).toEqual(['begin', 'commit'])
        const tables = [...adapter.rows.keys()].map(key => key.split(':')[0])
        for (const name of ['sales', 'sale_items', 'inventory', 'products', 'stock_batches', 'payment_transactions']) expect(tables).toContain(name)
        expect(JSON.parse(adapter.rows.get(`sales:${input.payload.id}`)!)).toMatchObject({ totalAmount: 100, origin: 'pos' })
    })

    it('rolls back IndexedDB and the SQLite adapter write set when SQLite rejects a payment', async () => {
        await seedPosStock()
        const adapter = new PosSqliteAdapterStub()
        adapter.failTable = 'payment_transactions'
        sqlite.setLocalModeSqliteConnectionForTests(adapter)
        await expect(checkout.commitPosCheckout(posCheckoutInput())).rejects.toThrow()
        expect(adapter.events).toEqual(['begin', 'rollback'])
        expect(adapter.rows.size).toBe(0)
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    for (const price of [-1, NaN, Infinity]) it(`rejects invalid price ${price} before creating any records`, async () => {
        await seedPosStock()
        await expect(checkout.commitPosCheckout(posCheckoutInput({ unitPrice: price }))).rejects.toThrow()
        await assertNoPosCommit()
    })

    for (const count of [0, 1.5, 121]) it(`rejects invalid installment count ${count} before saving the sale`, async () => {
        await seedPosStock()
        const input = financePosInput(posCheckoutInput())
        input.loanRegistration!.installmentCount = count
        await expect(checkout.commitPosCheckout(input)).rejects.toThrow()
        await assertNoPosCommit()
    })

})
