import { describe, expect, it } from 'vitest'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

describe('Sale Orders · hosted pricing', () => {
    setupHostedSaleOrders()

    it('persists fractional line pricing, payment, stock, and a full return', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const quantity = 2.5
            const total = 25.313
            const order = await orders.createCompletedSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash', {
                    quantity, unitPrice: 10.125, paid: true
                }), customerName: partner.partnerName, notes: tag
            })
            ids.orderId = order.id
            recordLiveFixture(ids)
            const before = await freshLiveClient()
            try {
                const saved = requireLiveData(await before.schema('crm').from('sales_orders')
                    .select('total,paid_amount').eq('id', order.id).single(), 'priced order')
                const stock = requireLiveData(await before.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'priced stock')
                expect(Number(saved.total)).toBeCloseTo(total, 3)
                expect(Number(saved.paid_amount)).toBeCloseTo(total, 3)
                expect(Number(stock.quantity)).toBeCloseTo(7.5, 3)
            } finally { await before.auth.signOut() }
            const returned = await orders.returnSalesOrder({
                orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity }],
                reason: 'customer_returned', actorRole: 'admin'
            })
            ids.returnId = returned.return.id
            recordLiveFixture(ids)
            const fresh = await freshLiveClient()
            try {
                const saved = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('return_status,paid_amount').eq('id', order.id).single(), 'returned priced order')
                const payments = requireLiveData<Array<{ amount: number }>>(await fresh.from('payment_transactions')
                    .select('amount').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'priced payments')
                const stock = requireLiveData(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'returned priced stock')
                expect(saved.return_status).toBe('full')
                expect(Number(saved.paid_amount)).toBe(0)
                expect(payments.reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(0, 3)
                expect(Number(stock.quantity)).toBe(10)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)

    it('persists an order discount as a reduced payment without changing unit stock', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const input = saleOrderInput(partner.id, product, storage.id, 'cash', { paid: true })
            const order = await orders.createCompletedSalesOrder(liveWorkspaceId, {
                ...input, customerName: partner.partnerName, notes: tag,
                discount: 10, total: 90, paidAmount: 90, balanceAmount: 0
            })
            ids.orderId = order.id
            recordLiveFixture(ids)
            const fresh = await freshLiveClient()
            try {
                const saved = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('subtotal,discount,total,paid_amount').eq('id', order.id).single(), 'discounted order')
                const payments = requireLiveData(await fresh.from('payment_transactions')
                    .select('amount').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'discounted payments')
                const stock = requireLiveData(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'discounted stock')
                expect(Number(saved.subtotal)).toBe(100)
                expect(Number(saved.discount)).toBe(10)
                expect(Number(saved.total)).toBe(90)
                expect(Number(saved.paid_amount)).toBe(90)
                expect(payments).toHaveLength(1)
                expect(Number(payments[0].amount)).toBe(90)
                expect(Number(stock.quantity)).toBe(9)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
