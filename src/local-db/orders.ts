import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { convertCurrencyAmountWithSnapshot } from '@/lib/orderCurrency'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId } from '@/lib/utils'
import { isCloudWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import type {
    Customer,
    CurrencyCode,
    PurchaseOrder,
    PurchaseOrderStatus,
    SalesOrder,
    SalesOrderStatus,
    Supplier
} from './models'

type SimpleEntityTableName = 'customers' | 'suppliers'
type OrderTableName = 'sales_orders' | 'purchase_orders'
type SyncableTableName = SimpleEntityTableName | OrderTableName | 'products'

type BaseEntityPayload = {
    id: string
    workspaceId: string
    createdAt: string
    updatedAt: string
    syncStatus: 'pending' | 'synced' | 'conflict'
    lastSyncedAt: string | null
    version: number
    isDeleted: boolean
}

type ProductLike = {
    id: string
    workspaceId: string
    quantity: number
    costPrice: number
    currency: CurrencyCode
    updatedAt: string
    syncStatus: 'pending' | 'synced' | 'conflict'
    lastSyncedAt: string | null
    version: number
    isDeleted: boolean
    storageName?: string
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && isCloudWorkspaceMode(workspaceId)
}

function roundAmount(amount: number, currency: CurrencyCode) {
    if (currency === 'iqd') {
        return Math.round(amount)
    }

    return Math.round(amount * 100) / 100
}

async function runMutation<T>(label: string, promiseFactory: () => PromiseLike<T>): Promise<T> {
    return runSupabaseAction(label, promiseFactory)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return {
            syncStatus: 'synced' as const,
            lastSyncedAt: timestamp
        }
    }

    return {
        syncStatus: 'pending' as const,
        lastSyncedAt: null
    }
}

function sanitizeSyncPayload(tableName: SyncableTableName, entity: Record<string, unknown>) {
    const payload = { ...entity }
    delete payload.syncStatus
    delete payload.lastSyncedAt

    const snakePayload = Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value])
    )

    if (tableName === 'products') {
        delete snakePayload.storage_name
    }

    return snakePayload
}

async function markEntitiesSynced(tableName: SyncableTableName, ids: string[]) {
    const syncedAt = new Date().toISOString()
    const table = (db as unknown as Record<string, { update: (id: string, changes: Record<string, unknown>) => Promise<number> }>)[tableName]
    await Promise.all(ids.map((id) => table.update(id, { syncStatus: 'synced', lastSyncedAt: syncedAt })))
}

async function queueOfflineUpserts(tableName: SyncableTableName, entities: Array<{ id: string; version: number } & Record<string, unknown>>, workspaceId: string) {
    await Promise.all(entities.map((entity) =>
        addToOfflineMutations(
            tableName,
            entity.id,
            entity.version > 1 ? 'update' : 'create',
            entity,
            workspaceId
        )
    ))
}

async function syncUpsertEntities(tableName: SyncableTableName, entities: Array<{ id: string; version: number } & Record<string, unknown>>, workspaceId: string) {
    if (!entities.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline(workspaceId)) {
        await queueOfflineUpserts(tableName, entities, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const payload = entities.map((entity) => sanitizeSyncPayload(tableName, entity))
        const { error } = await runMutation(`${tableName}.sync`, () => client.from(tableName).upsert(payload))
        if (error) {
            throw error
        }

        await markEntitiesSynced(tableName, entities.map((entity) => entity.id))
    } catch (error) {
        console.error(`[Orders] Failed to sync ${tableName}:`, error)
        await queueOfflineUpserts(tableName, entities, workspaceId)
    }
}

async function syncSoftDelete(tableName: SimpleEntityTableName | OrderTableName, entityId: string, workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline(workspaceId)) {
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId }, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const { error } = await runMutation(`${tableName}.delete`, () =>
            client
                .from(tableName)
                .update({ is_deleted: true, updated_at: new Date().toISOString() })
                .eq('id', entityId)
        )
        if (error) {
            throw error
        }

        await markEntitiesSynced(tableName, [entityId])
    } catch (error) {
        console.error(`[Orders] Failed to delete ${tableName}:`, error)
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId }, workspaceId)
    }
}

async function generateDocumentNumber(tableName: OrderTableName, workspaceId: string) {
    const prefix = tableName === 'sales_orders' ? 'SO' : 'PO'
    const year = new Date().getFullYear()
    const rows = await (db as unknown as Record<OrderTableName, { where: (index: string) => { equals: (value: string) => { toArray: () => Promise<Array<{ createdAt: string }>> } } }>)[tableName]
        .where('workspaceId')
        .equals(workspaceId)
        .toArray()
    const sequence = rows.filter((row) => row.createdAt.startsWith(`${year}-`)).length + 1
    return `${prefix}-${year}-${String(sequence).padStart(5, '0')}`
}

async function recalculateCustomerSummary(workspaceId: string, customerId: string) {
    const customer = await db.customers.get(customerId)
    if (!customer || customer.isDeleted) {
        return customer
    }

    const orders = await db.sales_orders
        .where('customerId')
        .equals(customerId)
        .and((item) => !item.isDeleted)
        .toArray()

    const activeOrders = orders.filter((order) => order.status !== 'cancelled')
    const totalOrders = activeOrders.length
    const totalSpent = roundAmount(
        activeOrders
            .filter((order) => order.status === 'completed')
            .reduce(
                (sum, order) => sum + convertCurrencyAmountWithSnapshot(order.total, order.currency, customer.defaultCurrency, order.exchangeRates),
                0
            ),
        customer.defaultCurrency
    )
    const outstandingBalance = roundAmount(
        activeOrders
            .filter((order) => (order.status === 'pending' || order.status === 'completed') && !order.isPaid)
            .reduce(
                (sum, order) => sum + convertCurrencyAmountWithSnapshot(order.total, order.currency, customer.defaultCurrency, order.exchangeRates),
                0
            ),
        customer.defaultCurrency
    )

    if (
        customer.totalOrders === totalOrders
        && customer.totalSpent === totalSpent
        && customer.outstandingBalance === outstandingBalance
    ) {
        return customer
    }

    const now = new Date().toISOString()
    const updated: Customer = {
        ...customer,
        totalOrders,
        totalSpent,
        outstandingBalance,
        updatedAt: now,
        version: customer.version + 1,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.customers.put(updated)
    await syncUpsertEntities('customers', [updated as unknown as Record<string, unknown> & { id: string; version: number }], workspaceId)
    return updated
}

async function recalculateSupplierSummary(workspaceId: string, supplierId: string) {
    const supplier = await db.suppliers.get(supplierId)
    if (!supplier || supplier.isDeleted) {
        return supplier
    }

    const orders = await db.purchase_orders
        .where('supplierId')
        .equals(supplierId)
        .and((item) => !item.isDeleted)
        .toArray()

    const activeOrders = orders.filter((order) => order.status !== 'cancelled')
    const totalPurchases = activeOrders.length
    const totalSpent = roundAmount(
        activeOrders
            .filter((order) => order.status === 'received' || order.status === 'completed')
            .reduce(
                (sum, order) => sum + convertCurrencyAmountWithSnapshot(order.total, order.currency, supplier.defaultCurrency, order.exchangeRates),
                0
            ),
        supplier.defaultCurrency
    )

    if (supplier.totalPurchases === totalPurchases && supplier.totalSpent === totalSpent) {
        return supplier
    }

    const now = new Date().toISOString()
    const updated: Supplier = {
        ...supplier,
        totalPurchases,
        totalSpent,
        updatedAt: now,
        version: supplier.version + 1,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.suppliers.put(updated)
    await syncUpsertEntities('suppliers', [updated as unknown as Record<string, unknown> & { id: string; version: number }], workspaceId)
    return updated
}

function buildBaseEntity<T extends Record<string, unknown>>(workspaceId: string, data: T): T & BaseEntityPayload {
    const now = new Date().toISOString()

    return {
        ...data,
        id: generateId(),
        workspaceId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }
}

export function useCustomers(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const customers = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.customers.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
            return rows.sort((a, b) => a.name.localeCompare(b.name))
        },
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('customers', db.customers, workspaceId)
        }
    }, [online, workspaceId])

    return customers ?? []
}

export function useCustomer(customerId: string | undefined) {
    return useLiveQuery(() => customerId ? db.customers.get(customerId) : undefined, [customerId])
}

export async function createCustomer(
    workspaceId: string,
    data: Omit<Customer, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'totalOrders' | 'totalSpent' | 'outstandingBalance'>
) {
    const customer = buildBaseEntity(workspaceId, {
        ...data,
        totalOrders: 0,
        totalSpent: 0,
        outstandingBalance: 0
    }) as Customer

    await db.customers.put(customer)
    await syncUpsertEntities('customers', [customer as unknown as Record<string, unknown> & { id: string; version: number }], workspaceId)
    return customer
}

export async function updateCustomer(id: string, data: Partial<Customer>) {
    const customer = await db.customers.get(id)
    if (!customer || customer.isDeleted) {
        throw new Error('Customer not found')
    }

    const now = new Date().toISOString()
    const updated: Customer = {
        ...customer,
        ...data,
        updatedAt: now,
        version: customer.version + 1,
        ...getSyncMetadata(customer.workspaceId, now)
    }

    await db.customers.put(updated)
    await syncUpsertEntities('customers', [updated as unknown as Record<string, unknown> & { id: string; version: number }], customer.workspaceId)
    return updated
}

export async function deleteCustomer(id: string) {
    const customer = await db.customers.get(id)
    if (!customer || customer.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    await db.customers.put({
        ...customer,
        isDeleted: true,
        updatedAt: now,
        version: customer.version + 1,
        ...getSyncMetadata(customer.workspaceId, now)
    })
    await syncSoftDelete('customers', id, customer.workspaceId)
}

export function useSuppliers(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const suppliers = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.suppliers.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
            return rows.sort((a, b) => a.name.localeCompare(b.name))
        },
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('suppliers', db.suppliers, workspaceId)
        }
    }, [online, workspaceId])

    return suppliers ?? []
}

export function useSupplier(supplierId: string | undefined) {
    return useLiveQuery(() => supplierId ? db.suppliers.get(supplierId) : undefined, [supplierId])
}

export async function createSupplier(
    workspaceId: string,
    data: Omit<Supplier, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'totalPurchases' | 'totalSpent'>
) {
    const supplier = buildBaseEntity(workspaceId, {
        ...data,
        totalPurchases: 0,
        totalSpent: 0
    }) as Supplier

    await db.suppliers.put(supplier)
    await syncUpsertEntities('suppliers', [supplier as unknown as Record<string, unknown> & { id: string; version: number }], workspaceId)
    return supplier
}

export async function updateSupplier(id: string, data: Partial<Supplier>) {
    const supplier = await db.suppliers.get(id)
    if (!supplier || supplier.isDeleted) {
        throw new Error('Supplier not found')
    }

    const now = new Date().toISOString()
    const updated: Supplier = {
        ...supplier,
        ...data,
        updatedAt: now,
        version: supplier.version + 1,
        ...getSyncMetadata(supplier.workspaceId, now)
    }

    await db.suppliers.put(updated)
    await syncUpsertEntities('suppliers', [updated as unknown as Record<string, unknown> & { id: string; version: number }], supplier.workspaceId)
    return updated
}

export async function deleteSupplier(id: string) {
    const supplier = await db.suppliers.get(id)
    if (!supplier || supplier.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    await db.suppliers.put({
        ...supplier,
        isDeleted: true,
        updatedAt: now,
        version: supplier.version + 1,
        ...getSyncMetadata(supplier.workspaceId, now)
    })
    await syncSoftDelete('suppliers', id, supplier.workspaceId)
}

async function computeCustomerOutstandingBeforeOrder(customer: Customer, excludeOrderId?: string) {
    const orders = await db.sales_orders
        .where('customerId')
        .equals(customer.id)
        .and((item) => !item.isDeleted && item.id !== excludeOrderId)
        .toArray()

    return roundAmount(
        orders
            .filter((order) => (order.status === 'pending' || order.status === 'completed') && !order.isPaid)
            .reduce(
                (sum, order) => sum + convertCurrencyAmountWithSnapshot(order.total, order.currency, customer.defaultCurrency, order.exchangeRates),
                0
            ),
        customer.defaultCurrency
    )
}

async function assertSalesCreditLimit(order: SalesOrder, excludeOrderId?: string) {
    if (order.isPaid) {
        return
    }

    const customer = await db.customers.get(order.customerId)
    if (!customer || customer.isDeleted) {
        throw new Error('Customer not found')
    }

    if (!customer.creditLimit || customer.creditLimit <= 0) {
        return
    }

    const outstanding = await computeCustomerOutstandingBeforeOrder(customer, excludeOrderId)
    const nextExposure = outstanding + convertCurrencyAmountWithSnapshot(order.total, order.currency, customer.defaultCurrency, order.exchangeRates)
    if (nextExposure > customer.creditLimit) {
        throw new Error('credit_limit_exceeded')
    }
}

async function getReservedQuantityMap(workspaceId: string, excludeOrderId?: string) {
    const orders = await db.sales_orders
        .where('workspaceId')
        .equals(workspaceId)
        .and((item) => !item.isDeleted && item.status === 'pending' && item.id !== excludeOrderId)
        .toArray()

    const reserved = new Map<string, number>()
    for (const order of orders) {
        for (const item of order.items) {
            reserved.set(item.productId, (reserved.get(item.productId) || 0) + item.quantity)
        }
    }

    return reserved
}

async function assertSalesStockAvailable(order: SalesOrder, excludeOrderId?: string) {
    const reserved = await getReservedQuantityMap(order.workspaceId, excludeOrderId)
    const productIds = Array.from(new Set(order.items.map((item) => item.productId)))
    const products = await db.products.where('id').anyOf(productIds).toArray()
    const productMap = new Map(products.map((product) => [product.id, product]))

    for (const item of order.items) {
        const product = productMap.get(item.productId)
        if (!product || product.isDeleted) {
            throw new Error(`Product not found: ${item.productName}`)
        }

        const available = product.quantity - (reserved.get(item.productId) || 0)
        if (available < item.quantity) {
            throw new Error(`Insufficient stock for ${item.productName}`)
        }
    }
}

async function deductInventoryForSalesOrder(order: SalesOrder) {
    const now = new Date().toISOString()
    const updatedProducts: ProductLike[] = []
    const syncMetadata = getSyncMetadata(order.workspaceId, now)

    for (const item of order.items) {
        const product = await db.products.get(item.productId)
        if (!product || product.isDeleted) {
            throw new Error(`Product not found: ${item.productName}`)
        }

        if (product.quantity < item.quantity) {
            throw new Error(`Insufficient stock for ${item.productName}`)
        }

        const updatedProduct = {
            ...product,
            quantity: product.quantity - item.quantity,
            updatedAt: now,
            version: product.version + 1,
            ...syncMetadata
        }

        await db.products.put(updatedProduct)
        updatedProducts.push(updatedProduct)
    }

    return updatedProducts
}

async function receiveInventoryForPurchaseOrder(order: PurchaseOrder) {
    const now = new Date().toISOString()
    const updatedProducts: ProductLike[] = []
    const syncMetadata = getSyncMetadata(order.workspaceId, now)

    for (const item of order.items) {
        const product = await db.products.get(item.productId)
        if (!product || product.isDeleted) {
            throw new Error(`Product not found: ${item.productName}`)
        }

        const receivedQuantity = item.receivedQuantity ?? item.quantity
        const actualUnitCost = item.originalUnitPrice
        const nextQuantity = product.quantity + receivedQuantity
        const nextCost = nextQuantity <= 0
            ? actualUnitCost
            : roundAmount(
                ((product.quantity * product.costPrice) + (receivedQuantity * actualUnitCost)) / nextQuantity,
                product.currency
            )

        const updatedProduct = {
            ...product,
            quantity: nextQuantity,
            costPrice: nextCost,
            updatedAt: now,
            version: product.version + 1,
            ...syncMetadata
        }

        await db.products.put(updatedProduct)
        updatedProducts.push(updatedProduct)
    }

    return updatedProducts
}

export function useSalesOrders(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const orders = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.sales_orders.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
            return rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        },
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('sales_orders', db.sales_orders, workspaceId)
        }
    }, [online, workspaceId])

    return orders ?? []
}

export function usePurchaseOrders(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const orders = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.purchase_orders.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
            return rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        },
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('purchase_orders', db.purchase_orders, workspaceId)
        }
    }, [online, workspaceId])

    return orders ?? []
}

export function useSalesOrder(orderId: string | undefined) {
    return useLiveQuery(() => orderId ? db.sales_orders.get(orderId) : undefined, [orderId])
}

export function usePurchaseOrder(orderId: string | undefined) {
    return useLiveQuery(() => orderId ? db.purchase_orders.get(orderId) : undefined, [orderId])
}

export async function createSalesOrder(
    workspaceId: string,
    data: Omit<SalesOrder, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'orderNumber'>
) {
    const orderNumber = await generateDocumentNumber('sales_orders', workspaceId)
    const status = data.status || 'draft'
    const order = buildBaseEntity(workspaceId, {
        ...data,
        orderNumber,
        status
    }) as SalesOrder

    if (status === 'pending' || status === 'completed') {
        await assertSalesCreditLimit(order)
        await assertSalesStockAvailable(order)
    }

    await db.sales_orders.put(order)

    let updatedProducts: ProductLike[] = []
    if (status === 'completed') {
        updatedProducts = await deductInventoryForSalesOrder(order)
        const now = new Date().toISOString()
        await db.sales_orders.update(order.id, {
            actualDeliveryDate: now,
            updatedAt: now
        })
    } else if (status === 'pending') {
        await db.sales_orders.update(order.id, {
            reservedAt: order.reservedAt || new Date().toISOString()
        })
    }

    await syncUpsertEntities('sales_orders', [order as unknown as Record<string, unknown> & { id: string; version: number }], workspaceId)
    if (updatedProducts.length > 0) {
        await syncUpsertEntities('products', updatedProducts as unknown as Array<Record<string, unknown> & { id: string; version: number }>, workspaceId)
    }
    await recalculateCustomerSummary(workspaceId, order.customerId)
    return (await db.sales_orders.get(order.id)) as SalesOrder
}

export async function updateSalesOrder(id: string, data: Partial<SalesOrder>) {
    const existing = await db.sales_orders.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Sales order not found')
    }

    if (existing.status !== 'draft') {
        throw new Error('Only draft sales orders can be edited')
    }

    const now = new Date().toISOString()
    const updated: SalesOrder = {
        ...existing,
        ...data,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.sales_orders.put(updated)
    await syncUpsertEntities('sales_orders', [updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)

    if (existing.customerId !== updated.customerId) {
        await recalculateCustomerSummary(existing.workspaceId, existing.customerId)
    }
    await recalculateCustomerSummary(existing.workspaceId, updated.customerId)
    return updated
}

export async function updateSalesOrderStatus(id: string, status: SalesOrderStatus) {
    const existing = await db.sales_orders.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Sales order not found')
    }

    if (existing.status === 'completed' && status !== 'completed') {
        throw new Error('Completed sales orders are immutable')
    }

    const now = new Date().toISOString()
    const updated: SalesOrder = {
        ...existing,
        status,
        updatedAt: now,
        version: existing.version + 1,
        reservedAt: status === 'pending' ? (existing.reservedAt || now) : existing.reservedAt,
        actualDeliveryDate: status === 'completed' ? now : existing.actualDeliveryDate,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    let updatedProducts: ProductLike[] = []
    if (status === 'pending') {
        await assertSalesCreditLimit(updated, existing.id)
        await assertSalesStockAvailable(updated, existing.id)
    }

    if (status === 'completed') {
        await assertSalesCreditLimit(updated, existing.id)
        await assertSalesStockAvailable(updated, existing.id)
        updatedProducts = await deductInventoryForSalesOrder(updated)
    }

    await db.sales_orders.put(updated)

    await syncUpsertEntities('sales_orders', [updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)
    if (updatedProducts.length > 0) {
        await syncUpsertEntities('products', updatedProducts as unknown as Array<Record<string, unknown> & { id: string; version: number }>, existing.workspaceId)
    }
    await recalculateCustomerSummary(existing.workspaceId, existing.customerId)
    return updated
}

export async function setSalesOrderPaymentStatus(
    id: string,
    input: {
        isPaid: boolean
        paymentMethod?: SalesOrder['paymentMethod']
        paidAt?: string | null
    }
) {
    const existing = await db.sales_orders.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Sales order not found')
    }

    const now = new Date().toISOString()
    const updated: SalesOrder = {
        ...existing,
        isPaid: input.isPaid,
        paymentMethod: input.isPaid ? input.paymentMethod || existing.paymentMethod : existing.paymentMethod,
        paidAt: input.isPaid ? (input.paidAt || now) : null,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    if ((updated.status === 'pending' || updated.status === 'completed') && !updated.isPaid) {
        await assertSalesCreditLimit(updated, existing.id)
    }

    await db.sales_orders.put(updated)
    await syncUpsertEntities('sales_orders', [updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)
    await recalculateCustomerSummary(existing.workspaceId, existing.customerId)
    return updated
}

export async function deleteSalesOrder(id: string) {
    const existing = await db.sales_orders.get(id)
    if (!existing || existing.isDeleted) {
        return
    }

    if (existing.status === 'completed' || existing.status === 'pending') {
        throw new Error('Active sales orders cannot be deleted')
    }

    const now = new Date().toISOString()
    await db.sales_orders.put({
        ...existing,
        isDeleted: true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    })
    await syncSoftDelete('sales_orders', id, existing.workspaceId)
    await recalculateCustomerSummary(existing.workspaceId, existing.customerId)
}

export async function createPurchaseOrder(
    workspaceId: string,
    data: Omit<PurchaseOrder, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'orderNumber'>
) {
    const orderNumber = await generateDocumentNumber('purchase_orders', workspaceId)
    const status = data.status || 'draft'
    const order = buildBaseEntity(workspaceId, {
        ...data,
        orderNumber,
        status
    }) as PurchaseOrder

    await db.purchase_orders.put(order)

    let updatedProducts: ProductLike[] = []
    if (status === 'received' || status === 'completed') {
        updatedProducts = await receiveInventoryForPurchaseOrder(order)
    }

    await syncUpsertEntities('purchase_orders', [order as unknown as Record<string, unknown> & { id: string; version: number }], workspaceId)
    if (updatedProducts.length > 0) {
        await syncUpsertEntities('products', updatedProducts as unknown as Array<Record<string, unknown> & { id: string; version: number }>, workspaceId)
    }
    await recalculateSupplierSummary(workspaceId, order.supplierId)
    return (await db.purchase_orders.get(order.id)) as PurchaseOrder
}

export async function updatePurchaseOrder(id: string, data: Partial<PurchaseOrder>) {
    const existing = await db.purchase_orders.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Purchase order not found')
    }

    if (existing.status !== 'draft') {
        throw new Error('Only draft purchase orders can be edited')
    }

    const now = new Date().toISOString()
    const updated: PurchaseOrder = {
        ...existing,
        ...data,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.purchase_orders.put(updated)
    await syncUpsertEntities('purchase_orders', [updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)

    if (existing.supplierId !== updated.supplierId) {
        await recalculateSupplierSummary(existing.workspaceId, existing.supplierId)
    }
    await recalculateSupplierSummary(existing.workspaceId, updated.supplierId)
    return updated
}

export async function updatePurchaseOrderStatus(id: string, status: PurchaseOrderStatus) {
    const existing = await db.purchase_orders.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Purchase order not found')
    }

    if ((existing.status === 'received' || existing.status === 'completed') && status === 'cancelled') {
        throw new Error('Received purchase orders cannot be cancelled')
    }

    if (existing.status === 'completed' && status !== 'completed') {
        throw new Error('Completed purchase orders are immutable')
    }

    const now = new Date().toISOString()
    const updated: PurchaseOrder = {
        ...existing,
        status,
        updatedAt: now,
        version: existing.version + 1,
        actualDeliveryDate: status === 'received' || status === 'completed' ? (existing.actualDeliveryDate || now) : existing.actualDeliveryDate,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    let updatedProducts: ProductLike[] = []
    if ((status === 'received' || status === 'completed') && existing.status !== 'received' && existing.status !== 'completed') {
        updatedProducts = await receiveInventoryForPurchaseOrder(updated)
    }

    await db.purchase_orders.put(updated)

    await syncUpsertEntities('purchase_orders', [updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)
    if (updatedProducts.length > 0) {
        await syncUpsertEntities('products', updatedProducts as unknown as Array<Record<string, unknown> & { id: string; version: number }>, existing.workspaceId)
    }
    await recalculateSupplierSummary(existing.workspaceId, existing.supplierId)
    return updated
}

export async function setPurchaseOrderPaymentStatus(
    id: string,
    input: {
        isPaid: boolean
        paymentMethod?: PurchaseOrder['paymentMethod']
        paidAt?: string | null
    }
) {
    const existing = await db.purchase_orders.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Purchase order not found')
    }

    const now = new Date().toISOString()
    const updated: PurchaseOrder = {
        ...existing,
        isPaid: input.isPaid,
        paymentMethod: input.isPaid ? input.paymentMethod || existing.paymentMethod : existing.paymentMethod,
        paidAt: input.isPaid ? (input.paidAt || now) : null,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.purchase_orders.put(updated)
    await syncUpsertEntities('purchase_orders', [updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)
    await recalculateSupplierSummary(existing.workspaceId, existing.supplierId)
    return updated
}

export async function deletePurchaseOrder(id: string) {
    const existing = await db.purchase_orders.get(id)
    if (!existing || existing.isDeleted) {
        return
    }

    if (existing.status === 'received' || existing.status === 'completed' || existing.status === 'ordered') {
        throw new Error('Active purchase orders cannot be deleted')
    }

    const now = new Date().toISOString()
    await db.purchase_orders.put({
        ...existing,
        isDeleted: true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    })
    await syncSoftDelete('purchase_orders', id, existing.workspaceId)
    await recalculateSupplierSummary(existing.workspaceId, existing.supplierId)
}
