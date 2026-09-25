import { describe, expect, it } from 'vitest'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

describe('Sale Orders · hosted payment-method matrix', () => {
    setupHostedSaleOrders()

    for (const [index, method] of STANDARD_PAYMENT_METHODS.entries()) {
        it(`${method}: paid Quick Order and full return persist one linked reversal`, async () => {
            const currency = index % 2 ? 'iqd' : 'usd'
            await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
                const orders = await import('@/local-db/orders')
                const order = await orders.createCompletedSalesOrder(liveWorkspaceId, {
                    ...saleOrderInput(partner.id, product, storage.id, method, { currency, paid: true }),
                    customerName: partner.partnerName, notes: tag
                })
                ids.orderId = order.id
                recordLiveFixture(ids)
                const before = await freshLiveClient()
                try {
                    const saved = requireLiveData(await before.schema('crm').from('sales_orders')
                        .select('id,status,payment_method,total,paid_amount').eq('id', order.id).single(), 'paid order')
                    const stock = requireLiveData(await before.from('inventory')
                        .select('quantity').eq('workspace_id', liveWorkspaceId).eq('product_id', product.id).eq('storage_id', storage.id).single(), 'paid stock')
                    expect(saved).toMatchObject({ status: 'completed', payment_method: method })
                    expect(Number(saved.total)).toBe(100)
                    expect(Number(saved.paid_amount)).toBe(100)
                    expect(Number(stock.quantity)).toBe(9)
                } finally { await before.auth.signOut() }

                const returned = await orders.returnSalesOrder({
                    orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 1 }],
                    reason: 'customer_returned', actorRole: 'admin'
                })
                ids.returnId = returned.return.id
                recordLiveFixture(ids)
                const after = await freshLiveClient()
                try {
                    const saved = requireLiveData(await after.schema('crm').from('sales_orders')
                        .select('return_status,paid_amount').eq('id', order.id).single(), 'returned order')
                    const audit = requireLiveData(await after.from('order_returns')
                        .select('id').eq('id', returned.return.id).maybeSingle(), 'return audit')
                    const payments = requireLiveData<Array<{ id: string; amount: number; reversal_of_transaction_id: string | null; payment_method: string }>>(await after.from('payment_transactions')
                        .select('id,amount,reversal_of_transaction_id,payment_method')
                        .eq('workspace_id', liveWorkspaceId).eq('source_type', 'sales_order').eq('source_record_id', order.id), 'payments')
                    const stock = requireLiveData(await after.from('inventory')
                        .select('quantity').eq('workspace_id', liveWorkspaceId).eq('product_id', product.id).eq('storage_id', storage.id).single(), 'returned stock')
                    expect(audit.id).toBe(returned.return.id)
                    expect(saved.return_status).toBe('full')
                    expect(Number(saved.paid_amount)).toBe(0)
                    expect(Number(stock.quantity)).toBe(10)
                    expect(payments).toHaveLength(2)
                    const original = payments.find((row) => Number(row.amount) > 0)
                    const reversal = payments.find((row) => Number(row.amount) < 0)
                    expect(original).toMatchObject({ amount: 100, payment_method: method })
                    expect(reversal).toMatchObject({ amount: -100, reversal_of_transaction_id: original?.id })
                } finally { await after.auth.signOut() }
            }, { currency })
        }, 120_000)
    }

    it('rejects an overpayment without creating a hosted payment transaction', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const order = await orders.createSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash'),
                customerName: partner.partnerName, notes: tag
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = order.id
            recordLiveFixture(ids)
            await expect(orders.recordOrderPayment(liveWorkspaceId, {
                orderType: 'sales', orderId: order.id, amount: 101,
                paymentMethod: 'cash', paidAt: new Date().toISOString()
            })).rejects.toThrow()
            const fresh = await freshLiveClient()
            try {
                const saved = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('paid_amount,balance_amount').eq('id', order.id).single(), 'unpaid order')
                const payments = requireLiveData(await fresh.from('payment_transactions')
                    .select('id').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'payment rows')
                expect(Number(saved.paid_amount)).toBe(0)
                expect(Number(saved.balance_amount)).toBe(100)
                expect(payments).toHaveLength(0)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
