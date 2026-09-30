import { describe, expect, it } from 'vitest'
import { v5 as uuidv5 } from 'uuid'
import type { CurrencyCode, Product, SalesOrderItem } from '@/local-db/models'
import { saleOrderInput } from '../fixtures/saleOrder'
import {
    freshLiveClient, liveWorkspaceId, recordLiveFixture, requireLiveData,
    setupHostedSaleOrders, withLiveSaleOrderFixture
} from '../fixtures/saleOrdersLive'

const completionOperationNamespace = '29a34eb1-80c0-5cf9-8bc1-0bbb71fd718b'
const hostedServicesEnabled = process.env.ATLAS_LIVE_SERVICES_ENABLED === 'true'

type RawSalesOrder = {
    id: string
    status: string
    version: number
    items: Array<Record<string, any>>
    actual_delivery_date: string | null
    paid_amount: number
    balance_amount: number
    approval_status: string | null
    currency?: CurrencyCode
    linked_loan_id?: string | null
    payment_method?: string
    payment_status?: string
}

type InventoryPosition = {
    id: string
    productId: string
    storageId: string
    quantity: number
    version: number
}

type CompletionRpcPayload = {
    p_order_id: string
    p_workspace_id: string
    p_expected_order_version: number
    p_operation_id: string
    p_items: Array<Record<string, any>>
    p_actual_delivery_date: string
    p_changes: Array<Record<string, unknown>>
}

function requireRpcError(result: { error: { code?: string; message: string } | null }, code: string) {
    if (!result.error) throw new Error(`Expected RPC error ${code}, but the completion RPC succeeded`)
    if (result.error.code !== code) {
        throw new Error(`Expected RPC error ${code}, received ${result.error.code || '(no code)'}: ${result.error.message}`)
    }
    return result.error!
}

async function readOrder(client: Awaited<ReturnType<typeof freshLiveClient>>, orderId: string) {
    return requireLiveData<RawSalesOrder>(await client.schema('crm').from('sales_orders')
        .select('id,status,version,items,actual_delivery_date,paid_amount,balance_amount,approval_status,currency,linked_loan_id,payment_method,payment_status')
        .eq('id', orderId).single(), 'completion test order')
}

async function readInventoryPosition(
    client: Awaited<ReturnType<typeof freshLiveClient>>,
    productId: string,
    storageId: string
): Promise<InventoryPosition> {
    const row = requireLiveData<{ id: string; quantity: number; version: number }>(await client.from('inventory')
        .select('id,quantity,version').eq('workspace_id', liveWorkspaceId)
        .eq('product_id', productId).eq('storage_id', storageId).single(), 'completion test inventory')
    return { id: row.id, productId, storageId, quantity: Number(row.quantity), version: Number(row.version) }
}

async function readPaymentRows(client: Awaited<ReturnType<typeof freshLiveClient>>, orderId: string) {
    return requireLiveData<Array<Record<string, unknown>>>(await client.from('payment_transactions')
        .select('id,amount,currency,reversal_of_transaction_id,account_id,source_record_id')
        .eq('workspace_id', liveWorkspaceId).eq('source_type', 'sales_order')
        .eq('source_record_id', orderId).order('id'), 'completion test payment ledger')
}

async function readLoanPaymentRows(client: Awaited<ReturnType<typeof freshLiveClient>>, loanId: string) {
    return requireLiveData<Array<Record<string, unknown>>>(await client.from('payment_transactions')
        .select('id,amount,currency,reversal_of_transaction_id,account_id,source_record_id,source_subrecord_id,source_type,direction,payment_method,metadata')
        .eq('workspace_id', liveWorkspaceId).eq('source_module', 'loans')
        .eq('source_record_id', loanId).order('id'), 'completion test loan payment ledger')
}

async function readLoanRepayments(client: Awaited<ReturnType<typeof freshLiveClient>>, loanId: string) {
    return requireLiveData<Array<{
        id: string
        amount: number | string
        sequence_no: number | null
        payment_transaction_id: string | null
        integrity_version: number
    }>>(await client.from('loan_payments')
        .select('id,amount,sequence_no,payment_transaction_id,integrity_version')
        .eq('workspace_id', liveWorkspaceId).eq('loan_id', loanId).order('sequence_no'),
    'completion test loan repayments')
}

async function readAccountMovements(client: Awaited<ReturnType<typeof freshLiveClient>>, accountId: string) {
    return requireLiveData<Array<Record<string, unknown>>>(await client.schema('payment_accounts').from('account_movements')
        .select('id,payment_transaction_id,amount,delta_amount').eq('account_id', accountId).order('id'),
    'completion test account movements')
}

async function readSaleTransactions(client: Awaited<ReturnType<typeof freshLiveClient>>, orderId: string) {
    return requireLiveData<Array<{ id: string; product_id: string; storage_id: string; quantity_delta: number; previous_quantity: number; new_quantity: number }>>(
        await client.from('inventory_transactions')
            .select('id,product_id,storage_id,quantity_delta,previous_quantity,new_quantity')
            .eq('workspace_id', liveWorkspaceId).eq('reference_type', 'sales_order')
            .eq('reference_id', orderId).eq('transaction_type', 'sale'),
        'completion test sale movements'
    )
}

async function readStockBatches(
    client: Awaited<ReturnType<typeof freshLiveClient>>,
    productId: string,
    storageId: string
) {
    const rows = requireLiveData<Array<{
        id: string
        batch_number: string
        quantity: number | string
        is_deleted: boolean
        expiry_date: string | null
    }>>(await client.from('stock_batches')
        .select('id,batch_number,quantity,is_deleted,expiry_date')
        .eq('workspace_id', liveWorkspaceId).eq('product_id', productId).eq('storage_id', storageId)
        .order('expiry_date').order('batch_number'), 'completion test stock batches')
    return rows.map((row) => ({ ...row, quantity: Number(row.quantity) }))
}

async function createPaidDraftOrder(
    partnerId: string,
    partnerName: string,
    product: Product,
    storageId: string,
    tag: string,
    options: { quantity?: number; approvalRequested?: boolean; currency?: CurrencyCode } = {}
) {
    const orders = await import('@/local-db/orders')
    return orders.createSalesOrder(liveWorkspaceId, {
        ...saleOrderInput(partnerId, product, storageId, 'cash', {
            quantity: options.quantity ?? 1,
            currency: options.currency,
            paid: true
        }),
        customerName: partnerName,
        notes: tag,
        ...(options.approvalRequested ? {
            approvalStatus: 'requested' as const,
            approvalRequestedAt: new Date().toISOString()
        } : {})
    }, undefined, { requireRemoteConfirmation: true })
}

async function createExtraPhysicalProduct(
    tag: string,
    storage: { id: string; name: string },
    options: { stock?: number; price?: number } = {}
) {
    const hooks = await import('@/local-db/hooks')
    return hooks.createProduct(liveWorkspaceId, {
        sku: `DT-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} second product`, description: '',
        categoryId: null, category: null, storageId: storage.id, storageName: storage.name,
        price: options.price ?? 100, costPrice: 40, quantity: options.stock ?? 10,
        minStockLevel: 0, unit: 'pcs', currency: 'usd', barcode: '', barcodes: [], imageUrl: '',
        canBeReturned: true, returnRules: '', createdBy: null, isService: false
    })
}

async function createServiceProduct(tag: string) {
    const hooks = await import('@/local-db/hooks')
    return hooks.createProduct(liveWorkspaceId, {
        sku: '', name: `${tag} service`, description: '', categoryId: null, category: null,
        storageId: null, storageName: undefined, price: 50, costPrice: 0, quantity: 0,
        minStockLevel: 0, unit: '', currency: 'usd', barcode: '', barcodes: [], imageUrl: '',
        canBeReturned: false, returnRules: '', createdBy: null, isService: true
    })
}

function makeServiceLine(
    partnerId: string,
    product: Product,
    fallbackStorageId: string,
    quantity: number,
    unitPrice: number
): SalesOrderItem {
    const input = saleOrderInput(partnerId, product, fallbackStorageId, 'cash', { quantity, unitPrice })
    return {
        ...input.items[0],
        id: crypto.randomUUID(),
        storageId: null,
        costPrice: 0,
        convertedCostPrice: 0,
        reservedQuantity: 0,
        fulfilledQuantity: 0,
        batchAllocations: null
    }
}

function completionPayload(
    order: RawSalesOrder,
    positions: InventoryPosition[],
    serviceProductIds: ReadonlySet<string> = new Set(),
    actualDeliveryDate = new Date().toISOString()
): CompletionRpcPayload {
    const lineInventoryQuantity = (item: Record<string, any>) => {
        const factor = Number(item.unitFactor || 1)
        const paid = item.inventoryQuantity == null
            ? Number(item.quantity || 0) * factor
            : Number(item.inventoryQuantity)
        const free = item.freeBonusInventoryQuantity == null
            ? Number(item.freeBonusQuantity ?? item.freeQuantity ?? 0) * factor
            : Number(item.freeBonusInventoryQuantity)
        return Math.round((paid + free) * 1_000_000) / 1_000_000
    }
    const items = order.items.map((item) => {
        const fulfilled = serviceProductIds.has(String(item.productId)) ? 0 : lineInventoryQuantity(item)
        return { ...item, reservedQuantity: fulfilled, fulfilledQuantity: fulfilled }
    })
    const changes = positions.map((position) => {
        const quantity = order.items
            .filter((item) => item.productId === position.productId && item.storageId === position.storageId)
            .reduce((sum, item) => sum + lineInventoryQuantity(item), 0)
        return {
            id: position.id,
            product_id: position.productId,
            storage_id: position.storageId,
            quantity: Math.round((position.quantity - quantity) * 1_000_000) / 1_000_000,
            expected_version: position.version,
            audit_transaction_type: null,
            audit_reference_id: null,
            audit_reference_type: null,
            audit_notes: null,
            audit_created_by: null
        }
    })
    return {
        p_order_id: order.id,
        p_workspace_id: liveWorkspaceId,
        p_expected_order_version: Number(order.version),
        p_operation_id: uuidv5(order.id, completionOperationNamespace),
        p_items: items,
        p_actual_delivery_date: actualDeliveryDate,
        p_changes: changes
    }
}

describe('Sale Orders · hosted completion integrity', () => {
    setupHostedSaleOrders()

    it.skipIf(!hostedServicesEnabled)('completes a paid all-service order with an empty inventory delta and replays its receipt', async () => {
        const serviceTag = `DEV TEST ${crypto.randomUUID().slice(0, 8)}`
        const serviceProduct = await createServiceProduct(serviceTag)
        const serviceFixtureIds: Record<string, string | null> = {
            partnerId: null, storageId: null, productId: null, serviceProductId: serviceProduct.id, orderId: null
        }
        recordLiveFixture(serviceFixtureIds)
        let serviceScenarioPassed = false
        try {
            await withLiveSaleOrderFixture(async ({ partner, storage, ids, tag }) => {
                const orders = await import('@/local-db/orders')
                ids.serviceProductId = serviceProduct.id
                recordLiveFixture(ids)
                const input = saleOrderInput(partner.id, serviceProduct, storage.id, 'cash', { paid: true })
                const draft = await orders.createSalesOrder(liveWorkspaceId, {
                    ...input,
                    customerName: partner.partnerName,
                    notes: tag,
                    sourceStorageId: null,
                    items: input.items.map((item) => ({ ...item, storageId: null }))
                }, undefined, { requireRemoteConfirmation: true })
                ids.orderId = draft.id
                recordLiveFixture(ids)
                const pending = await orders.updateSalesOrderStatus(draft.id, 'pending')

                const before = await freshLiveClient()
                let pendingRow: RawSalesOrder
                let paymentsBefore: Array<Record<string, unknown>>
                try {
                    pendingRow = await readOrder(before, draft.id)
                    paymentsBefore = await readPaymentRows(before, draft.id)
                    expect(pendingRow.status).toBe('pending')
                    expect(paymentsBefore.length).toBeGreaterThan(0)
                } finally { await before.auth.signOut() }

                const completed = await orders.updateSalesOrderStatus(pending.id, 'completed')
                expect(completed.status).toBe('completed')

                const fresh = await freshLiveClient()
                try {
                    const saved = await readOrder(fresh, draft.id)
                    const saleTransactions = await readSaleTransactions(fresh, draft.id)
                    const paymentsAfter = await readPaymentRows(fresh, draft.id)
                    expect(saved.status).toBe('completed')
                    expect(saved.actual_delivery_date).toBeTruthy()
                    expect(saleTransactions).toHaveLength(0)
                    expect(paymentsAfter).toEqual(paymentsBefore)

                    const replay = await fresh.rpc('complete_sales_order_with_inventory', {
                        p_order_id: draft.id,
                        p_workspace_id: liveWorkspaceId,
                        p_expected_order_version: Number(pendingRow!.version),
                        p_operation_id: uuidv5(draft.id, completionOperationNamespace),
                        p_items: saved.items,
                        p_actual_delivery_date: saved.actual_delivery_date,
                        p_changes: []
                    })
                    expect(replay.error).toBeNull()
                    expect(replay.data).toMatchObject({ already_applied: true })
                    expect(replay.data.order.id).toBe(draft.id)
                    expect(await readSaleTransactions(fresh, draft.id)).toHaveLength(0)
                } finally { await fresh.auth.signOut() }
            })
            serviceScenarioPassed = true
        } finally {
            if (serviceScenarioPassed) {
                const hooks = await import('@/local-db/hooks')
                try { await hooks.deleteProduct(serviceProduct.id) }
                catch { serviceScenarioPassed = false }
            }
            recordLiveFixture(serviceFixtureIds, serviceScenarioPassed ? 'service-product-retired' : 'retained')
        }
    }, 120_000)

    it.skipIf(!hostedServicesEnabled)('completes a mixed service and stocked order while posting inventory only for the physical line', async () => {
        const serviceTag = `DEV TEST ${crypto.randomUUID().slice(0, 8)}`
        const serviceProduct = await createServiceProduct(serviceTag)
        const serviceFixtureIds: Record<string, string | null> = {
            partnerId: null, storageId: null, productId: null, serviceProductId: serviceProduct.id, orderId: null
        }
        recordLiveFixture(serviceFixtureIds)
        let scenarioPassed = false
        try {
            await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
                const orders = await import('@/local-db/orders')
                ids.serviceProductId = serviceProduct.id
                recordLiveFixture(ids)
                const physicalInput = saleOrderInput(partner.id, product, storage.id, 'cash', { paid: true })
                const serviceLine = makeServiceLine(partner.id, serviceProduct, storage.id, 1, 50)
                const items = [...physicalInput.items, serviceLine]
                const total = items.reduce((sum, item) => sum + item.lineTotal, 0)
                const draft = await orders.createSalesOrder(liveWorkspaceId, {
                    ...physicalInput,
                    items,
                    subtotal: total,
                    total,
                    paidAmount: total,
                    balanceAmount: 0,
                    isPaid: true,
                    paymentStatus: 'paid',
                    paidAt: new Date().toISOString(),
                    customerName: partner.partnerName,
                    notes: tag
                }, undefined, { requireRemoteConfirmation: true })
                ids.orderId = draft.id
                recordLiveFixture(ids)
                const pending = await orders.updateSalesOrderStatus(draft.id, 'pending')

                const before = await freshLiveClient()
                let paymentsBefore: Array<Record<string, unknown>>
                try {
                    expect((await readInventoryPosition(before, product.id, storage.id)).quantity).toBe(10)
                    paymentsBefore = await readPaymentRows(before, draft.id)
                } finally { await before.auth.signOut() }

                const completed = await orders.updateSalesOrderStatus(pending.id, 'completed')
                expect(completed.status).toBe('completed')
                const fresh = await freshLiveClient()
                try {
                    const saved = await readOrder(fresh, draft.id)
                    const stock = await readInventoryPosition(fresh, product.id, storage.id)
                    const saleTransactions = await readSaleTransactions(fresh, draft.id)
                    expect(saved.status).toBe('completed')
                    expect(stock.quantity).toBe(9)
                    expect(saleTransactions).toHaveLength(1)
                    expect(saleTransactions[0]).toMatchObject({
                        product_id: product.id,
                        storage_id: storage.id,
                        quantity_delta: -1,
                        previous_quantity: 10,
                        new_quantity: 9
                    })
                    expect(saleTransactions.some((row) => row.product_id === serviceProduct.id)).toBe(false)
                    expect(saved.items).toEqual(expect.arrayContaining([
                        expect.objectContaining({ productId: product.id, reservedQuantity: 1, fulfilledQuantity: 1 }),
                        expect.objectContaining({ productId: serviceProduct.id, reservedQuantity: 0, fulfilledQuantity: 0 })
                    ]))
                    expect(await readPaymentRows(fresh, draft.id)).toEqual(paymentsBefore)
                } finally { await fresh.auth.signOut() }
            })
            scenarioPassed = true
        } finally {
            if (scenarioPassed) {
                const hooks = await import('@/local-db/hooks')
                try { await hooks.deleteProduct(serviceProduct.id) }
                catch { scenarioPassed = false }
            }
            recordLiveFixture(serviceFixtureIds, scenarioPassed ? 'service-product-retired' : 'retained')
        }
    }, 120_000)

    it('aggregates duplicate physical lines across inventory positions and preserves payment/account ledger entries', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const hooks = await import('@/local-db/hooks')
            const orders = await import('@/local-db/orders')
            const accounts = await import('@/local-db/paymentAccounts')
            const { db } = await import('@/local-db/database')
            const { fetchTableFromSupabase } = await import('@/local-db/hooks')
            if (!await fetchTableFromSupabase('payment_accounts', db.payment_accounts, liveWorkspaceId, { force: true })) {
                throw new Error('live_payment_account_hydration_failed')
            }

            const secondStorage = await hooks.createStorage(liveWorkspaceId, { name: `${tag} second storage` })
            ids.secondStorageId = secondStorage.id
            recordLiveFixture(ids)
            const secondProduct = await createExtraPhysicalProduct(tag, secondStorage)
            ids.secondProductId = secondProduct.id
            recordLiveFixture(ids)
            const account = await accounts.savePaymentAccount(liveWorkspaceId, {
                name: `${tag} payment account`, accountType: 'cash_drawer', iconKey: 'cash_drawer', openingBalances: []
            })
            ids.accountId = account.id
            recordLiveFixture(ids)

            const firstInput = saleOrderInput(partner.id, product, storage.id, 'cash', { paid: true })
            const secondInput = saleOrderInput(partner.id, secondProduct, secondStorage.id, 'cash', {
                paid: true, quantity: 4
            })
            const firstLine = firstInput.items[0]
            const duplicateFirstLine: SalesOrderItem = {
                ...firstLine, id: crypto.randomUUID(), quantity: 2, lineTotal: 200
            }
            const items = [firstLine, duplicateFirstLine, secondInput.items[0]]
            const total = items.reduce((sum, item) => sum + item.lineTotal, 0)
            const paidOrder = await orders.createSalesOrder(liveWorkspaceId, {
                ...firstInput,
                items,
                subtotal: total,
                total,
                paidAmount: total,
                balanceAmount: 0,
                isPaid: true,
                paymentStatus: 'paid',
                paidAt: new Date().toISOString(),
                initialPaymentAccountId: account.id,
                initialPaymentAccountNameSnapshot: account.name,
                customerName: partner.partnerName,
                notes: tag
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = paidOrder.id
            recordLiveFixture(ids)
            const pending = await orders.updateSalesOrderStatus(paidOrder.id, 'pending')

            const before = await freshLiveClient()
            let paymentsBefore: Array<Record<string, unknown>>
            let accountMovementsBefore: Array<Record<string, unknown>>
            try {
                paymentsBefore = await readPaymentRows(before, paidOrder.id)
                accountMovementsBefore = await readAccountMovements(before, account.id)
                const stockA = await readInventoryPosition(before, product.id, storage.id)
                const stockB = await readInventoryPosition(before, secondProduct.id, secondStorage.id)
                expect(stockA.quantity).toBe(10)
                expect(stockB.quantity).toBe(10)
                expect(paymentsBefore.length).toBeGreaterThan(0)
                expect(accountMovementsBefore.length).toBeGreaterThan(0)
            } finally { await before.auth.signOut() }

            const completed = await orders.updateSalesOrderStatus(pending.id, 'completed')
            expect(completed.status).toBe('completed')

            const fresh = await freshLiveClient()
            try {
                const saved = await readOrder(fresh, paidOrder.id)
                const stockA = await readInventoryPosition(fresh, product.id, storage.id)
                const stockB = await readInventoryPosition(fresh, secondProduct.id, secondStorage.id)
                const saleTransactions = await readSaleTransactions(fresh, paidOrder.id)
                const paymentsAfter = await readPaymentRows(fresh, paidOrder.id)
                const accountMovementsAfter = await readAccountMovements(fresh, account.id)

                expect(saved.status).toBe('completed')
                expect(stockA.quantity).toBe(7)
                expect(stockB.quantity).toBe(6)
                expect(saleTransactions).toHaveLength(2)
                expect(saleTransactions.map((row) => ({
                    product_id: row.product_id,
                    storage_id: row.storage_id,
                    quantity_delta: Number(row.quantity_delta),
                    previous_quantity: Number(row.previous_quantity),
                    new_quantity: Number(row.new_quantity)
                }))).toEqual(expect.arrayContaining([
                    { product_id: product.id, storage_id: storage.id, quantity_delta: -3, previous_quantity: 10, new_quantity: 7 },
                    { product_id: secondProduct.id, storage_id: secondStorage.id, quantity_delta: -4, previous_quantity: 10, new_quantity: 6 }
                ]))
                expect(saved.items).toEqual(expect.arrayContaining([
                    expect.objectContaining({ productId: product.id, reservedQuantity: 1, fulfilledQuantity: 1 }),
                    expect.objectContaining({ productId: product.id, reservedQuantity: 2, fulfilledQuantity: 2 }),
                    expect.objectContaining({ productId: secondProduct.id, reservedQuantity: 4, fulfilledQuantity: 4 })
                ]))
                expect(Number(saved.paid_amount)).toBe(total)
                expect(Number(saved.balance_amount)).toBe(0)
                expect(paymentsAfter).toEqual(paymentsBefore)
                expect(accountMovementsAfter).toEqual(accountMovementsBefore)
            } finally { await fresh.auth.signOut() }

            await Promise.all([
                hooks.deleteProduct(secondProduct.id)
            ])
            recordLiveFixture(ids, 'extra-products-retired')
        }, { stock: 10 })
    }, 120_000)

    for (const currency of ['iqd', 'eur', 'try'] as CurrencyCode[]) {
        it(`completes a paid ${currency.toUpperCase()} Sale Order and blocks a partially paid cash draft`, async () => {
            await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
                const orders = await import('@/local-db/orders')
                const partialDraft = await orders.createSalesOrder(liveWorkspaceId, {
                    ...saleOrderInput(partner.id, product, storage.id, 'cash', { currency }),
                    customerName: partner.partnerName,
                    notes: tag
                }, undefined, { requireRemoteConfirmation: true })
                ids.partialOrderId = partialDraft.id
                recordLiveFixture(ids)

                await orders.recordOrderPayment(liveWorkspaceId, {
                    orderType: 'sales', orderId: partialDraft.id, amount: 25,
                    paymentMethod: 'cash', paidAt: new Date().toISOString()
                })
                await expect(orders.updateSalesOrderStatus(partialDraft.id, 'pending'))
                    .rejects.toThrow('non_financed_order_must_be_paid')

                const partialClient = await freshLiveClient()
                try {
                    const saved = await readOrder(partialClient, partialDraft.id)
                    const stock = await readInventoryPosition(partialClient, product.id, storage.id)
                    const payments = await readPaymentRows(partialClient, partialDraft.id)
                    expect(saved).toMatchObject({
                        status: 'draft', currency, payment_method: 'cash', payment_status: 'partial'
                    })
                    expect(Number(saved.paid_amount)).toBe(25)
                    expect(Number(saved.balance_amount)).toBe(75)
                    expect(stock.quantity).toBe(10)
                    expect(await readSaleTransactions(partialClient, partialDraft.id)).toHaveLength(0)
                    expect(payments).toHaveLength(1)
                    expect(payments[0]).toMatchObject({
                        amount: 25, currency, source_record_id: partialDraft.id
                    })
                } finally { await partialClient.auth.signOut() }

                const draft = await createPaidDraftOrder(partner.id, partner.partnerName, product, storage.id, tag, { currency })
                ids.orderId = draft.id
                recordLiveFixture(ids)
                const pending = await orders.updateSalesOrderStatus(draft.id, 'pending')
                const before = await freshLiveClient()
                let paymentsBefore: Array<Record<string, unknown>>
                try { paymentsBefore = await readPaymentRows(before, draft.id) }
                finally { await before.auth.signOut() }

                const completed = await orders.updateSalesOrderStatus(pending.id, 'completed')
                expect(completed.status).toBe('completed')

                const fresh = await freshLiveClient()
                try {
                    const saved = await readOrder(fresh, draft.id)
                    const stock = await readInventoryPosition(fresh, product.id, storage.id)
                    const saleTransactions = await readSaleTransactions(fresh, draft.id)
                    const payments = await readPaymentRows(fresh, draft.id)
                    expect(saved).toMatchObject({
                        status: 'completed', currency, payment_method: 'cash', payment_status: 'paid'
                    })
                    expect(Number(saved.paid_amount)).toBe(100)
                    expect(Number(saved.balance_amount)).toBe(0)
                    expect(stock.quantity).toBe(9)
                    expect(saleTransactions).toHaveLength(1)
                    expect(saleTransactions[0]).toMatchObject({
                        quantity_delta: -1, previous_quantity: 10, new_quantity: 9
                    })
                    expect(payments).toHaveLength(1)
                    expect(payments[0]).toMatchObject({
                        amount: 100, currency, source_record_id: draft.id
                    })
                    expect(payments).toEqual(paymentsBefore)
                } finally { await fresh.auth.signOut() }
            }, { currency })
        }, 120_000)
    }

    it('completes an order allocated across expiry-ordered stock batches and persists each batch deduction', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const batches = await import('@/local-db/stockBatches')
            const orders = await import('@/local-db/orders')
            const earlier = await batches.createStockBatch(liveWorkspaceId, {
                productId: product.id, storageId: storage.id,
                batchNumber: `${tag} EARLIER`, quantity: 4,
                expiryDate: '2099-01-01', currency: 'usd'
            })
            const later = await batches.createStockBatch(liveWorkspaceId, {
                productId: product.id, storageId: storage.id,
                batchNumber: `${tag} LATER`, quantity: 6,
                expiryDate: '2099-01-02', currency: 'usd'
            })
            ids.firstBatchId = earlier.id
            ids.secondBatchId = later.id
            recordLiveFixture(ids)

            const draft = await createPaidDraftOrder(partner.id, partner.partnerName, product, storage.id, tag, {
                quantity: 5
            })
            ids.orderId = draft.id
            recordLiveFixture(ids)
            await orders.updateSalesOrderStatus(draft.id, 'pending')
            const completed = await orders.updateSalesOrderStatus(draft.id, 'completed')
            expect(completed.status).toBe('completed')

            const fresh = await freshLiveClient()
            try {
                const saved = await readOrder(fresh, draft.id)
                const stock = await readInventoryPosition(fresh, product.id, storage.id)
                const saleTransactions = await readSaleTransactions(fresh, draft.id)
                const savedBatches = await readStockBatches(fresh, product.id, storage.id)
                expect(saved.status).toBe('completed')
                expect(stock.quantity).toBe(5)
                expect(saleTransactions).toHaveLength(1)
                expect(saleTransactions[0]).toMatchObject({
                    product_id: product.id, storage_id: storage.id,
                    quantity_delta: -5, previous_quantity: 10, new_quantity: 5
                })
                expect(saved.items[0].batchAllocations).toEqual(expect.arrayContaining([
                    expect.objectContaining({ batchId: earlier.id, batchNumber: earlier.batchNumber, quantity: 4 }),
                    expect.objectContaining({ batchId: later.id, batchNumber: later.batchNumber, quantity: 1 })
                ]))
                expect(savedBatches).toEqual(expect.arrayContaining([
                    expect.objectContaining({ id: earlier.id, quantity: 0, is_deleted: true, expiry_date: '2099-01-01' }),
                    expect.objectContaining({ id: later.id, quantity: 5, is_deleted: false, expiry_date: '2099-01-02' })
                ]))
            } finally { await fresh.auth.signOut() }

            await batches.deleteStockBatch(later.id)
        })
    }, 120_000)

    for (const method of ['loan', 'installments'] as const) {
        it(`completes a financed ${method} order without changing its loan or down-payment ledger`, async () => {
            await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
                const orders = await import('@/local-db/orders')
                const dueDate = new Date(Date.now() + 60 * 86_400_000).toISOString()
                const input = saleOrderInput(partner.id, product, storage.id, method, { initialPayment: 25 })
                const draft = await orders.createSalesOrder(liveWorkspaceId, {
                    ...input,
                    customerName: partner.partnerName,
                    notes: tag,
                    paidAt: new Date().toISOString(),
                    firstDueDate: dueDate,
                    nextDueDate: dueDate
                }, undefined, { requireRemoteConfirmation: true })
                ids.orderId = draft.id
                recordLiveFixture(ids)
                const pending = await orders.updateSalesOrderStatus(draft.id, 'pending')
                ids.loanId = pending.linkedLoanId ?? null
                recordLiveFixture(ids)
                expect(pending.linkedLoanId).toBeTruthy()

                const before = await freshLiveClient()
                let orderPaymentsBefore: Array<Record<string, unknown>>
                let loanPaymentsBefore: Array<Record<string, unknown>>
                let loanRepaymentsBefore: Awaited<ReturnType<typeof readLoanRepayments>> = []
                try {
                    const loan = requireLiveData<{
                        id: string
                        is_deleted: boolean
                        principal_amount: number | string
                        total_paid_amount: number | string
                        balance_amount: number | string
                    }>(await before.from('loans')
                        .select('id,is_deleted,principal_amount,total_paid_amount,balance_amount')
                        .eq('id', pending.linkedLoanId).single(), 'financed completion loan')
                    const installments = requireLiveData<Array<{ id: string; is_deleted: boolean }>>(await before.from('loan_installments')
                        .select('id,is_deleted').eq('loan_id', pending.linkedLoanId).order('id'), 'financed completion installments')
                    const stock = await readInventoryPosition(before, product.id, storage.id)
                    orderPaymentsBefore = await readPaymentRows(before, draft.id)
                    loanPaymentsBefore = await readLoanPaymentRows(before, pending.linkedLoanId as string)
                    expect(loan).toMatchObject({ id: pending.linkedLoanId, is_deleted: false })
                    if (method === 'loan') {
                        loanRepaymentsBefore = await readLoanRepayments(before, pending.linkedLoanId as string)
                        expect(loanRepaymentsBefore).toHaveLength(1)
                        expect(Number(loanRepaymentsBefore[0].amount)).toBe(25)
                        expect(loanRepaymentsBefore[0]).toMatchObject({
                            sequence_no: 1,
                            payment_transaction_id: expect.any(String),
                            integrity_version: 1
                        })
                        const linkedTransaction = loanPaymentsBefore.find((row) => row.id === loanRepaymentsBefore[0].payment_transaction_id)
                        expect(linkedTransaction).toMatchObject({
                            id: loanRepaymentsBefore[0].payment_transaction_id,
                            source_type: 'simple_loan',
                            source_record_id: pending.linkedLoanId,
                            source_subrecord_id: loanRepaymentsBefore[0].id,
                            direction: 'incoming',
                            currency: draft.currency,
                            payment_method: 'cash',
                            metadata: {
                                loanPaymentId: loanRepaymentsBefore[0].id,
                                isOrderLoanInitialRepayment: true
                            }
                        })
                        expect(Number(linkedTransaction?.amount)).toBe(25)
                        expect(Number(loan.principal_amount)).toBe(100)
                        expect(Number(loan.total_paid_amount)).toBe(25)
                        expect(Number(loan.balance_amount)).toBe(75)
                    }
                    expect(installments.length).toBeGreaterThan(0)
                    expect(installments.every((row) => !row.is_deleted)).toBe(true)
                    expect(stock.quantity).toBe(10)
                    expect(Number(pending.paidAmount)).toBe(25)
                    expect(Number(pending.balanceAmount)).toBe(75)
                    expect(orderPaymentsBefore.length + loanPaymentsBefore.length).toBeGreaterThan(0)
                } finally { await before.auth.signOut() }

                const completed = await orders.updateSalesOrderStatus(pending.id, 'completed')
                expect(completed.status).toBe('completed')
                const fresh = await freshLiveClient()
                try {
                    const saved = await readOrder(fresh, draft.id)
                    const stock = await readInventoryPosition(fresh, product.id, storage.id)
                    const saleTransactions = await readSaleTransactions(fresh, draft.id)
                    const loan = requireLiveData<{ is_deleted: boolean }>(await fresh.from('loans')
                        .select('is_deleted').eq('id', pending.linkedLoanId).single(), 'completed financed loan')
                    const installments = requireLiveData<Array<{ is_deleted: boolean }>>(await fresh.from('loan_installments')
                        .select('is_deleted').eq('loan_id', pending.linkedLoanId), 'completed financed installments')
                    expect(saved).toMatchObject({
                        status: 'completed', linked_loan_id: pending.linkedLoanId, payment_method: method
                    })
                    expect(Number(saved.paid_amount)).toBe(25)
                    expect(Number(saved.balance_amount)).toBe(75)
                    expect(stock.quantity).toBe(9)
                    expect(saleTransactions).toHaveLength(1)
                    expect(saleTransactions[0]).toMatchObject({ quantity_delta: -1, previous_quantity: 10, new_quantity: 9 })
                    expect(loan.is_deleted).toBe(false)
                    expect(installments.length).toBeGreaterThan(0)
                    expect(installments.every((row) => !row.is_deleted)).toBe(true)
                    expect(await readPaymentRows(fresh, draft.id)).toEqual(orderPaymentsBefore)
                    expect(await readLoanPaymentRows(fresh, pending.linkedLoanId as string)).toEqual(loanPaymentsBefore)
                    if (method === 'loan') {
                        expect(await readLoanRepayments(fresh, pending.linkedLoanId as string)).toEqual(loanRepaymentsBefore)
                    }
                } finally { await fresh.auth.signOut() }
            })
        }, 120_000)
    }

    it('rejects stale inventory versions and invalid deltas without changing order, stock, sale movements, or payments', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const draft = await createPaidDraftOrder(partner.id, partner.partnerName, product, storage.id, tag)
            ids.orderId = draft.id
            recordLiveFixture(ids)
            await orders.updateSalesOrderStatus(draft.id, 'pending')

            const client = await freshLiveClient()
            try {
                const orderBefore = await readOrder(client, draft.id)
                const inventoryBefore = await readInventoryPosition(client, product.id, storage.id)
                const paymentsBefore = await readPaymentRows(client, draft.id)
                const payload = completionPayload(orderBefore, [inventoryBefore])

                const staleInventory = await client.rpc('complete_sales_order_with_inventory', {
                    ...payload,
                    p_changes: payload.p_changes.map((change) => ({
                        ...change,
                        expected_version: inventoryBefore.version - 1
                    }))
                })
                expect(requireRpcError(staleInventory, '22023').message)
                    .toBe('Inventory changes do not match the sales order quantity')

                const malformed = await client.rpc('complete_sales_order_with_inventory', {
                    ...payload,
                    p_items: []
                })
                expect(requireRpcError(malformed, '22023').message).toBe('Sales order completion payload is invalid')

                const mismatchedChanges = payload.p_changes.map((change) => ({
                    ...change,
                    quantity: inventoryBefore.quantity
                }))
                const mismatched = await client.rpc('complete_sales_order_with_inventory', {
                    ...payload,
                    p_changes: mismatchedChanges
                })
                expect(requireRpcError(mismatched, '22023').message)
                    .toBe('Inventory changes do not match the sales order quantity')

                const orderAfter = await readOrder(client, draft.id)
                const inventoryAfter = await readInventoryPosition(client, product.id, storage.id)
                expect(orderAfter.status).toBe('pending')
                expect(Number(orderAfter.version)).toBe(Number(orderBefore.version))
                expect(inventoryAfter).toEqual(inventoryBefore)
                expect(await readSaleTransactions(client, draft.id)).toHaveLength(0)
                expect(await readPaymentRows(client, draft.id)).toEqual(paymentsBefore)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)

    it('returns a conflict envelope for stale order versions and rejects invalid inputs without writes', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const draft = await createPaidDraftOrder(partner.id, partner.partnerName, product, storage.id, tag)
            ids.orderId = draft.id
            recordLiveFixture(ids)
            await orders.updateSalesOrderStatus(draft.id, 'pending')

            const client = await freshLiveClient()
            try {
                const orderBefore = await readOrder(client, draft.id)
                const inventoryBefore = await readInventoryPosition(client, product.id, storage.id)
                const paymentsBefore = await readPaymentRows(client, draft.id)
                const payload = completionPayload(orderBefore, [inventoryBefore])

                const staleOrder = await client.rpc('complete_sales_order_with_inventory', {
                    ...payload,
                    p_expected_order_version: Number(orderBefore.version) + 1
                })
                expect(staleOrder.error).toBeNull()
                expect(staleOrder.data).toMatchObject({
                    conflict: true,
                    conflict_reason: 'sales_order_version',
                    current_order_version: Number(orderBefore.version)
                })

                const invalidOperation = await client.rpc('complete_sales_order_with_inventory', {
                    ...payload,
                    p_operation_id: crypto.randomUUID()
                })
                expect(requireRpcError(invalidOperation, '22023').message)
                    .toBe('Sales order completion operation id is invalid')

                const wrongWorkspace = await client.rpc('complete_sales_order_with_inventory', {
                    ...payload,
                    p_workspace_id: crypto.randomUUID()
                })
                expect(requireRpcError(wrongWorkspace, '42501').message)
                    .toBe('You are not allowed to complete sales orders in this workspace')

                const alteredItems = await client.rpc('complete_sales_order_with_inventory', {
                    ...payload,
                    p_items: payload.p_items.map((item, index) => index === 0
                        ? { ...item, quantity: Number(item.quantity) + 1 }
                        : item)
                })
                expect(requireRpcError(alteredItems, '22023').message)
                    .toBe('Sales order items changed before completion')

                const missingOrderId = crypto.randomUUID()
                const missingOrder = await client.rpc('complete_sales_order_with_inventory', {
                    ...payload,
                    p_order_id: missingOrderId,
                    p_operation_id: uuidv5(missingOrderId, completionOperationNamespace)
                })
                expect(requireRpcError(missingOrder, 'P0002').message).toBe('Sales order not found')

                const orderAfter = await readOrder(client, draft.id)
                const inventoryAfter = await readInventoryPosition(client, product.id, storage.id)
                expect(orderAfter.status).toBe('pending')
                expect(Number(orderAfter.version)).toBe(Number(orderBefore.version))
                expect(inventoryAfter).toEqual(inventoryBefore)
                expect(await readSaleTransactions(client, draft.id)).toHaveLength(0)
                expect(await readPaymentRows(client, draft.id)).toEqual(paymentsBefore)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)

    it('rejects a stock deficit discovered after reservation without partially completing the order', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const inventory = await import('@/local-db/inventory')
            const draft = await createPaidDraftOrder(partner.id, partner.partnerName, product, storage.id, tag, { quantity: 2 })
            ids.orderId = draft.id
            recordLiveFixture(ids)
            await orders.updateSalesOrderStatus(draft.id, 'pending')

            await inventory.adjustInventoryQuantity({
                workspaceId: liveWorkspaceId,
                productId: product.id,
                storageId: storage.id,
                quantityDelta: -1,
                movement: {
                    productId: product.id,
                    storageId: storage.id,
                    transactionType: 'stock_adjustment',
                    adjustmentReason: 'correction',
                    referenceId: crypto.randomUUID(),
                    referenceType: 'completion_integrity_test',
                    notes: tag,
                    createdBy: null
                }
            })

            const client = await freshLiveClient()
            try {
                const orderBefore = await readOrder(client, draft.id)
                const inventoryBefore = await readInventoryPosition(client, product.id, storage.id)
                const paymentsBefore = await readPaymentRows(client, draft.id)
                expect(inventoryBefore.quantity).toBe(1)
                const payload = completionPayload(orderBefore, [inventoryBefore])
                const result = await client.rpc('complete_sales_order_with_inventory', payload)
                expect(requireRpcError(result, '23514').message).toBe('Inventory quantity cannot be negative')

                const orderAfter = await readOrder(client, draft.id)
                const inventoryAfter = await readInventoryPosition(client, product.id, storage.id)
                expect(orderAfter.status).toBe('pending')
                expect(Number(orderAfter.version)).toBe(Number(orderBefore.version))
                expect(inventoryAfter).toEqual(inventoryBefore)
                expect(await readSaleTransactions(client, draft.id)).toHaveLength(0)
                expect(await readPaymentRows(client, draft.id)).toEqual(paymentsBefore)
            } finally { await client.auth.signOut() }
        }, { stock: 2 })
    }, 120_000)

    it('blocks completion of an approval-requested order before stock or payment writes', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const request = await createPaidDraftOrder(partner.id, partner.partnerName, product, storage.id, tag, {
                approvalRequested: true
            })
            ids.orderId = request.id
            recordLiveFixture(ids)

            await expect(orders.updateSalesOrderStatus(request.id, 'pending'))
                .rejects.toThrow('order_request_requires_approval')

            const fresh = await freshLiveClient()
            try {
                const saved = await readOrder(fresh, request.id)
                const inventory = await readInventoryPosition(fresh, product.id, storage.id)
                expect(saved).toMatchObject({ status: 'draft', approval_status: 'requested' })
                expect(inventory.quantity).toBe(10)
                expect(await readSaleTransactions(fresh, request.id)).toHaveLength(0)
                expect(await readPaymentRows(fresh, request.id)).toHaveLength(0)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)

    it('serializes concurrent completion RPC retries into one stock deduction and one sale movement', async () => {
        await withLiveSaleOrderFixture(async ({ partner, storage, product, ids, tag }) => {
            const orders = await import('@/local-db/orders')
            const draft = await createPaidDraftOrder(partner.id, partner.partnerName, product, storage.id, tag, { quantity: 2 })
            ids.orderId = draft.id
            recordLiveFixture(ids)
            await orders.updateSalesOrderStatus(draft.id, 'pending')

            const client = await freshLiveClient()
            try {
                const order = await readOrder(client, draft.id)
                const inventory = await readInventoryPosition(client, product.id, storage.id)
                const paymentsBefore = await readPaymentRows(client, draft.id)
                const payload = completionPayload(order, [inventory])
                const [first, second] = await Promise.all([
                    client.rpc('complete_sales_order_with_inventory', payload),
                    client.rpc('complete_sales_order_with_inventory', payload)
                ])
                expect(first.error).toBeNull()
                expect(second.error).toBeNull()
                expect([first.data.already_applied, second.data.already_applied].sort())
                    .toEqual([false, true])

                const saved = await readOrder(client, draft.id)
                const stockAfter = await readInventoryPosition(client, product.id, storage.id)
                const saleTransactions = await readSaleTransactions(client, draft.id)
                expect(saved.status).toBe('completed')
                expect(stockAfter.quantity).toBe(8)
                expect(saleTransactions).toHaveLength(1)
                expect(saleTransactions[0]).toMatchObject({
                    product_id: product.id,
                    storage_id: storage.id,
                    quantity_delta: -2,
                    previous_quantity: 10,
                    new_quantity: 8
                })
                expect(await readPaymentRows(client, draft.id)).toEqual(paymentsBefore)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)
})
