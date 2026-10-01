import { describe, expect, it } from 'vitest'
import { writeWorkspaceCache } from '@/workspace/workspaceCache'
import type { SalesOrder } from '@/local-db/models'
import { saleOrderInput } from '../fixtures/saleOrder'
import { liveSupabase } from '../liveSupabase'
import {
  freshLiveClient,
  liveWorkspaceId,
  recordLiveFixture,
  requireLiveData,
  setupHostedSaleOrders,
  withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

setupHostedSaleOrders()

describe('Sales-account agent refund statement · hosted Supabase', () => {
  it('omits agent return-reversal debits while preserving ordinary customer refunds', async () => {
    const workspaceCacheKey = `atlas_workspace_cache:v2:${liveWorkspaceId}`
    const previousWorkspaceCache = localStorage.getItem(workspaceCacheKey)
    writeWorkspaceCache({
      workspaceId: liveWorkspaceId,
      workspaceName: 'DEV TEST Atlas',
      features: { agent_sales_accounts: true }
    })
    try {
      await withLiveSaleOrderFixture(async ({ ids, partner, storage, product, tag }) => {
      const partners = await import('@/local-db/businessPartners')
      const orders = await import('@/local-db/orders')
      const agentPartner = await partners.createBusinessPartner(liveWorkspaceId, {
        partnerName: `${tag} sales-account agent`,
        phone: '',
        defaultCurrency: 'usd',
        creditLimit: 0,
        role: 'agent',
        agent: { agentType: 'field_agent', status: 'active', zone: 'DEV TEST', salesAccountEnabled: true }
      }, { allowAgentRole: true })
      const agentId = agentPartner.agentFacetId
      if (!agentId) throw new Error('hosted_agent_facet_missing')
      ids.agentPartnerId = agentPartner.id
      ids.agentId = agentId
      recordLiveFixture(ids)

      const actorId = (await liveSupabase.auth.getUser()).data.user?.id
      if (!actorId) throw new Error('live_actor_missing')
      const createReturnedSale = async (customerId: string, customerName: string, fixtureKey: string) => {
        const input = {
          ...saleOrderInput(customerId, product, storage.id, 'cash', { quantity: 2, paid: true }),
          customerName,
          commissionEnabled: true,
          salesAccountAgentId: agentId,
          status: 'completed' as const,
          notes: `${tag} ${fixtureKey}`
        }
        const order = await orders.createQuickSalesOrder(liveWorkspaceId, input, actorId)
        ids[fixtureKey] = order.id
        recordLiveFixture(ids)
        const result = await orders.returnSalesOrder({
          orderId: order.id,
          items: [{ orderItemId: order.items[0].id, paidQuantity: 1, freeQuantity: 0 }],
          reason: 'customer_returned',
          actorRole: 'admin'
        })
        ids[`${fixtureKey}ReturnId`] = result.return.id
        recordLiveFixture(ids)
        return { orderId: order.id, returnId: result.return.id }
      }

      const agentSale = await createReturnedSale(agentPartner.id, agentPartner.partnerName, 'agentOrderId')
      const customerSale = await createReturnedSale(partner.id, partner.partnerName, 'customerOrderId')
      const observer = await freshLiveClient()
      try {
        const { toCamelCase } = await import('@/lib/utils')
        const { buildPartnerAccountStatementLedger } = await import('@/lib/partnerAccountStatement')
        const readOrderAndPayments = async (orderId: string) => {
          const order = requireLiveData<Record<string, unknown>>(
            await observer.schema('crm').from('sales_orders').select('*').eq('workspace_id', liveWorkspaceId).eq('id', orderId).single(),
            'persisted return order'
          )
          const payments = requireLiveData<Record<string, unknown>[]>(
            await observer.from('payment_transactions').select('*').eq('workspace_id', liveWorkspaceId)
              .eq('source_type', 'sales_order').eq('source_record_id', orderId).eq('is_deleted', false),
            'persisted order payments'
          )
          const returns = requireLiveData<Record<string, unknown>[]>(
            await observer.from('order_returns').select('*').eq('workspace_id', liveWorkspaceId).eq('order_id', orderId)
              .eq('is_deleted', false),
            'persisted order returns'
          )
          return {
            order: toCamelCase(order) as unknown as SalesOrder,
            payments: payments.map((row) => toCamelCase(row)) as any[],
            returns: returns.map((row) => toCamelCase(row)) as any[]
          }
        }

        const [savedAgentSale, savedCustomerSale] = await Promise.all([
          readOrderAndPayments(agentSale.orderId),
          readOrderAndPayments(customerSale.orderId)
        ])
        const agentReversal = savedAgentSale.payments.find((payment) => payment.reversalOfTransactionId)
        const customerReversal = savedCustomerSale.payments.find((payment) => payment.reversalOfTransactionId)
        expect(agentReversal?.metadata?.orderReturnId).toBe(agentSale.returnId)
        expect(customerReversal?.metadata?.orderReturnId).toBe(customerSale.returnId)
        expect(savedAgentSale.returns.some((orderReturn) => orderReturn.id === agentSale.returnId)).toBe(true)
        expect(savedCustomerSale.returns.some((orderReturn) => orderReturn.id === customerSale.returnId)).toBe(true)
        expect(Number(agentReversal?.amount)).toBe(-100)
        expect(Number(customerReversal?.amount)).toBe(-100)

        const agentLedger = buildPartnerAccountStatementLedger({
          partnerId: agentPartner.id,
          period: { type: 'allTime' },
          salesOrders: [savedAgentSale.order],
          purchaseOrders: [],
          salesAccountAgentIds: [agentId],
          settlementTransactions: savedAgentSale.payments
        })
        const customerLedger = buildPartnerAccountStatementLedger({
          partnerId: partner.id,
          period: { type: 'allTime' },
          salesOrders: [savedCustomerSale.order],
          purchaseOrders: [],
          settlementTransactions: savedCustomerSale.payments
        })
        expect(agentLedger.flatMap((ledger) => ledger.entries).some((entry) => entry.id === `payment:${agentReversal.id}`)).toBe(false)
        expect(agentLedger.flatMap((ledger) => ledger.entries).some((entry) => entry.id === `payment:${savedAgentSale.payments.find((payment) => !payment.reversalOfTransactionId)?.id}`)).toBe(true)
        expect(customerLedger.flatMap((ledger) => ledger.entries).some((entry) => entry.id === `payment:${customerReversal.id}`)).toBe(true)
      } finally {
        await observer.auth.signOut()
      }
      }, { retirePassedProduct: false })
    } finally {
      if (previousWorkspaceCache == null) localStorage.removeItem(workspaceCacheKey)
      else localStorage.setItem(workspaceCacheKey, previousWorkspaceCache)
    }
  }, 120_000)
})
