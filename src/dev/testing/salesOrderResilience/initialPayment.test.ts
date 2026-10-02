import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '../fixtures/browser'
import { saleOrderInput } from '../fixtures/orderInput'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { initialPaymentRegression } from './scenarios/regressionScenarios'

const rpc = vi.hoisted(() => vi.fn(async (name: string, args: Record<string, any>) => ({
    data: name === 'create_sales_order_with_initial_payment' ? {
        order: { ...args.p_order, workspace_id: crypto.randomUUID() }, payment: args.p_transaction
    } : [], error: null
})))
vi.mock('@/auth/supabase', () => {
    const from = () => { throw new Error('Unexpected hosted request') }
    return { isSupabaseConfigured: false, supabase: { rpc, from, schema: () => ({ rpc, from }) } }
})

describe(`${initialPaymentRegression.id} initial payment response contract`, () => {
    beforeAll(() => installTestBrowser())
    for (const dataMode of ['cloud', 'hybrid'] as const) {
        it(`${dataMode}: rejects an invalid receipt without caching a paid order or ledger`, async () => {
            const { createModuleDriver } = await import('./fixtures/moduleFixture')
            const { createSalesOrder } = await import('@/local-db/orders')
            const { db } = await import('@/local-db/database')
            const driver = await createModuleDriver({ currency: 'usd', method: 'cash', account: false })
            const { workspaceId, customers, products, storage } = driver.fixture
            try {
                writeWorkspaceModeSnapshot({ workspaceId, dataMode })
                const orderId = crypto.randomUUID()
                await expect(createSalesOrder(workspaceId,
                    saleOrderInput(customers[0].id, products[0], storage.id, 'cash', { paid: true }),
                    undefined, { orderId, requireRemoteConfirmation: true })).rejects.toThrow('remote_order_save_confirmation_failed')
                expect(rpc).toHaveBeenCalledWith('create_sales_order_with_initial_payment', expect.anything())
                expect(await db.sales_orders.get(orderId)).toBeUndefined()
                expect(await db.payment_transactions.count()).toBe(0)
                expect(await db.payment_account_movements.count()).toBe(0)
                expect((await db.inventory.where('productId').equals(products[0].id).first())?.quantity).toBe(100)
            } finally { await driver.close() }
        })
    }
})
