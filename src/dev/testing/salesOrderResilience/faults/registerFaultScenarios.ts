import { describe, expect, it } from 'vitest'
import type { SalesOrderDriver } from '../drivers/SalesOrderDriver'
import type { LabConfiguration, Action } from '../model/modelTypes'
import { applyAction, newModel } from '../model/modelState'
import { assertInvariants } from '../invariants'
import type { SupabaseDriver } from '../drivers/supabaseDriver'

export function registerFaultScenarios(createDriver: (configuration: LabConfiguration) => Promise<SalesOrderDriver>) {
    describe('Sales Order Resilience Lab · interrupted and competing operations', () => {
        it('SORL-FAULT-001 invalid payments and transitions leave the graph unchanged', async () => {
            const driver = await createDriver({ currency: 'usd', method: 'cash', account: true })
            try {
                await driver.execute({ name: 'CreateOrder' })
                const model = newModel(driver.configuration); applyAction({ name: 'CreateOrder' }, model)
                const before = await driver.readDatabaseGraph()
                const { recordOrderPayment, returnSalesOrder } = await import('@/local-db/orders')
                const order = (await driver.readOrder())!
                for (const amount of [0, -1, 100.001]) await expect(recordOrderPayment(driver.fixture.workspaceId,
                    { orderId: order.id, orderType: 'sales', amount, paymentMethod: 'cash', paidAt: new Date().toISOString() })).rejects.toThrow()
                await expect(driver.execute({ name: 'CompleteOrder' })).rejects.toThrow('invalid_order_transition')
                await expect(returnSalesOrder({ orderId: order.id, items: [], reason: 'customer_returned', actorRole: 'viewer', returnedBy: null })).rejects.toThrow()
                expect(await driver.readDatabaseGraph()).toEqual(before)
                await assertInvariants(model, driver)
            } finally { await driver.close() }
        }, 120_000)
        it('SORL-FAULT-002 overlapping payment, fulfillment and return retries have one business effect', async () => {
            const driver = await createDriver({ currency: 'usd', method: 'cash', account: true })
            const model = newModel(driver.configuration)
            const step = async (action: Action) => { await driver.execute(action); applyAction(action, model); await assertInvariants(model, driver) }
            try {
                await step({ name: 'CreateOrder' }); await step({ name: 'RecordPayment', value: 100 })
                await Promise.all([driver.execute({ name: 'RetryPayment' }), driver.execute({ name: 'RetryPayment' })])
                await assertInvariants(model, driver); await step({ name: 'MoveToPending' })
                await Promise.all([driver.execute({ name: 'CompleteOrder' }), driver.execute({ name: 'CompleteOrder' })])
                applyAction({ name: 'CompleteOrder' }, model); await assertInvariants(model, driver)
                if (driver.boundary === 'supabase') (driver as SupabaseDriver).transport.arm('order_return_items', 'lost-response')
                await step({ name: 'ReturnItems', value: 50 })
                await Promise.all([driver.execute({ name: 'RetryReturn' }), driver.execute({ name: 'RetryReturn' })])
                if (driver.boundary === 'supabase') {
                    expect((driver as SupabaseDriver).transport.requests.some(row => row.fault === 'lost-response')).toBe(true)
                    await driver.execute({ name: 'RetrySync' })
                    const { db } = await import('@/local-db/database')
                    const graph = await driver.readDatabaseGraph()
                    await db.order_return_items.where('returnId').equals(graph.returns[0].id).delete()
                    await db.order_returns.delete(graph.returns[0].id)
                    await driver.execute({ name: 'RetryReturn' })
                }
                await assertInvariants(model, driver); await step({ name: 'ReloadState' })
                const graph = await driver.readDatabaseGraph()
                const { returnSalesOrder } = await import('@/local-db/orders')
                await expect(returnSalesOrder({ orderId: graph.orders[0].id, idempotencyKey: graph.returns[0].id,
                    items: [{ orderItemId: graph.orders[0].items[0].id, quantity: 0.75 }], reason: 'customer_returned',
                    actorRole: 'admin', returnedBy: driver.fixture.userId })).rejects.toThrow('return_request_identity_mismatch')
                await assertInvariants(model, driver)
            } finally { await driver.close() }
        }, 120_000)
        it('SORL-FAULT-003 failure before request and committed lost response can be retried without duplicate payments', async () => {
            for (const kind of ['before', 'lost-response'] as const) {
                const driver = await createDriver({ currency: 'usd', method: 'cash', account: false })
                const model = newModel(driver.configuration)
                try {
                    await driver.execute({ name: 'CreateOrder' }); applyAction({ name: 'CreateOrder' }, model)
                    if (driver.boundary === 'supabase') {
                        const hosted = driver as SupabaseDriver
                        hosted.transport.arm('record_order_payment', kind)
                        await expect(driver.execute({ name: 'RecordPayment', value: 50 })).rejects.toThrow()
                        const remote = await hosted.readRemoteGraph()
                        expect(remote.payments).toHaveLength(kind === 'before' ? 0 : 1)
                        await driver.execute({ name: 'RetryPayment' })
                        expect(hosted.transport.requests.some(row => row.fault === kind)).toBe(true)
                    } else {
                        await driver.execute({ name: 'RecordPayment', value: 50 })
                        await driver.execute({ name: 'ReloadState' })
                        await driver.execute({ name: 'RetryPayment' })
                    }
                    applyAction({ name: 'RecordPayment', value: 50 }, model)
                    await assertInvariants(model, driver)
                    await driver.execute({ name: 'RetryPayment' }); await assertInvariants(model, driver)
                } finally { await driver.close() }
            }
        }, 120_000)
        it('SORL-FAULT-004 saved offline edits converge after reconnect, double sync and storage restart', async () => {
            const driver = await createDriver({ currency: 'iqd', method: 'cash', account: false })
            try {
                const { runSequence } = await import('../runner/resilienceRunner')
                await runSequence(driver, [{ name: 'CreateOrder' }, { name: 'GoOffline' }, { name: 'ChangeQuantity', value: 2.5 },
                    { name: 'SaveDraft' }, { name: 'ReloadState' }, { name: 'GoOnline' }, { name: 'RetrySync' }, { name: 'RetrySync' }, { name: 'ReloadState' }])
                if (driver.boundary === 'supabase') {
                    const { db } = await import('@/local-db/database')
                    expect(await db.offline_mutations.filter(row => row.status !== 'synced').count()).toBe(0)
                    const hosted = driver as SupabaseDriver
                    const remote = (await hosted.readRemoteGraph()).orders[0]
                    // A separate JWT starts from a stale version. Its conditional write cannot erase the acknowledged edit.
                    const stale = await hosted.observer.schema('crm').from('sales_orders').update({ notes: 'stale write' })
                        .eq('id', remote.id).eq('workspace_id', driver.fixture.workspaceId).eq('version', remote.version - 1).select('id')
                    expect(stale.error).toBeNull(); expect(stale.data).toEqual([])
                    expect((await hosted.readRemoteGraph()).orders[0].items[0].quantity).toBe(2.5)
                }
            } finally { await driver.close() }
        }, 120_000)
    })
}
