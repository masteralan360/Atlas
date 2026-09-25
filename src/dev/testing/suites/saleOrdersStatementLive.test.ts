import { describe, expect, it } from 'vitest'
import type { SalesOrder } from '@/local-db/models'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

describe('Sale Orders · hosted partner statement', () => {
    setupHostedSaleOrders()

    it('derives an unpaid order balance from the saved order and matches the hosted partner summary', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const partners = await import('@/local-db/businessPartners')
            const { buildPartnerAccountStatementLedger } = await import('@/lib/partnerAccountStatement')
            const { buildPartnerAccountStatementDisplayEntries } = await import('@/lib/partnerAccountStatementDisplay')
            const { toCamelCase } = await import('@/lib/utils')
            const order = await orders.createQuickSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash'),
                customerName: partner.partnerName, status: 'completed', notes: tag
            })
            ids.orderId = order.id
            recordLiveFixture(ids)
            await partners.recalculateBusinessPartnerSummary(liveWorkspaceId, partner.id, { ensureSync: true })

            const fresh = await freshLiveClient()
            try {
                const savedOrder = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('*').eq('id', order.id).single(), 'statement source order')
                const visiblePartners = requireLiveData<Array<{ id: string; receivable_balance: number }>>(
                    await fresh.schema('crm').rpc('list_visible_business_partners', { p_workspace_id: liveWorkspaceId }), 'visible partners')
                const savedPartner = visiblePartners.find((row) => row.id === partner.id)
                expect(savedPartner).toBeDefined()
                const payments = requireLiveData(await fresh.from('payment_transactions')
                    .select('id').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'order payments')
                const ledger = buildPartnerAccountStatementLedger({
                    partnerId: partner.id, period: { type: 'allTime' },
                    salesOrders: [toCamelCase(savedOrder as Record<string, unknown>) as unknown as SalesOrder], purchaseOrders: [],
                    settlementTransactions: []
                })
                const usd = ledger.find((row) => row.currency === 'usd')
                expect(usd?.closingBalance).toBe(100)
                expect(usd?.entries.some((entry) => entry.kind === 'sales_order' && entry.source?.recordId === order.id)).toBe(true)
                expect(buildPartnerAccountStatementDisplayEntries(usd!).at(-1)?.runningBalance).toBe(100)
                expect(Number(savedPartner!.receivable_balance)).toBe(100)
                expect(payments).toHaveLength(0)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
