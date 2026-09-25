import { describe, expect, it } from 'vitest'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

describe('Sale Orders · hosted lifecycle', () => {
    setupHostedSaleOrders()

    it('persists a draft edit and soft deletion without payment or stock movement', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const order = await orders.createSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash'),
                customerName: partner.partnerName, notes: tag
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = order.id
            recordLiveFixture(ids)
            await orders.updateSalesOrder(order.id, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash', { quantity: 2 }),
                customerName: partner.partnerName, notes: `${tag} edited`
            })
            const editedClient = await freshLiveClient()
            try {
                const saved = requireLiveData(await editedClient.schema('crm').from('sales_orders')
                    .select('status,total,notes,is_deleted').eq('id', order.id).single(), 'edited draft')
                expect(saved).toMatchObject({ status: 'draft', notes: `${tag} edited`, is_deleted: false })
                expect(Number(saved.total)).toBe(200)
            } finally { await editedClient.auth.signOut() }
            await orders.deleteSalesOrder(order.id)
            const fresh = await freshLiveClient()
            try {
                const saved = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('is_deleted').eq('id', order.id).single(), 'deleted draft')
                const payments = requireLiveData(await fresh.from('payment_transactions')
                    .select('id').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'draft payments')
                const stock = requireLiveData(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'draft stock')
                expect(saved.is_deleted).toBe(true)
                expect(payments).toHaveLength(0)
                expect(Number(stock.quantity)).toBe(10)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)

    it('posts one payment only when a paid order request is approved', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const request = await orders.createSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash', { paid: true }),
                customerName: partner.partnerName, notes: tag,
                approvalStatus: 'requested', approvalRequestedAt: new Date().toISOString()
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = request.id
            recordLiveFixture(ids)
            const before = await freshLiveClient()
            try {
                const payments = requireLiveData(await before.from('payment_transactions')
                    .select('id').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', request.id), 'unapproved payments')
                expect(payments).toHaveLength(0)
            } finally { await before.auth.signOut() }
            await orders.approveSalesOrderRequest(request.id)
            await expect(orders.approveSalesOrderRequest(request.id)).rejects.toThrow()
            const fresh = await freshLiveClient()
            try {
                const saved = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('approval_status,paid_amount').eq('id', request.id).single(), 'approved order')
                const payments = requireLiveData(await fresh.from('payment_transactions')
                    .select('id,amount').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', request.id), 'approved payments')
                expect(saved.approval_status).toBe('approved')
                expect(Number(saved.paid_amount)).toBe(100)
                expect(payments).toHaveLength(1)
                expect(Number(payments[0].amount)).toBe(100)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
