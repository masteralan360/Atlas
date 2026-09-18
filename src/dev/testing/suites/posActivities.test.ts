import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { getLedgerPaymentTransactions } from '@/lib/ledgerPaymentTransactions'
import { installTestBrowser } from '../fixtures/browser'
import { POS_METHODS, POS_TIME, POS_WORKSPACE } from '../fixtures/pos'

vi.mock('@/auth/supabase', () => {
    const unexpected = () => { throw new Error('Unexpected remote request in Local POS activity scenario') }
    return { supabase: { from: unexpected, rpc: unexpected, schema: () => ({ from: unexpected }) } }
})
let activities: typeof import('@/local-db/activities')
describe('POS Activities are independent from inventory sales and Orders', () => {
    beforeAll(async () => { installTestBrowser(); activities = await import('@/local-db/activities') }, 30_000)
    beforeEach(async () => { await db.delete(); await db.open(); writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: 'local' }) })
    afterEach(() => clearWorkspaceModeSnapshot(POS_WORKSPACE))
    afterAll(async () => { await db.delete() })

    for (const method of POS_METHODS) for (const infinite of [false, true]) it(`${method} / ${infinite ? 'infinite' : 'finite'} activity posts its own records and ledger receipt`, async () => {
        const activity = await activities.saveActivityCatalogItem(POS_WORKSPACE, {
            name: 'POS test activity', defaultUnitPrice: 100, currency: 'usd', isInfinite: infinite, availableQuantity: 5
        })
        const result = await activities.createActivityTransaction(POS_WORKSPACE, {
            name: 'POS activity sale', occurredAt: POS_TIME, currency: 'usd', paymentMethod: method,
            lines: [{ activityId: activity.id, quantity: 2.25, unitPrice: 80 }]
        })
        expect(result.transaction).toMatchObject({ totalAmount: 180, paymentMethod: method, status: 'completed' })
        expect(await db.activity_transaction_lines.where('transactionId').equals(result.transaction.id).count()).toBe(1)
        if (!infinite) expect(await db.activity_catalog.get(activity.id)).toMatchObject({ availableQuantity: 2.75 })
        const payments = await db.payment_transactions.where('sourceRecordId').equals(result.transaction.id).toArray()
        expect(payments).toHaveLength(1)
        expect(payments[0]).toMatchObject({ amount: 180, paymentMethod: method })
        expect(getLedgerPaymentTransactions(payments)).toHaveLength(1)
        expect(await db.sales.count()).toBe(0)
        expect(await db.sales_orders.count()).toBe(0)
        expect(await db.inventory.count()).toBe(0)
    })

    it('rejects unavailable activity quantity without posting business records or cash', async () => {
        const activity = await activities.saveActivityCatalogItem(POS_WORKSPACE, {
            name: 'Limited activity', defaultUnitPrice: 100, currency: 'usd', isInfinite: false, availableQuantity: 1
        })
        await expect(activities.createActivityTransaction(POS_WORKSPACE, {
            name: 'Overbooked', occurredAt: POS_TIME, currency: 'usd', paymentMethod: 'cash',
            lines: [{ activityId: activity.id, quantity: 2, unitPrice: 100 }]
        })).rejects.toThrow()
        expect(await db.activity_transactions.count()).toBe(0)
        expect(await db.payment_transactions.count()).toBe(0)
        expect(await db.activity_catalog.get(activity.id)).toMatchObject({ availableQuantity: 1 })
    })
})
