import { describe, expect, it } from 'vitest'
import { writeWorkspaceCache } from '@/workspace/workspaceCache'
import { saleOrderInput } from '../fixtures/orderInput'
import { liveSupabase } from '../liveSupabase'
import {
  freshLiveClient,
  liveWorkspaceId,
  recordLiveFixture,
  requireLiveData,
  setupHostedOrderFixture,
  withLiveSaleOrderFixture
} from '../fixtures/orderLive'

setupHostedOrderFixture()

describe('Sales-account agent payment credit allocation · hosted Supabase', () => {
  it('nets persisted account credit oldest-first and collects only the adjusted loan balance', async () => {
    const workspaceCacheKey = `atlas_workspace_cache:v2:${liveWorkspaceId}`
    const previousWorkspaceCache = localStorage.getItem(workspaceCacheKey)
    writeWorkspaceCache({
      workspaceId: liveWorkspaceId,
      workspaceName: 'DEV TEST Atlas',
      features: { agent_sales_accounts: true }
    })
    try {
      await withLiveSaleOrderFixture(async ({ ids, storage, product, tag }) => {
        const partners = await import('@/local-db/businessPartners')
        const orders = await import('@/local-db/orders')
        const payments = await import('@/local-db/payments')
        const hooks = await import('@/local-db/hooks')
        const { db } = await import('@/local-db/database')
        const { fetchTableFromSupabase } = hooks
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
        const createAgentLoanOrder = async (key: string) => {
          const order = await orders.createQuickSalesOrder(liveWorkspaceId, {
            ...saleOrderInput(agentPartner.id, product, storage.id, 'loan', {
              currency: 'usd',
              unitPrice: 200
            }),
            status: 'pending',
            salesAccountAgentId: agentId,
            commissionEnabled: false,
            customerName: agentPartner.partnerName,
            notes: `${tag} ${key}`
          }, actorId, { actingUserRole: 'admin' })
          ids[key] = order.id
          recordLiveFixture(ids)
          if (!order.linkedLoanId) throw new Error(`hosted_agent_order_loan_missing:${key}`)
          ids[`${key}LoanId`] = order.linkedLoanId
          recordLiveFixture(ids)
          return order
        }

        const oldestOrder = await createAgentLoanOrder('oldestAgentOrderId')
        const newestOrder = await createAgentLoanOrder('newestAgentOrderId')
        const credit = await payments.recordDirectTransaction(liveWorkspaceId, {
          direction: 'incoming',
          amount: 250,
          currency: 'usd',
          paymentMethod: 'cash',
          paidAt: new Date().toISOString(),
          reason: `${tag} agent account credit`,
          businessPartnerId: agentPartner.id,
          partnerAccountEffect: 'decrease_receivable',
          createdBy: actorId
        })
        ids.accountCreditTransactionId = credit.id
        recordLiveFixture(ids)

        const sourceTables = [
          'business_partners', 'agents', 'loans', 'sales_orders', 'purchase_orders', 'loan_payments',
          'payment_transactions', 'order_returns', 'order_return_items', 'agent_commission_entries',
          'agent_product_commission_entries', 'installment_sales', 'partner_settlement_operations',
          'delivery_merchant_profiles', 'delivery_ledger_entries'
        ] as const
        for (const table of sourceTables) {
          if (!await fetchTableFromSupabase(table, db[table] as any, liveWorkspaceId, { force: true })) {
            throw new Error(`hosted_payment_source_hydration_failed:${table}`)
          }
        }

        const buildAgentReceivables = async () => (await payments.buildPaymentObligations(liveWorkspaceId, {
          direction: 'incoming',
          applySalesAgentAccountCredits: true
        })).filter((obligation) => (
          obligation.sourceType === 'simple_loan'
          && obligation.metadata?.businessPartnerId === agentPartner.id
          && [oldestOrder.id, newestOrder.id].includes(String(obligation.metadata?.orderId || ''))
        ))
        const netted = await buildAgentReceivables()
        expect(netted).toHaveLength(1)
        expect(netted[0]).toMatchObject({
          sourceRecordId: newestOrder.linkedLoanId,
          amount: 150,
          currency: 'usd',
          metadata: { salesAgentAccountCreditApplied: 50, orderId: newestOrder.id }
        })
        expect(netted.reduce((sum, row) => sum + row.amount, 0)).toBe(150)

        const newestLoanId = newestOrder.linkedLoanId
        if (!newestLoanId) throw new Error('hosted_newest_order_loan_missing')
        const newestLoan = await db.loans.get(newestLoanId)
        if (!newestLoan) throw new Error('hosted_newest_order_loan_cache_missing')
        // Inflate only the disposable browser cache to force the real RPC to
        // validate against Supabase's outstanding loan balance.
        await db.loans.put({ ...newestLoan, balanceAmount: 300 })
        await expect(hooks.recordLoanPayment(liveWorkspaceId, {
          loanId: newestLoan.id,
          amount: 201,
          paymentMethod: 'cash',
          paidAt: new Date().toISOString(),
          createdBy: actorId
        })).rejects.toThrow()

        const observer = await freshLiveClient()
        try {
          const rejectedPathLoan = requireLiveData<{ balance_amount: number }>(
            await observer.from('loans').select('balance_amount').eq('workspace_id', liveWorkspaceId).eq('id', newestLoan.id).single(),
            'loan after rejected overpayment'
          )
          const rejectedPathPayments = requireLiveData<unknown[]>(
            await observer.from('loan_payments').select('id').eq('workspace_id', liveWorkspaceId).eq('loan_id', newestLoan.id),
            'repayment records after rejected overpayment'
          )
          expect(Number(rejectedPathLoan.balance_amount)).toBe(200)
          expect(rejectedPathPayments).toHaveLength(0)
        } finally {
          await observer.auth.signOut()
        }

        if (!await fetchTableFromSupabase('loans', db.loans, liveWorkspaceId, { force: true })) {
          throw new Error('hosted_loan_refresh_after_rejection_failed')
        }
        const refreshedNetted = await buildAgentReceivables()
        expect(refreshedNetted).toHaveLength(1)
        expect(refreshedNetted[0].amount).toBe(150)
        await payments.recordObligationSettlement(liveWorkspaceId, refreshedNetted[0], {
          paymentMethod: 'cash',
          paidAt: new Date().toISOString(),
          createdBy: actorId
        })

        const fresh = await freshLiveClient()
        try {
          const [oldestLoan, newestSavedLoan, loanPayments, paymentTransactions] = await Promise.all([
            fresh.from('loans').select('balance_amount').eq('workspace_id', liveWorkspaceId).eq('id', oldestOrder.linkedLoanId!).single(),
            fresh.from('loans').select('balance_amount').eq('workspace_id', liveWorkspaceId).eq('id', newestLoan.id).single(),
            fresh.from('loan_payments').select('id,amount,payment_transaction_id').eq('workspace_id', liveWorkspaceId).eq('loan_id', newestLoan.id),
            fresh.from('payment_transactions').select('id,amount,source_type,source_record_id,direction').eq('workspace_id', liveWorkspaceId)
              .eq('source_type', 'simple_loan').eq('source_record_id', newestLoan.id).eq('is_deleted', false)
          ])
          const savedOldestLoan = requireLiveData<{ balance_amount: number }>(oldestLoan, 'oldest persisted loan')
          const savedNewestLoan = requireLiveData<{ balance_amount: number }>(newestSavedLoan, 'newest persisted loan')
          const savedLoanPayments = requireLiveData<Array<{ id: string; amount: number; payment_transaction_id: string }>>(loanPayments, 'persisted adjusted loan repayment')
          const savedTransactions = requireLiveData<Array<{ id: string; amount: number; source_type: string; source_record_id: string; direction: string }>>(paymentTransactions, 'persisted payment transaction')
          expect(Number(savedOldestLoan.balance_amount)).toBe(200)
          expect(Number(savedNewestLoan.balance_amount)).toBe(50)
          expect(savedLoanPayments).toHaveLength(1)
          expect(Number(savedLoanPayments[0].amount)).toBe(150)
          expect(savedTransactions).toHaveLength(1)
          expect(savedTransactions[0]).toMatchObject({
            id: savedLoanPayments[0].payment_transaction_id,
            amount: 150,
            source_type: 'simple_loan',
            source_record_id: newestLoan.id,
            direction: 'incoming'
          })
        } finally {
          await fresh.auth.signOut()
        }

        for (const table of ['loans', 'loan_payments', 'payment_transactions'] as const) {
          if (!await fetchTableFromSupabase(table, db[table] as any, liveWorkspaceId, { force: true })) {
            throw new Error(`hosted_post_collection_hydration_failed:${table}`)
          }
        }
        expect(await buildAgentReceivables()).toHaveLength(0)
        const finalBalance = await payments.getPartnerSettlementBalance(liveWorkspaceId, agentPartner.id, 'incoming')
        expect(finalBalance.total).toBe(0)
        expect(finalBalance.items).toBe(0)
      }, { retirePassedProduct: false })
    } finally {
      if (previousWorkspaceCache == null) localStorage.removeItem(workspaceCacheKey)
      else localStorage.setItem(workspaceCacheKey, previousWorkspaceCache)
    }
  }, 120_000)
})
