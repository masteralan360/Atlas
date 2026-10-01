import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { runModuleWideIntegrityAudit } from '@/lib/integrityAudit/moduleWide'
import { createSalesOrderModuleWideIntegrityAuditAdapter } from '@/lib/integrityAudit/salesOrderModuleWide'
import { runSalesOrderIntegrityAudit } from '@/lib/integrityAudit/salesOrderAudit'
import { liveSupabase } from '../liveSupabase'
import { liveWorkspaceId, requireLiveData, setupHostedSaleOrders, withLiveSaleOrderFixture } from '../fixtures/saleOrdersLive'
import { saleOrderInput } from '../fixtures/saleOrder'

describe('Sale Orders · hosted module-wide integrity audit', () => {
  setupHostedSaleOrders()

  it('audits every supplied filtered order through the existing audit and leaves persisted records unchanged', async () => {
    await withLiveSaleOrderFixture(async fixture => {
      const { createSalesOrder } = await import('@/local-db/orders')
      const orders = await Promise.all([0, 1].map(index => createSalesOrder(
        liveWorkspaceId,
        {
          ...saleOrderInput(fixture.partner.id, fixture.product, fixture.storage.id, 'cash'),
          notes: `${fixture.tag} module-wide ${index}`
        },
        undefined,
        { requireRemoteConfirmation: true }
      )))
      const orderIds = orders.map(order => order.id)
      const observer = liveSupabase
      const persistedBefore = requireLiveData<Array<{ id: string; workspace_id: string; order_number: string; status: string }>>(
        await observer.schema('crm').from('sales_orders').select('id,workspace_id,order_number,status')
          .eq('workspace_id', liveWorkspaceId).in('id', orderIds),
        'module-wide audit persisted orders before run'
      )
      expect(persistedBefore.map(row => row.id).sort()).toEqual([...orderIds].sort())
      const paymentsBefore = requireLiveData<Array<{ id: string }>>(
        await observer.from('payment_transactions').select('id').eq('workspace_id', liveWorkspaceId)
          .in('source_record_id', orderIds).order('id'),
        'module-wide audit payment records before run'
      )

      const adapter = createSalesOrderModuleWideIntegrityAuditAdapter(liveWorkspaceId, 'cloud')
      const summaries = await runModuleWideIntegrityAudit(orders, adapter)
      const individualAudits = await Promise.all(orders.map(order =>
        runSalesOrderIntegrityAudit(liveWorkspaceId, order.id, 'cloud')
      ))
      expect(summaries.map(row => ({
        id: row.transactionId,
        reference: row.transactionReference,
        passed: row.passed,
        warnings: row.warnings,
        failed: row.failed,
        status: row.status
      }))).toEqual(orders.map((order, index) => ({
        id: order.id,
        reference: order.orderNumber,
        passed: individualAudits[index].summary.passed,
        warnings: individualAudits[index].summary.warnings,
        failed: individualAudits[index].summary.failed,
        status: individualAudits[index].summary.failed > 0 ? 'FAIL'
          : individualAudits[index].summary.warnings > 0 ? 'WARNING' : 'PASS'
      })))
      expect(summaries.map(row => row.transactionReference).sort()).toEqual(persistedBefore.map(row => row.order_number).sort())

      const persistedAfter = requireLiveData<Array<{ id: string; workspace_id: string; order_number: string; status: string }>>(
        await observer.schema('crm').from('sales_orders').select('id,workspace_id,order_number,status')
          .eq('workspace_id', liveWorkspaceId).in('id', orderIds),
        'module-wide audit persisted orders after run'
      )
      const paymentsAfter = requireLiveData<Array<{ id: string }>>(
        await observer.from('payment_transactions').select('id').eq('workspace_id', liveWorkspaceId)
          .in('source_record_id', orderIds).order('id'),
        'module-wide audit payment records after run'
      )
      expect(persistedAfter).toEqual(persistedBefore)
      expect(paymentsAfter).toEqual(paymentsBefore)
      expect((await db.sales_orders.where('id').anyOf(orderIds).toArray()).map(order => order.id).sort()).toEqual([...orderIds].sort())
    }, { retirePassedProduct: false })
  }, 120_000)
})
