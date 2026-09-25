import { describe, expect, it } from 'vitest'
import type { Product, BusinessPartner, Storage, Unit, UnitRelationship } from '@/local-db/models'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

type RelatedUnitFixture = {
    partner: BusinessPartner
    storage: Storage
    product: Product
    ids: Record<string, string | null>
    tag: string
    parent: Unit
    child: Unit
    relationship: UnitRelationship
}

async function withLiveRelatedUnitFixture<T>(scenario: (fixture: RelatedUnitFixture) => Promise<T>): Promise<T> {
    const hooks = await import('@/local-db/hooks')
    const units = await import('@/local-db/unitRelationships')
    const code = crypto.randomUUID().slice(0, 8)
    const parent = await hooks.createUnit(liveWorkspaceId, { code: `dtp${code}`, icon: 'Package', isDynamic: false })
    const child = await hooks.createUnit(liveWorkspaceId, { code: `dtc${code}`, icon: 'Package', isDynamic: false })
    const unitIds: Record<string, string | null> = { parentUnitId: parent.id, childUnitId: child.id }
    recordLiveFixture(unitIds)
    const relationship = await units.saveUnitRelationship(liveWorkspaceId, {
        name: `DEV TEST ${code} packs`, parentUnitRef: `custom:${parent.id}`,
        parentUnitCode: parent.code, childUnitRef: `custom:${child.id}`, childUnitCode: child.code
    })
    unitIds.relationshipId = relationship.id
    recordLiveFixture(unitIds)
    return withLiveSaleOrderFixture(async (fixture) => {
        Object.assign(fixture.ids, unitIds)
        const conversion = await units.replaceProductUnitConversion(liveWorkspaceId, fixture.product.id, {
            relationshipId: relationship.id, factor: 20, parentPrice: 40, childIsDynamic: false
        })
        fixture.ids.conversionId = conversion?.id ?? null
        recordLiveFixture(fixture.ids)
        return scenario({ ...fixture, parent, child, relationship })
    }, { stock: 100, price: 2, costPrice: 1, unit: child.code })
}

describe('Sale Orders · hosted related units', () => {
    setupHostedSaleOrders()

    it('completes a regular paid Sale Order with paid and free packs, then returns both in base stock', async () => {
        await withLiveRelatedUnitFixture(async ({ partner, storage, product, ids, tag, parent, child, relationship }) => {
            const orders = await import('@/local-db/orders')
            const input = saleOrderInput(partner.id, product, storage.id, 'cash', {
                quantity: 2, unitPrice: 40, paid: true
            })
            input.items[0] = {
                ...input.items[0], unit: parent.code, unitRelationshipId: relationship.id,
                unitRef: `custom:${parent.id}`, unitNameSnapshot: parent.code,
                baseUnitRef: `custom:${child.id}`, baseUnitCode: child.code,
                baseUnitNameSnapshot: child.code, unitFactor: 20,
                freeBonusQuantity: 1, inventoryQuantity: 40, freeBonusInventoryQuantity: 20,
                quantity: 2, lineTotal: 80, originalUnitPrice: 40, convertedUnitPrice: 40
            }
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
                    .select('status,items,total,paid_amount').eq('id', order.id).single(), 'pack order')
                const stock = requireLiveData(await before.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'pack stock')
                expect(saved.status).toBe('completed')
                expect(saved.items[0]).toMatchObject({ unitFactor: 20, inventoryQuantity: 40, freeBonusInventoryQuantity: 20 })
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
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'returned pack stock')
                const payments = requireLiveData<Array<{ id: string; amount: number; reversal_of_transaction_id: string | null }>>(await fresh.from('payment_transactions')
                    .select('id,amount,reversal_of_transaction_id').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', order.id), 'pack payments')
                expect(Number(stock.quantity)).toBe(100)
                expect(payments.reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(0, 3)
                for (const original of payments.filter((row) => Number(row.amount) > 0)) {
                    expect(payments.filter((row) => row.reversal_of_transaction_id === original.id)
                        .reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(-Number(original.amount), 3)
                }
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)

    it('rejects a related-unit Quick Order at the RPC without creating an order, payment, or stock movement', async () => {
        await withLiveRelatedUnitFixture(async ({ partner, storage, product }) => {
            if (!partner.customerFacetId) throw new Error('related-unit fixture customer facet missing')
            const orderId = crypto.randomUUID()
            const client = await freshLiveClient()
            try {
                const { error } = await client.rpc('complete_quick_sales_order', { payload: {
                    order: {
                        id: orderId, workspace_id: liveWorkspaceId,
                        customer_id: partner.customerFacetId, business_partner_id: partner.id,
                        source_storage_id: storage.id, status: 'completed',
                        items: [{ productId: product.id, quantity: 2, freeBonusQuantity: 1 }],
                        total: 80, paid_amount: 80, balance_amount: 0,
                        payment_status: 'paid', is_paid: true, payment_method: 'cash'
                    },
                    payment: null
                } })
                expect(error?.message).toContain('quick_order_related_units_unsupported')
                const { data: order, error: orderLookupError } = await client.schema('crm').from('sales_orders')
                    .select('id').eq('id', orderId).maybeSingle()
                const payments = requireLiveData<Array<{ id: string }>>(await client.from('payment_transactions')
                    .select('id').eq('workspace_id', liveWorkspaceId)
                    .eq('source_type', 'sales_order').eq('source_record_id', orderId), 'rejected pack payments')
                const stock = requireLiveData(await client.from('inventory')
                    .select('quantity').eq('workspace_id', liveWorkspaceId)
                    .eq('product_id', product.id).eq('storage_id', storage.id).single(), 'rejected pack stock')
                expect(orderLookupError).toBeNull()
                expect(order).toBeNull()
                expect(payments).toHaveLength(0)
                expect(Number(stock.quantity)).toBe(100)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)
})
