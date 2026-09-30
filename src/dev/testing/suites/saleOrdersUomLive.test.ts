import { describe, expect, it } from 'vitest'
import { saleOrderInput } from '../fixtures/saleOrder'
import type { LiveSaleOrderFixture } from '../fixtures/saleOrdersLive'
import type { ProductUom } from '@/local-db/models'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

async function withLiveProductUomFixture<T>(scenario: (fixture: LiveSaleOrderFixture & { carton: ProductUom }) => Promise<T>) {
    return withLiveSaleOrderFixture(async (fixture) => {
        const { replaceProductUoms } = await import('@/local-db/productUoms')
        const uoms = await replaceProductUoms(liveWorkspaceId, fixture.product.id, [
            { unitRef: `builtin:${fixture.product.unit.toLowerCase()}`, unitCode: fixture.product.unit,
                coefficient: 1, isBase: true, isActive: true, isDefaultSelling: false,
                sellingPrice: fixture.product.price, costPrice: fixture.product.costPrice,
                minimumSellingPrice: null },
            { unitRef: 'builtin:carton', unitCode: 'carton', coefficient: 20, isBase: false,
                isActive: true, isDefaultSelling: true, sellingPrice: 40, costPrice: 20,
                minimumSellingPrice: 35 },
        ])
        const uom = uoms.find((row) => row.unitCode === 'carton')
        if (!uom) throw new Error('product_uom_fixture_missing')
        fixture.ids.uomId = uom.id
        recordLiveFixture(fixture.ids)
        return scenario({ ...fixture, carton: uom })
    }, { stock: 100, price: 2, costPrice: 1, unit: 'pcs' })
}

describe('Sale Orders · hosted product UoM conversion', () => {
    setupHostedSaleOrders()

    it('completes a paid carton order with free cartons, then returns both using the saved coefficient', async () => {
        await withLiveProductUomFixture(async ({ partner, storage, product, ids, tag, carton }) => {
            const orders = await import('@/local-db/orders')
            const input = saleOrderInput(partner.id, product, storage.id, 'cash', {
                quantity: 2, unitPrice: 40, paid: true
            })
            input.items[0] = {
                ...input.items[0], unit: 'carton', uomId: carton.id, uomNameSnapshot: 'carton',
                unitRef: carton.unitRef, unitNameSnapshot: 'carton', baseUnitRef: 'builtin:pcs',
                baseUnitCode: 'pcs', baseUnitNameSnapshot: 'pcs', unitFactor: 20,
                minimumSellingPriceSnapshot: 35, uomCostPrice: 20, convertedUomCostPrice: 20,
                costPrice: 20, convertedCostPrice: 20, freeBonusQuantity: 1,
                inventoryQuantity: 40, freeBonusInventoryQuantity: 20,
                quantity: 2, lineTotal: 80, originalUnitPrice: 40, convertedUnitPrice: 40,
            }
            input.subtotal = input.total = input.paidAmount = 80
            input.balanceAmount = 0
            const draft = await orders.createSalesOrder(liveWorkspaceId, {
                ...input, customerName: partner.partnerName, notes: tag
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = draft.id
            recordLiveFixture(ids)
            await orders.updateSalesOrderStatus(draft.id, 'pending')
            const order = await orders.updateSalesOrderStatus(draft.id, 'completed')
            const before = await freshLiveClient()
            try {
                const saved = requireLiveData(await before.schema('crm').from('sales_orders')
                    .select('status,items,total,paid_amount').eq('id', order.id).single(), 'carton order')
                const stock = requireLiveData(await before.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'carton stock')
                expect(saved.status).toBe('completed')
                expect(saved.items[0]).toMatchObject({
                    uomId: carton.id, unitFactor: 20, inventoryQuantity: 40,
                    freeBonusInventoryQuantity: 20, uomCostPrice: 20,
                })
                expect(Number(saved.total)).toBe(80)
                expect(Number(saved.paid_amount)).toBe(80)
                expect(Number(stock.quantity)).toBe(40)
            } finally { await before.auth.signOut() }

            const returned = await orders.returnSalesOrder({
                orderId: order.id,
                items: [{ orderItemId: order.items[0].id, paidQuantity: 2, freeQuantity: 1 }],
                reason: 'customer_returned', actorRole: 'admin'
            })
            ids.returnId = returned.return.id
            recordLiveFixture(ids)
            const fresh = await freshLiveClient()
            try {
                const stock = requireLiveData(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'returned carton stock')
                const payments = requireLiveData<Array<{ id: string; amount: number; reversal_of_transaction_id: string | null }>>(await fresh.from('payment_transactions')
                    .select('id,amount,reversal_of_transaction_id').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'carton payments')
                expect(Number(stock.quantity)).toBe(100)
                expect(payments.reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(0, 3)
                for (const original of payments.filter((row) => Number(row.amount) > 0)) {
                    expect(payments.filter((row) => row.reversal_of_transaction_id === original.id)
                        .reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(-Number(original.amount), 3)
                }
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)

    it('completes a paid Quick Order with a non-base UoM and converts its stock demand', async () => {
        await withLiveProductUomFixture(async ({ partner, storage, product, ids, tag, carton }) => {
            if (!partner.customerFacetId) throw new Error('product-uom fixture customer facet missing')
            const orders = await import('@/local-db/orders')
            const input = saleOrderInput(partner.id, product, storage.id, 'cash', {
                quantity: 2, unitPrice: 40, paid: true
            })
            input.items[0] = {
                ...input.items[0], unit: 'carton', uomId: carton.id, uomNameSnapshot: 'carton',
                unitRef: carton.unitRef, unitNameSnapshot: 'carton', baseUnitRef: 'builtin:pcs',
                baseUnitCode: 'pcs', baseUnitNameSnapshot: 'pcs', unitFactor: 20,
                minimumSellingPriceSnapshot: 35, uomCostPrice: 20, convertedUomCostPrice: 20,
                costPrice: 20, convertedCostPrice: 20, inventoryQuantity: 40,
                freeBonusQuantity: 1, freeBonusInventoryQuantity: 20,
                lineTotal: 80, originalUnitPrice: 40, convertedUnitPrice: 40,
            }
            input.subtotal = input.total = input.paidAmount = 80
            input.balanceAmount = 0
            const order = await orders.createCompletedSalesOrder(liveWorkspaceId, {
                ...input, customerName: partner.partnerName, notes: tag
            })
            ids.orderId = order.id
            recordLiveFixture(ids)
            const fresh = await freshLiveClient()
            try {
                const saved = requireLiveData(await fresh.schema('crm').from('sales_orders')
                    .select('status,items,total,paid_amount').eq('id', order.id).single(), 'Quick Order')
                const stock = requireLiveData(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'Quick Order stock')
                expect(saved.status).toBe('completed')
                expect(saved.items[0]).toMatchObject({ uomId: carton.id, unitFactor: 20, inventoryQuantity: 40 })
                expect(Number(saved.total)).toBe(80)
                expect(Number(saved.paid_amount)).toBe(80)
                expect(Number(stock.quantity)).toBe(40)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
