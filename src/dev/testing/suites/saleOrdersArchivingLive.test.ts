import { beforeAll, describe, expect, it } from 'vitest'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

type OrderTable = 'sales_orders' | 'purchase_orders'
type ArchiveKind = 'sales' | 'purchase'

async function readHostedOrder(client: Awaited<ReturnType<typeof freshLiveClient>>, table: OrderTable, id: string) {
    return requireLiveData<Record<string, unknown>>(
        await client.schema('crm').from(table).select('*').eq('id', id).single(),
        `${table} archive test order`
    )
}

async function expectDatabaseToRejectActiveArchive(
    client: Awaited<ReturnType<typeof freshLiveClient>>,
    table: OrderTable,
    id: string
) {
    const result = await client.schema('crm').from(table)
        .update({ is_archived: true })
        .eq('id', id)
        .select('id,is_archived')
        .maybeSingle()

    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('23514')
    expect(result.error?.message).toContain('order_archive_not_allowed')
    expect((await readHostedOrder(client, table, id)).is_archived).toBe(false)
}

async function expectFlagOnlyArchiveRoundTrip(
    client: Awaited<ReturnType<typeof freshLiveClient>>,
    table: OrderTable,
    kind: ArchiveKind,
    id: string
) {
    const { setOrderArchived } = await import('@/local-db/orderArchiving')
    const before = await readHostedOrder(client, table, id)

    await setOrderArchived(id, kind, true)
    const archived = await readHostedOrder(client, table, id)
    expect(archived).toEqual({ ...before, is_archived: true })

    await setOrderArchived(id, kind, false)
    expect(await readHostedOrder(client, table, id)).toEqual(before)
}

describe('Sale Orders · hosted archiving', () => {
    setupHostedSaleOrders()

    beforeAll(async () => {
        const client = await freshLiveClient()
        try {
            const [sales, purchases] = await Promise.all([
                client.schema('crm').from('sales_orders').select('is_archived').limit(0),
                client.schema('crm').from('purchase_orders').select('is_archived').limit(0)
            ])
            if (sales.error || purchases.error) throw new Error('hosted_order_archiving_schema_unavailable')
        } finally { await client.auth.signOut() }
    }, 120_000)

    it('rejects an active sales order at the database and archives a cancelled order by changing only the flag', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const order = await orders.createSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash'),
                customerName: partner.partnerName,
                notes: `${tag} sales archive`
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = order.id
            ids.salesOrderId = order.id
            recordLiveFixture(ids)

            const client = await freshLiveClient()
            try {
                await expectDatabaseToRejectActiveArchive(client, 'sales_orders', order.id)
                await orders.updateSalesOrderStatus(order.id, 'cancelled')

                const cancelled = await readHostedOrder(client, 'sales_orders', order.id)
                expect(cancelled).toMatchObject({ status: 'cancelled', is_archived: false })
                await expectFlagOnlyArchiveRoundTrip(client, 'sales_orders', 'sales', order.id)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)

    it('rejects an active purchase order at the database and archives a cancelled order by changing only the flag', async () => {
        await withLiveSaleOrderFixture(async ({ storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const partners = await import('@/local-db/businessPartners')
            const supplier = await partners.createBusinessPartner(liveWorkspaceId, {
                partnerName: `${tag} supplier`, phone: '', defaultCurrency: 'usd',
                creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'supplier'
            })
            ids.supplierId = supplier.id
            recordLiveFixture(ids)

            const orderInput: Parameters<typeof orders.createPurchaseOrder>[1] = {
                businessPartnerId: supplier.id,
                supplierId: supplier.id,
                supplierName: supplier.partnerName,
                destinationStorageId: storage.id,
                items: [{
                    id: crypto.randomUUID(),
                    productId: product.id,
                    storageId: storage.id,
                    productName: product.name,
                    productSku: product.sku,
                    unit: 'pcs',
                    quantity: 1,
                    inventoryQuantity: 1,
                    receivedQuantity: 1,
                    lineTotal: 100,
                    originalCurrency: 'usd',
                    originalUnitPrice: 100,
                    convertedUnitPrice: 100,
                    settlementCurrency: 'usd'
                }],
                subtotal: 100,
                discount: 0,
                total: 100,
                currency: 'usd',
                exchangeRate: null,
                exchangeRateSource: null,
                exchangeRateTimestamp: null,
                status: 'draft',
                isPaid: false,
                paymentStatus: 'unpaid',
                paidAmount: 0,
                balanceAmount: 100,
                paidAt: null,
                paymentMethod: 'cash',
                initialPaymentAmount: 0,
                linkedLoanId: null,
                isInstallmentBased: false,
                installmentCount: 0,
                notes: `${tag} purchase archive`
            }
            const order = await orders.createPurchaseOrder(liveWorkspaceId, orderInput, undefined, {
                requireRemoteConfirmation: true
            })
            ids.orderId = order.id
            ids.purchaseOrderId = order.id
            recordLiveFixture(ids)

            const client = await freshLiveClient()
            try {
                await expectDatabaseToRejectActiveArchive(client, 'purchase_orders', order.id)
                await orders.updatePurchaseOrderStatus(order.id, 'cancelled')

                const cancelled = await readHostedOrder(client, 'purchase_orders', order.id)
                expect(cancelled).toMatchObject({ status: 'cancelled', is_archived: false })
                await expectFlagOnlyArchiveRoundTrip(client, 'purchase_orders', 'purchase', order.id)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)

    it('archives a fully returned sales order while preserving its completed lifecycle status', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const order = await orders.createCompletedSalesOrder(liveWorkspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash', { paid: true }),
                customerName: partner.partnerName,
                notes: `${tag} returned sales archive`
            })
            ids.orderId = order.id
            ids.salesOrderId = order.id
            recordLiveFixture(ids)

            const returned = await orders.returnSalesOrder({
                orderId: order.id,
                items: [{ orderItemId: order.items[0].id, quantity: 1 }],
                reason: 'customer_returned',
                actorRole: 'admin'
            })
            ids.returnId = returned.return.id
            recordLiveFixture(ids)
            expect(returned.order).toMatchObject({ status: 'completed', returnStatus: 'full', isArchived: false })

            const client = await freshLiveClient()
            try {
                const before = await readHostedOrder(client, 'sales_orders', order.id)
                expect(before).toMatchObject({ status: 'completed', return_status: 'full', is_archived: false })
                await expectFlagOnlyArchiveRoundTrip(client, 'sales_orders', 'sales', order.id)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)
})
