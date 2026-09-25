import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SalesOrder } from '@/local-db/models'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

describe('Sale Orders · hosted printing source', () => {
    setupHostedSaleOrders()

    it('renders the order template using line items reloaded from hosted Supabase', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const { createCustomTemplatePreview, getCustomTemplateTarget, ORDER_DETAILS_TEMPLATE_KEY } = await import('@/lib/customTemplates')
            const { toCamelCase } = await import('@/lib/utils')
            const order = await orders.createCompletedSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash', { paid: true }),
                customerName: partner.partnerName, notes: tag
            })
            ids.orderId = order.id
            recordLiveFixture(ids)

            const fresh = await freshLiveClient()
            try {
                const saved = requireLiveData<{ id: string; items: unknown; order_number: string }>(
                    await fresh.schema('crm').from('sales_orders')
                        .select('id,items,order_number').eq('id', order.id).single(), 'print source order')
                expect(Array.isArray(saved.items)).toBe(true)
                const items = (saved.items as Record<string, unknown>[]).map((item) => toCamelCase(item)) as unknown as SalesOrder['items']
                expect(items).toHaveLength(1)
                expect(items[0].productName).toBe(product.name)
                const target = getCustomTemplateTarget(ORDER_DETAILS_TEMPLATE_KEY)
                expect(target).toBeDefined()
                const preview = createCustomTemplatePreview(target!, {
                    printLang: 'en', order: { ...order, items, orderNumber: saved.order_number }, orderKind: 'sales'
                })
                const html = renderToStaticMarkup(preview.createElement({}))
                expect(html).toContain(product.name)
                expect(html).toContain(saved.order_number)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
