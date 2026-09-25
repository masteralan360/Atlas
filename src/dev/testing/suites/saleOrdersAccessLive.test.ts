import { describe, expect, it } from 'vitest'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

describe('Sale Orders · hosted UI access boundary', () => {
    setupHostedSaleOrders()

    it('the dedicated account can read only its verified workspace and its persisted order', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const order = await orders.createSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash'),
                customerName: partner.partnerName, notes: tag
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = order.id
            recordLiveFixture(ids)
            const fresh = await freshLiveClient()
            try {
                const workspaces = requireLiveData<Array<{ id: string }>>(await fresh.from('workspaces').select('id'), 'visible workspaces')
                const ownOrder = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('id,workspace_id,status').eq('id', order.id).single(), 'visible order')
                const excluded = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('id').eq('id', order.id).neq('workspace_id', liveWorkspaceId), 'cross-workspace order query')
                expect(workspaces.map((row) => row.id)).toEqual([liveWorkspaceId])
                expect(ownOrder).toMatchObject({ id: order.id, workspace_id: liveWorkspaceId, status: 'draft' })
                expect(excluded).toHaveLength(0)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
