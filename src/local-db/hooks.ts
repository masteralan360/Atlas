import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { db } from './database'
import type {
    Product,
    Category,
    Customer,
    Supplier,
    PurchaseOrder,
    SalesOrder,
    Invoice,
    OfflineMutation,
    Sale,
    SaleItem,
    Employee,
    BudgetSettings,
    BudgetAllocation,
    ExpenseSeries,
    ExpenseItem,
    PayrollStatus,
    DividendStatus,
    User,
    WorkspaceContact,
    Loan,
    LoanInstallment,
    LoanPayment,
    CurrencyCode,
    InstallmentFrequency,
    InstallmentStatus,
    LoanPaymentMethod,
    LoanStatus
} from './models'
import { generateId, toSnakeCase, toCamelCase } from '@/lib/utils'
import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'

// ===================
// CATEGORIES HOOKS
// ===================

async function runMutation<T>(label: string, promiseFactory: () => PromiseLike<T>): Promise<T> {
    return runSupabaseAction(label, promiseFactory)
}

async function getMutationSession(label: string) {
    const { data: { session } } = await runSupabaseAction(`${label}.session`, () => supabase.auth.getSession())
    return session
}

function shouldUseOfflineMutationFallback(error: unknown): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return true
    }

    if (!isOnline()) {
        return true
    }

    return isRetriableWebRequestError(error)
}

// ===================
// CATEGORIES HOOKS
// ===================

export function useCategories(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    // 1. Local Cache (Always Source of Truth for UI)
    const categories = useLiveQuery(
        () => workspaceId ? db.categories.where('workspaceId').equals(workspaceId).and(c => !c.isDeleted).toArray() : [],
        [workspaceId]
    )

    // 2. Online: Fetch fresh data from Supabase & cleanup cache
    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId) {
                const { data, error } = await supabase
                    .from('categories')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (data && !error) {
                    await db.transaction('rw', db.categories, async () => {
                        const remoteIds = new Set(data.map(d => d.id))
                        const localItems = await db.categories.where('workspaceId').equals(workspaceId).toArray()

                        // Delete local items that are 'synced' but missing from server
                        for (const local of localItems) {
                            if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                                await db.categories.delete(local.id)
                            }
                        }

                        for (const remoteItem of data) {
                            const localItem = toCamelCase(remoteItem as any) as unknown as Category
                            localItem.syncStatus = 'synced'
                            localItem.lastSyncedAt = new Date().toISOString()
                            await db.categories.put(localItem)
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [isOnline, workspaceId])

    return categories ?? []
}

export async function createCategory(workspaceId: string, data: Omit<Category, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>): Promise<Category> {
    const now = new Date().toISOString()
    const id = generateId()

    const category: Category = {
        ...data,
        id,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any, // Optimistic status
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    if (isOnline()) {
        const session = await getMutationSession('categories.create')
        const currentUserId = session?.user?.id

        // ONLINE: Write directly to Supabase
        const payload = toSnakeCase({
            ...category,
            userId: currentUserId,
            syncStatus: undefined,
            lastSyncedAt: undefined
        })
        const { error } = await runMutation('categories.create', () => supabase.from('categories').upsert(payload))

        if (error) {
            console.error('Supabase write failed:', error)
            throw normalizeSupabaseActionError(error) // Fail loudly if online
        }

        // Update local cache as synced
        await db.categories.put(category)
    } else {
        // OFFLINE: Write to local mutation queue
        await db.categories.put(category)
        await addToOfflineMutations('categories', id, 'create', category as unknown as Record<string, unknown>, workspaceId)
    }

    return category
}

export async function updateCategory(id: string, data: Partial<Category>): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.categories.get(id)
    if (!existing) throw new Error('Category not found')

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (isOnline()) {
        // ONLINE: Update Supabase directly
        const payload = toSnakeCase({ ...data, updatedAt: now })
        const { error } = await runMutation('categories.update', () => supabase.from('categories').update(payload).eq('id', id))

        if (error) throw normalizeSupabaseActionError(error)

        await db.categories.put(updated)
    } else {
        // OFFLINE: Local mutation
        await db.categories.put(updated)
        await addToOfflineMutations('categories', id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }
}

export async function deleteCategory(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.categories.get(id)
    if (!existing) return

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: isOnline() ? 'synced' : 'pending',
        version: existing.version + 1
    } as Category

    if (isOnline()) {
        // ONLINE: Delete in Supabase (Soft Delete)
        const { error } = await runMutation('categories.delete', () => supabase.from('categories').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)

        await db.categories.put(updated)
    } else {
        // OFFLINE
        await db.categories.put(updated)
        // For delete, we might just need the ID, but passing full updated record is safe or just payload with ID
        await addToOfflineMutations('categories', id, 'delete', { id }, existing.workspaceId)
    }
}

// ===================
// PRODUCTS HOOKS
// ===================

// ===================
// PRODUCTS HOOKS
// ===================

export function useProducts(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    const products = useLiveQuery(
        () => workspaceId ? db.products.where('workspaceId').equals(workspaceId).and(p => !p.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId) {
                const { data, error } = await supabase
                    .from('products')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (data && !error) {
                    await db.transaction('rw', db.products, async () => {
                        const remoteIds = new Set(data.map(d => d.id))
                        const localItems = await db.products.where('workspaceId').equals(workspaceId).toArray()

                        // Delete local items that are 'synced' but missing from server
                        for (const local of localItems) {
                            if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                                await db.products.delete(local.id)
                            }
                        }

                        for (const remoteItem of data) {
                            const localItem = toCamelCase(remoteItem as any) as unknown as Product
                            localItem.syncStatus = 'synced'
                            localItem.lastSyncedAt = new Date().toISOString()
                            await db.products.put(localItem)
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [isOnline, workspaceId])

    return products ?? []
}

export function useProduct(id: string | undefined) {
    const product = useLiveQuery(
        () => id ? db.products.get(id) : undefined,
        [id]
    )
    return product
}

export async function createProduct(workspaceId: string, data: Omit<Product, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>): Promise<Product> {
    const now = new Date().toISOString()
    const id = generateId()

    const product: Product = {
        ...data,
        id,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any, // Cast to any or SyncStatus to fix TS error
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    if (isOnline()) {
        // ONLINE
        const payload = toSnakeCase({ ...product, syncStatus: undefined, lastSyncedAt: undefined, storageName: undefined })
        const { error } = await runMutation('products.create', () => supabase.from('products').insert(payload))

        if (error) {
            console.error('Supabase write failed:', error)
            throw normalizeSupabaseActionError(error)
        }

        await db.products.add(product)
    } else {
        // OFFLINE
        await db.products.add(product)
        await addToOfflineMutations('products', id, 'create', product as unknown as Record<string, unknown>, workspaceId)
    }

    return product
}

export async function updateProduct(id: string, data: Partial<Product>): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.products.get(id)
    if (!existing) throw new Error('Product not found')

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (isOnline()) {
        // ONLINE
        const payload = toSnakeCase({ ...data, updatedAt: now, storageName: undefined })
        const { error } = await runMutation('products.update', () => supabase.from('products').update(payload).eq('id', id))

        if (error) throw normalizeSupabaseActionError(error)

        await db.products.put(updated)
    } else {
        // OFFLINE
        await db.products.put(updated)
        await addToOfflineMutations('products', id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }
}

export async function deleteProduct(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.products.get(id)
    if (!existing) return

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        version: existing.version + 1
    } as Product

    if (isOnline()) {
        // ONLINE
        const { error } = await runMutation('products.delete', () => supabase.from('products').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)

        await db.products.put(updated)
    } else {
        // OFFLINE
        await db.products.put(updated)
        await addToOfflineMutations('products', id, 'delete', { id }, existing.workspaceId)
    }
}
// ===================
// SUPPLIERS HOOKS
// ===================

export function useSuppliers(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    const suppliers = useLiveQuery(
        () => workspaceId ? db.suppliers.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId) {
                const { data, error } = await supabase
                    .from('suppliers')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (data && !error) {
                    await db.transaction('rw', db.suppliers, async () => {
                        const remoteIds = new Set(data.map(d => d.id))
                        const localItems = await db.suppliers.where('workspaceId').equals(workspaceId).toArray()

                        for (const local of localItems) {
                            if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                                await db.suppliers.delete(local.id)
                            }
                        }

                        for (const remoteItem of data) {
                            const localItem = toCamelCase(remoteItem as any) as unknown as Supplier
                            localItem.syncStatus = 'synced'
                            localItem.lastSyncedAt = new Date().toISOString()
                            await db.suppliers.put(localItem)
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [isOnline, workspaceId])

    return suppliers ?? []
}

export function useSupplier(id: string | undefined) {
    return useLiveQuery(() => id ? db.suppliers.get(id) : undefined, [id])
}

export async function createSupplier(workspaceId: string, data: Omit<Supplier, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'totalPurchases' | 'totalSpent'>): Promise<Supplier> {
    const now = new Date().toISOString()
    const id = generateId()

    const supplier: Supplier = {
        ...data,
        id,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false,
        totalPurchases: 0,
        totalSpent: 0
    }

    if (isOnline()) {
        const payload = toSnakeCase({ ...supplier, syncStatus: undefined, lastSyncedAt: undefined })
        const { error } = await runMutation('suppliers.create', () => supabase.from('suppliers').insert(payload))
        if (error) throw normalizeSupabaseActionError(error)
        await db.suppliers.add(supplier)
    } else {
        await db.suppliers.add(supplier)
        await addToOfflineMutations('suppliers', id, 'create', supplier as unknown as Record<string, unknown>, workspaceId)
    }

    return supplier
}

export async function updateSupplier(id: string, data: Partial<Supplier>): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.suppliers.get(id)
    if (!existing) throw new Error('Supplier not found')

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (isOnline()) {
        const payload = toSnakeCase({ ...data, updatedAt: now })
        const { error } = await runMutation('suppliers.update', () => supabase.from('suppliers').update(payload).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)
        await db.suppliers.put(updated)
    } else {
        await db.suppliers.put(updated)
        await addToOfflineMutations('suppliers', id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }
}

export async function deleteSupplier(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.suppliers.get(id)
    if (!existing) return

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        version: existing.version + 1
    } as Supplier

    if (isOnline()) {
        const { error } = await runMutation('suppliers.delete', () => supabase.from('suppliers').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)
        await db.suppliers.put(updated)
    } else {
        await db.suppliers.put(updated)
        await addToOfflineMutations('suppliers', id, 'delete', { id }, existing.workspaceId)
    }
}


// ===================
// CUSTOMERS HOOKS
// ===================

export function useCustomers(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    const customers = useLiveQuery(
        () => workspaceId ? db.customers.where('workspaceId').equals(workspaceId).and(c => !c.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId) {
                const { data, error } = await supabase
                    .from('customers')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (data && !error) {
                    await db.transaction('rw', db.customers, async () => {
                        const remoteIds = new Set(data.map(d => d.id))
                        const localItems = await db.customers.where('workspaceId').equals(workspaceId).toArray()

                        // Delete local items that are 'synced' but missing from server
                        for (const local of localItems) {
                            if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                                await db.customers.delete(local.id)
                            }
                        }

                        for (const remoteItem of data) {
                            const localItem = toCamelCase(remoteItem as any) as unknown as Customer
                            localItem.syncStatus = 'synced'
                            localItem.lastSyncedAt = new Date().toISOString()
                            await db.customers.put(localItem)
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [isOnline, workspaceId])

    return customers ?? []
}

export function useCustomer(id: string | undefined) {
    const customer = useLiveQuery(
        () => id ? db.customers.get(id) : undefined,
        [id]
    )
    return customer
}

export async function createCustomer(workspaceId: string, data: Omit<Customer, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'totalOrders' | 'totalSpent' | 'outstandingBalance'>): Promise<Customer> {
    const now = new Date().toISOString()
    const id = generateId()

    const customer: Customer = {
        ...data,
        id,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false,
        totalOrders: 0,
        totalSpent: 0,
        outstandingBalance: 0
    }

    if (isOnline()) {
        // ONLINE
        const payload = toSnakeCase({ ...customer, syncStatus: undefined, lastSyncedAt: undefined })
        const { error } = await runMutation('customers.create', () => supabase.from('customers').insert(payload))

        if (error) {
            console.error('Supabase write failed:', error)
            throw normalizeSupabaseActionError(error)
        }

        await db.customers.add(customer)
    } else {
        // OFFLINE
        await db.customers.add(customer)
        await addToOfflineMutations('customers', id, 'create', customer as unknown as Record<string, unknown>, workspaceId)
    }

    return customer
}

export async function updateCustomer(id: string, data: Partial<Customer>): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.customers.get(id)
    if (!existing) throw new Error('Customer not found')

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (isOnline()) {
        // ONLINE
        const payload = toSnakeCase({ ...data, updatedAt: now })
        const { error } = await runMutation('customers.update', () => supabase.from('customers').update(payload).eq('id', id))

        if (error) throw normalizeSupabaseActionError(error)

        await db.customers.put(updated)
    } else {
        // OFFLINE
        await db.customers.put(updated)
        await addToOfflineMutations('customers', id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }
}

export async function deleteCustomer(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.customers.get(id)
    if (!existing) return

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        version: existing.version + 1
    } as Customer

    if (isOnline()) {
        // ONLINE
        const { error } = await runMutation('customers.delete', () => supabase.from('customers').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)

        await db.customers.put(updated)
    } else {
        // OFFLINE
        await db.customers.put(updated)
        await addToOfflineMutations('customers', id, 'delete', { id }, existing.workspaceId)
    }
}

// ===================
// ORDERS HOOKS
// ===================


// ===================
// PURCHASE ORDERS HOOKS
// ===================

export function usePurchaseOrders(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const orders = useLiveQuery(
        () => workspaceId ? db.purchaseOrders.where('workspaceId').equals(workspaceId).and(o => !o.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        if (isOnline && workspaceId) {
            fetchTableFromSupabase('purchase_orders', db.purchaseOrders, workspaceId)
        }
    }, [isOnline, workspaceId])

    return orders ?? []
}

export function usePurchaseOrder(id: string | undefined) {
    return useLiveQuery(() => id ? db.purchaseOrders.get(id) : undefined, [id])
}

export async function createPurchaseOrder(workspaceId: string, data: Omit<PurchaseOrder, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'orderNumber'>): Promise<PurchaseOrder> {
    const now = new Date().toISOString()
    const orderNumber = `PO-${Date.now().toString(36).toUpperCase()}`
    const id = generateId()

    const order: PurchaseOrder = {
        ...data,
        id,
        workspaceId,
        orderNumber,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    await saveEntity('purchase_orders', db.purchaseOrders, order, workspaceId)

    // Increment supplier stats
    const supplier = await db.suppliers.get(data.supplierId)
    if (supplier) {
        await updateSupplier(supplier.id, {
            totalPurchases: (supplier.totalPurchases || 0) + 1,
            totalSpent: (supplier.totalSpent || 0) + data.total // Consider currency? Usually we track raw total or convert if simple for now
        })
    }

    return order
}

export async function updatePurchaseOrder(id: string, data: Partial<PurchaseOrder>): Promise<void> {
    await updateEntity('purchase_orders', db.purchaseOrders, id, data)
}


// ===================
// SALES ORDERS HOOKS
// ===================

export function useSalesOrders(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const orders = useLiveQuery(
        () => workspaceId ? db.salesOrders.where('workspaceId').equals(workspaceId).and(o => !o.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        if (isOnline && workspaceId) {
            fetchTableFromSupabase('sales_orders', db.salesOrders, workspaceId)
        }
    }, [isOnline, workspaceId])

    return orders ?? []
}

export function useSalesOrder(id: string | undefined) {
    return useLiveQuery(() => id ? db.salesOrders.get(id) : undefined, [id])
}

export async function createSalesOrder(workspaceId: string, data: Omit<SalesOrder, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'orderNumber'>): Promise<SalesOrder> {
    const now = new Date().toISOString()
    const orderNumber = `SO-${Date.now().toString(36).toUpperCase()}`
    const id = generateId()

    const order: SalesOrder = {
        ...data,
        id,
        workspaceId,
        orderNumber,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    await saveEntity('sales_orders', db.salesOrders, order, workspaceId)

    // Increment customer stats
    const customer = await db.customers.get(data.customerId)
    if (customer) {
        await updateCustomer(customer.id, {
            totalOrders: (customer.totalOrders || 0) + 1,
            totalSpent: (customer.totalSpent || 0) + data.total
        })
    }

    return order
}

export async function updateSalesOrder(id: string, data: Partial<SalesOrder>): Promise<void> {
    await updateEntity('sales_orders', db.salesOrders, id, data)
}

// Helpers for repetitive logic
export async function fetchTableFromSupabase<T extends { id: string, syncStatus: any, lastSyncedAt: any }>(tableName: string, table: any, workspaceId: string) {
    const client = getSupabaseClientForTable(tableName)
    let query = client
        .from(tableName)
        .select('*')
        .eq('workspace_id', workspaceId)

    // Only filter by is_deleted for tables that still have that column
    if (tableName !== 'workspace_contacts') {
        query = query.eq('is_deleted', false)
    }

    const { data, error } = await query

    if (data && !error) {
        await db.transaction('rw', table, async () => {
            const remoteIds = new Set(data.map(d => d.id))
            const localItems = await table.where('workspaceId').equals(workspaceId).toArray()

            for (const local of (localItems as any[])) {
                if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                    await table.delete(local.id)
                }
            }

            for (const remoteItem of data) {
                const localItem = toCamelCase(remoteItem as any) as unknown as T
                localItem.syncStatus = 'synced'
                localItem.lastSyncedAt = new Date().toISOString()
                await table.put(localItem)
            }
        })
    }
}

async function saveEntity<T extends { id: string }>(tableName: string, table: any, entity: T, workspaceId: string) {
    if (isOnline()) {
        const client = getSupabaseClientForTable(tableName)
        const payload = toSnakeCase({ ...entity, syncStatus: undefined, lastSyncedAt: undefined })
        const { error } = await runMutation(`${tableName}.create`, () => client.from(tableName).insert(payload))
        if (error) {
            console.error('Supabase write failed:', error)
            throw normalizeSupabaseActionError(error)
        }
        await table.add(entity)
    } else {
        await table.add(entity)
        await addToOfflineMutations(tableName as any, entity.id, 'create', entity as unknown as Record<string, unknown>, workspaceId)
    }
}

async function updateEntity<T extends { id: string, workspaceId: string, version: number, lastSyncedAt: any }>(tableName: string, table: any, id: string, data: Partial<T> & Record<string, any>) {
    const now = new Date().toISOString()
    const existing = await table.get(id)
    if (!existing) throw new Error('Entity not found')

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (isOnline()) {
        const client = getSupabaseClientForTable(tableName)
        const payload = toSnakeCase({ ...data, updatedAt: now })
        const { error } = await runMutation(`${tableName}.update`, () => client.from(tableName).update(payload).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)
        await table.put(updated)
    } else {
        await table.put(updated)
        await addToOfflineMutations(tableName as any, id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }
}

// ===================
// INVOICES HOOKS
// ===================

export function useInvoices(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    const invoices = useLiveQuery(
        () => workspaceId ? db.invoices.where('workspaceId').equals(workspaceId).and(i => !i.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId) {
                const { data, error } = await supabase
                    .from('invoices')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (data && !error) {
                    await db.transaction('rw', db.invoices, async () => {
                        const remoteIds = new Set(data.map(d => d.id))
                        const localItems = await db.invoices.where('workspaceId').equals(workspaceId).toArray()

                        // Delete local items that are 'synced' but missing from server
                        for (const local of localItems) {
                            if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                                await db.invoices.delete(local.id)
                            }
                        }

                        for (const remoteItem of data) {
                            const existing = await db.invoices.get(remoteItem.id)
                            // If we have pending local changes (like PDF blobs waiting to upload), 
                            // DO NOT overwrite with remote state yet.
                            if (existing && existing.syncStatus === 'pending') {
                                continue
                            }

                            const localItem = toCamelCase(remoteItem as any) as unknown as Invoice
                            localItem.syncStatus = 'synced'
                            localItem.lastSyncedAt = new Date().toISOString()
                            await db.invoices.put(localItem)
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [isOnline, workspaceId])

    return invoices ?? []
}

export function useInvoice(id: string | undefined) {
    const invoice = useLiveQuery(
        () => id ? db.invoices.get(id) : undefined,
        [id]
    )
    return invoice
}

export async function createInvoice(workspaceId: string, data: Omit<Invoice, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'invoiceid'> & { sequenceId?: number }, overrideId?: string): Promise<Invoice> {
    const now = new Date().toISOString()
    const invoiceid = `INV-${Date.now().toString(36).toUpperCase()}`
    const id = overrideId || generateId()

    const invoice: Invoice = {
        ...data,
        id,
        workspaceId,
        invoiceid,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false,
        createdByName: data.createdByName,
        cashierName: data.cashierName,
        sequenceId: data.sequenceId,
        printFormat: data.printFormat
    }


    if (isOnline()) {
        // ONLINE
        // Omit items/blobs and legacy fields that don't belong in the table schema
        // We keep createdBy/created_by in local but map to user_id in remote for RLS
        const { items, currency, subtotal, discount, printMetadata, pdfBlobA4, pdfBlobReceipt, ...rest } = invoice as any

        // @ts-ignore - isSnapshot might be passed but not in Invoice type
        const { isSnapshot, ...finalRest } = rest

        // Get current auth user to satisfy RLS 'user_id' check
        const session = await getMutationSession('invoices.create')
        const currentUserId = session?.user?.id

        const payload = toSnakeCase({
            ...finalRest,
            userId: currentUserId, // Explicitly set user_id for RLS
            syncStatus: undefined,
            lastSyncedAt: undefined
        })

        // Use upsert instead of insert to handle network retries/collisions gracefully
        const { error } = await runMutation('invoices.create', () => supabase.from('invoices').upsert(payload))

        if (error) {
            console.error('Supabase write failed:', error)
            throw normalizeSupabaseActionError(error)
        }

        // Use put instead of add for local idempotency
        await db.invoices.put(invoice)
    } else {
        // OFFLINE
        await db.invoices.put(invoice)
        await addToOfflineMutations('invoices', id, 'create', invoice as unknown as Record<string, unknown>, workspaceId)
    }

    return invoice
}

/**
 * Specifically for automated Invoice snapshots from Print Preview
 */
export async function saveInvoiceFromSnapshot(workspaceId: string, data: Omit<Invoice, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'invoiceid'>, overrideId?: string): Promise<Invoice> {

    // If an overrideId is provided, check if it already exists to avoid unique constraint errors
    if (overrideId) {
        const existing = await db.invoices.get(overrideId)
        if (existing) {
            await updateInvoice(overrideId, {
                ...data,
                updatedAt: new Date().toISOString()
            })
            return { ...existing, ...data } as Invoice
        }
    }

    return createInvoice(workspaceId, {
        ...data,
        // @ts-ignore - passing extra flag for logic if needed (though now unused in createInvoice payload)
        isSnapshot: true
    }, overrideId)
}

export async function updateInvoice(id: string, data: Partial<Invoice>): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.invoices.get(id)
    if (!existing) throw new Error('Invoice not found')

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (isOnline()) {
        // ONLINE
        // Filter out legacy fields from update payload
        const { items, currency, subtotal, discount, printMetadata, pdfBlobA4, pdfBlobReceipt, ...restData } = data as any
        const payload = toSnakeCase({ ...restData, updatedAt: now })
        const { error } = await runMutation('invoices.update', () => supabase.from('invoices').update(payload).eq('id', id))

        if (error) throw normalizeSupabaseActionError(error)

        await db.invoices.put(updated)
    } else {
        // OFFLINE
        await db.invoices.put(updated)
        await addToOfflineMutations('invoices', id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }
}

export async function deleteInvoice(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.invoices.get(id)
    if (!existing) return

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        version: existing.version + 1
    } as Invoice

    if (isOnline()) {
        // ONLINE
        const { error } = await runMutation('invoices.delete', () => supabase.from('invoices').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)

        await db.invoices.put(updated)
    } else {
        // OFFLINE
        await db.invoices.put(updated)
        await addToOfflineMutations('invoices', id, 'delete', { id }, existing.workspaceId)
    }
}

// ===================
// SALES HOOKS
// ===================

export function useSales(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    const sales = useLiveQuery(
        () => workspaceId ? db.sales.where('workspaceId').equals(workspaceId).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId) {
                const { data, error } = await supabase
                    .from('sales')
                    .select(`
                        *,
                        sale_items(
                            *,
                            product:product_id(name, sku, can_be_returned, return_rules)
                        )
                    `)
                    .eq('workspace_id', workspaceId)

                if (data && !error) {
                    // Fetch cashier profiles
                    const cashierIds = Array.from(new Set(data.map((s: any) => s.cashier_id).filter(Boolean)))
                    let profilesMap: Record<string, string> = {}
                    if (cashierIds.length > 0) {
                        const { data: profiles } = await supabase
                            .from('profiles')
                            .select('id, name')
                            .in('id', cashierIds)
                        if (profiles) {
                            profilesMap = profiles.reduce((acc: any, p: any) => ({ ...acc, [p.id]: p.name }), {})
                        }
                    }

                    await db.transaction('rw', [db.sales, db.sale_items], async () => {
                        const remoteIds = new Set(data.map(d => d.id))
                        const localItems = await db.sales.where('workspaceId').equals(workspaceId).toArray()

                        for (const local of localItems) {
                            if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                                await db.sales.delete(local.id)
                                await db.sale_items.where('saleId').equals(local.id).delete()
                            }
                        }

                        for (const remoteSale of data) {
                            const { sale_items: remoteItems, ...saleData } = remoteSale as any
                            const localSale = toCamelCase(saleData) as unknown as Sale
                            localSale.syncStatus = 'synced'
                            localSale.lastSyncedAt = new Date().toISOString()

                            // Enrich with cashier name and items for local-first reads
                            const enrichedItems = (remoteItems || []).map((item: any) => ({
                                ...item,
                                product_name: item.product?.name || 'Unknown Product',
                                product_sku: item.product?.sku || '',
                                product_category: item.product?.category || ''
                            }))
                                ; (localSale as any)._enrichedItems = enrichedItems
                                ; (localSale as any)._cashierName = profilesMap[saleData.cashier_id] || 'Staff'

                            await db.sales.put(localSale)

                            if (remoteItems) {
                                for (const item of remoteItems) {
                                    const { product, ...itemData } = item
                                    const localItem = toCamelCase(itemData) as unknown as SaleItem
                                    await db.sale_items.put(localItem)
                                }
                            }
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [isOnline, workspaceId])

    return sales ?? []
}

/**
 * Maps a local-db Sale (camelCase) to the UI Sale type (snake_case) from @/types.
 * Includes enriched items and cashier name from background sync.
 */
export function toUISale(localSale: any): any {
    const enrichedItems = (localSale._enrichedItems || []).map((item: any) => ({
        ...item,
        // Ensure product object is available for return checks
        product: item.product || {
            name: item.product_name || 'Unknown Product',
            sku: item.product_sku || '',
            can_be_returned: item.can_be_returned ?? true,
            return_rules: item.return_rules
        }
    }))

    return {
        id: localSale.id,
        workspace_id: localSale.workspaceId,
        cashier_id: localSale.cashierId,
        total_amount: localSale.totalAmount,
        settlement_currency: localSale.settlementCurrency,
        exchange_source: localSale.exchangeSource,
        exchange_rate: localSale.exchangeRate,
        exchange_rate_timestamp: localSale.exchangeRateTimestamp,
        exchange_rates: localSale.exchangeRates,
        created_at: localSale.createdAt,
        updated_at: localSale.updatedAt,
        origin: localSale.origin,
        payment_method: localSale.payment_method ?? localSale.paymentMethod,
        cashier_name: localSale._cashierName || 'Staff',
        items: enrichedItems,
        is_returned: localSale.isReturned,
        return_reason: localSale.returnReason,
        returned_at: localSale.returnedAt,
        returned_by: localSale.returnedBy,
        sequenceId: localSale.sequenceId,
        system_verified: localSale.systemVerified,
        system_review_status: localSale.systemReviewStatus,
        system_review_reason: localSale.systemReviewReason,
        notes: localSale.notes
    }
}

// ===================
// SYNC QUEUE
// ===================

export function useSyncQueue() {
    const queue = useLiveQuery(() => db.syncQueue.toArray(), [])
    return queue ?? []
}

export function usePendingSyncCount() {
    const count = useLiveQuery(() => db.offline_mutations.where('status').equals('pending').count(), [])
    return count ?? 0
}

export async function addToOfflineMutations(
    entityType: OfflineMutation['entityType'],
    entityId: string,
    operation: OfflineMutation['operation'],
    payload: Record<string, unknown>,
    workspaceId: string
): Promise<void> {
    // 1. Check for existing pending mutation for this entity
    const existing = await db.offline_mutations
        .where('[entityType+entityId+status]')
        .equals([entityType, entityId, 'pending'])
        .first()

    if (existing) {
        // 2. Handle redundant/canceling operations
        if (operation === 'delete') {
            if (existing.operation === 'create') {
                // Case: Created then Deleted while offline -> Remove from queue entirely
                await db.offline_mutations.delete(existing.id)
                return
            }
            // Case: Updated then Deleted while offline -> Change existing update to a delete
            await db.offline_mutations.update(existing.id, {
                operation: 'delete',
                payload: { id: entityId },
                createdAt: new Date().toISOString()
            })
            return
        }

        if (operation === 'update' || operation === 'create') {
            // Case: Multiple updates or re-creating a deleted item
            // Merge payloads to keep the latest state
            await db.offline_mutations.update(existing.id, {
                operation: existing.operation === 'delete' ? 'update' : existing.operation,
                payload: { ...existing.payload, ...payload },
                createdAt: new Date().toISOString()
            })
            return
        }
    }

    // 3. Default: Add new mutation if no pending exists or couldn't be merged
    await db.offline_mutations.add({
        id: generateId(),
        workspaceId,
        entityType,
        entityId,
        operation,
        payload,
        createdAt: new Date().toISOString(),
        status: 'pending'
    })
}

export async function removeFromSyncQueue(id: string): Promise<void> {
    await db.syncQueue.delete(id)
}

export async function clearSyncQueue(): Promise<void> {
    await db.syncQueue.clear()
}

export async function clearOfflineMutations(): Promise<void> {
    await db.offline_mutations.clear()

    // Also reset syncStatus for items if possible? 
    // Actually, discarding mutations means we won't sync them.
    // The simplest way to "discard" is just to clear the mutation queue.
    // But local items will still have syncStatus: 'pending'.
    // We should probably reset them to 'synced' (as if they were never intended to be synced) 
    // or just leave them as 'pending' (they will stay local only).
    // The user said "pending info will get deleted or discarded".
}

// ===================
// DASHBOARD STATS
// ===================

export function useDashboardStats(workspaceId: string | undefined) {
    const stats = useLiveQuery(async () => {
        if (!workspaceId) return null

        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        const thirtyDaysAgoStr = thirtyDaysAgo.toISOString()

        const [
            productCount,
            categoryCount,
            customerCount,
            orderCount,
            invoiceCount,
            recentSales,
            pendingInvoices,
            lowStockProducts,
            allSales
        ] = await Promise.all([
            db.products.where('workspaceId').equals(workspaceId).and(p => !p.isDeleted).count(),
            db.categories.where('workspaceId').equals(workspaceId).and(c => !c.isDeleted).count(),
            db.customers.where('workspaceId').equals(workspaceId).and(c => !c.isDeleted).count(),
            db.salesOrders.where('workspaceId').equals(workspaceId).and(o => !o.isDeleted).count(),
            db.invoices.where('workspaceId').equals(workspaceId).and(i => !i.isDeleted).count(),
            db.sales.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).reverse().sortBy('createdAt').then(sales => sales.slice(0, 3)),
            db.invoices.where('workspaceId').equals(workspaceId).and(inv => !inv.isDeleted).reverse().sortBy('createdAt').then(inv => inv.slice(0, 4)),
            db.products.where('workspaceId').equals(workspaceId).and(p => !p.isDeleted && p.quantity <= p.minStockLevel).toArray(),
            db.sales.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted && s.createdAt >= thirtyDaysAgoStr).toArray()
        ])

        // Fetch items for recent sales and trend sales to calculate cost
        const saleIds = Array.from(new Set([...recentSales.map(s => s.id), ...allSales.map(s => s.id)]))
        const allItems = await db.sale_items.where('saleId').anyOf(saleIds).toArray()
        const itemsBySaleId = allItems.reduce((acc, item) => {
            if (!acc[item.saleId]) acc[item.saleId] = []
            acc[item.saleId].push(item)
            return acc
        }, {} as Record<string, any[]>)

        // Calculate multi-currency gross revenue, cost, and profit
        const statsByCurrency: Record<string, { revenue: number, cost: number, profit: number, dailyTrend: Record<string, { revenue: number, cost: number, profit: number }> }> = {}

        allSales.forEach(sale => {
            if (sale.isReturned) return

            const curr = sale.settlementCurrency || 'usd'
            if (!statsByCurrency[curr]) {
                statsByCurrency[curr] = { revenue: 0, cost: 0, profit: 0, dailyTrend: {} }
            }

            const saleItems = itemsBySaleId[sale.id] || []
            let saleRevenue = 0
            let saleCost = 0

            saleItems.forEach(item => {
                const netQuantity = item.quantity - (item.returnedQuantity || 0)
                if (netQuantity <= 0) return

                saleRevenue += (item.convertedUnitPrice || 0) * netQuantity
                saleCost += (item.convertedCostPrice || 0) * netQuantity
            })

            let saleProfit = saleRevenue - saleCost

            statsByCurrency[curr].revenue += saleRevenue
            statsByCurrency[curr].cost += saleCost
            statsByCurrency[curr].profit += saleProfit

            const date = sale.createdAt.split('T')[0]
            if (!statsByCurrency[curr].dailyTrend[date]) {
                statsByCurrency[curr].dailyTrend[date] = { revenue: 0, cost: 0, profit: 0 }
            }
            statsByCurrency[curr].dailyTrend[date].revenue += saleRevenue
            statsByCurrency[curr].dailyTrend[date].cost += saleCost
            statsByCurrency[curr].dailyTrend[date].profit += saleProfit
        })

        return {
            productCount,
            categoryCount,
            customerCount,
            orderCount,
            invoiceCount,
            recentSales,
            recentInvoices: pendingInvoices,
            lowStockProducts,
            statsByCurrency,
            grossRevenueByCurrency: Object.fromEntries(Object.entries(statsByCurrency).map(([c, s]) => [c, s.revenue]))
        }
    }, [workspaceId])

    return stats ?? {
        productCount: 0,
        categoryCount: 0,
        customerCount: 0,
        orderCount: 0,
        invoiceCount: 0,
        recentSales: [],
        recentInvoices: [],
        lowStockProducts: [],
        statsByCurrency: {},
        grossRevenueByCurrency: {}
    }
}

// ===================
// STORAGES HOOKS
// ===================

import type { Storage } from './models'

export function useStorages(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const storages = useLiveQuery(
        () => workspaceId ? db.storages.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (online && workspaceId) {
                const { data, error } = await supabase
                    .from('storages')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (data && !error) {
                    await db.transaction('rw', db.storages, async () => {
                        const remoteIds = new Set(data.map(d => d.id))
                        const localItems = await db.storages.where('workspaceId').equals(workspaceId).toArray()

                        for (const local of localItems) {
                            if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                                await db.storages.delete(local.id)
                            }
                        }

                        for (const remoteItem of data) {
                            const localItem = toCamelCase(remoteItem as any) as unknown as Storage
                            localItem.syncStatus = 'synced'
                            localItem.lastSyncedAt = new Date().toISOString()
                            await db.storages.put(localItem)
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [online, workspaceId])

    return storages ?? []
}

export async function createStorage(workspaceId: string, data: { name: string }): Promise<Storage> {
    const now = new Date().toISOString()
    const id = generateId()

    const storage: Storage = {
        id,
        workspaceId,
        name: data.name,
        isSystem: false,
        isProtected: false,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    await db.storages.put(storage)

    await db.storages.put(storage)

    if (isOnline()) {
        const payload = toSnakeCase({
            ...storage,
            syncStatus: undefined,
            lastSyncedAt: undefined,
            version: undefined
        })

        try {
            const { error } = await runMutation('storages.create', () =>
                supabase.from('storages').insert(payload as any)
            )

            if (error) {
                throw normalizeSupabaseActionError(error)
            }
        } catch (error) {
            console.error('[Storage] Create sync failed:', error)
            if (shouldUseOfflineMutationFallback(error)) {
                await db.storages.update(id, { syncStatus: 'pending' })
                await addToOfflineMutations('storages', id, 'create', payload as any, workspaceId)
            } else {
                await db.storages.delete(id)
                throw normalizeSupabaseActionError(error)
            }
        }
    } else {
        const payload = toSnakeCase({
            ...storage,
            syncStatus: undefined,
            lastSyncedAt: undefined,
            version: undefined
        })
        await addToOfflineMutations('storages', id, 'create', payload as any, workspaceId)
    }

    return storage
}

export async function updateStorage(id: string, data: Partial<Pick<Storage, 'name'>>): Promise<void> {
    const existing = await db.storages.get(id)
    if (!existing) return

    // Protect system storages from name changes
    if (existing.isSystem && data.name) {
        console.warn('[Storage] Cannot rename system storage')
        return
    }

    const now = new Date().toISOString()
    await db.storages.update(id, { ...data, updatedAt: now, syncStatus: 'pending' })

    if (isOnline()) {
        try {
            const { error } = await runMutation('storages.update', () =>
                supabase
                    .from('storages')
                    .update({ ...toSnakeCase(data), updated_at: now })
                    .eq('id', id)
            )

            if (error) {
                throw normalizeSupabaseActionError(error)
            }

            await db.storages.update(id, { syncStatus: 'synced', lastSyncedAt: now })
        } catch (error) {
            if (shouldUseOfflineMutationFallback(error)) {
                await addToOfflineMutations('storages', id, 'update', toSnakeCase(data) as any, existing.workspaceId)
            } else {
                await db.storages.put(existing)
                throw normalizeSupabaseActionError(error)
            }
        }
    } else {
        await addToOfflineMutations('storages', id, 'update', toSnakeCase(data) as any, existing.workspaceId)
    }
}

export async function deleteStorage(id: string, moveProductsToStorageId: string): Promise<{ success: boolean, movedCount: number }> {
    const existing = await db.storages.get(id)
    if (!existing) return { success: false, movedCount: 0 }

    // Protect system storages
    if (existing.isProtected || existing.isSystem) {
        console.warn('[Storage] Cannot delete protected/system storage')
        return { success: false, movedCount: 0 }
    }

    // Move all products in this storage to the target storage
    const productsToMove = await db.products.where('storageId').equals(id).toArray()
    const now = new Date().toISOString()

    for (const product of productsToMove) {
        await db.products.update(product.id, { storageId: moveProductsToStorageId, updatedAt: now, syncStatus: 'pending' })

        if (isOnline()) {
            try {
                const { error } = await runMutation('storages.moveProduct', () =>
                    supabase
                        .from('products')
                        .update({ storage_id: moveProductsToStorageId, updated_at: now })
                        .eq('id', product.id)
                )

                if (error) {
                    throw normalizeSupabaseActionError(error)
                }

                await db.products.update(product.id, { syncStatus: 'synced', lastSyncedAt: now })
            } catch (error) {
                if (shouldUseOfflineMutationFallback(error)) {
                    await addToOfflineMutations('products', product.id, 'update', { storage_id: moveProductsToStorageId }, existing.workspaceId)
                } else {
                    await db.products.update(product.id, {
                        storageId: product.storageId,
                        updatedAt: product.updatedAt,
                        syncStatus: product.syncStatus,
                        lastSyncedAt: product.lastSyncedAt,
                        version: product.version
                    })
                    throw normalizeSupabaseActionError(error)
                }
            }
        } else {
            await addToOfflineMutations('products', product.id, 'update', { storage_id: moveProductsToStorageId }, existing.workspaceId)
        }
    }

    // Soft delete the storage
    await db.storages.update(id, { isDeleted: true, updatedAt: now, syncStatus: 'pending' })

    if (isOnline()) {
        try {
            const { error } = await runMutation('storages.delete', () =>
                supabase
                    .from('storages')
                    .update({ is_deleted: true, updated_at: now })
                    .eq('id', id)
            )

            if (error) {
                throw normalizeSupabaseActionError(error)
            }

            await db.storages.update(id, { syncStatus: 'synced', lastSyncedAt: now })
        } catch (error) {
            if (shouldUseOfflineMutationFallback(error)) {
                await addToOfflineMutations('storages', id, 'update', { is_deleted: true } as any, existing.workspaceId)
            } else {
                await db.storages.put(existing)
                for (const product of productsToMove) {
                    await db.products.update(product.id, {
                        storageId: product.storageId,
                        updatedAt: product.updatedAt,
                        syncStatus: product.syncStatus,
                        lastSyncedAt: product.lastSyncedAt,
                        version: product.version
                    })
                }
                throw normalizeSupabaseActionError(error)
            }
        }
    } else {
        await addToOfflineMutations('storages', id, 'update', { is_deleted: true } as any, existing.workspaceId)
    }

    return { success: true, movedCount: productsToMove.length }
}

export async function getReserveStorageId(workspaceId: string): Promise<string | null> {
    const reserve = await db.storages.where('workspaceId').equals(workspaceId).and(s => s.name === 'Reserve' && !s.isDeleted).first()
    return reserve?.id ?? null
}

// ===================
// EMPLOYEES HOOKS
// ===================

export function useEmployees(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const employees = useLiveQuery(
        () => workspaceId ? db.employees.where('workspaceId').equals(workspaceId).and(e => !e.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        if (isOnline && workspaceId) {
            fetchTableFromSupabase('employees', db.employees, workspaceId)
        }
    }, [isOnline, workspaceId])

    return employees ?? []
}

export async function createEmployee(workspaceId: string, data: Omit<Employee, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>): Promise<Employee> {
    const now = new Date().toISOString()
    const id = generateId()
    const employee: Employee = {
        ...data,
        id,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    await saveEntity('employees', db.employees, employee, workspaceId)
    return employee
}

export async function updateEmployee(id: string, data: Partial<Employee>): Promise<void> {
    await updateEntity('employees', db.employees, id, data)
}

export async function deleteEmployee(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.employees.get(id)
    if (!existing) return

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        version: existing.version + 1
    } as Employee

    if (isOnline()) {
        const { error } = await runMutation('employees.delete', () => supabase.from('employees').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)
        await db.employees.put(updated)
    } else {
        await db.employees.put(updated)
        await addToOfflineMutations('employees', id, 'delete', { id }, existing.workspaceId)
    }
}

export function useWorkspaceUsers(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const users = useLiveQuery(
        () => workspaceId ? db.users.where('workspaceId').equals(workspaceId).and(u => !u.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId) {
                // Fetch profiles for the workspace
                const { data, error } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('workspace_id', workspaceId)

                if (data && !error) {
                    await db.transaction('rw', db.users, async () => {
                        for (const remoteUser of data) {
                            const localUser = toCamelCase(remoteUser as any) as unknown as User
                            localUser.syncStatus = 'synced'
                            localUser.lastSyncedAt = new Date().toISOString()
                            await db.users.put(localUser)
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [isOnline, workspaceId])

    return users ?? []
}

// ===================
// BUDGET HOOKS
// ===================

export function useBudgetSettings(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    // 1. Local Cache
    const settings = useLiveQuery(
        () => workspaceId ? db.budget_settings.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).toArray() : [],
        [workspaceId]
    )

    // 2. Online Sync
    useEffect(() => {
        if (isOnline && workspaceId) {
            void fetchTableFromSupabase('budget_settings', db.budget_settings, workspaceId)
        }
    }, [isOnline, workspaceId])

    return settings
}

export async function setBudgetSettings(workspaceId: string, startMonth: string): Promise<BudgetSettings> {
    const now = new Date().toISOString()
    const existing = await db.budget_settings.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).first()

    if (existing) {
        await updateEntity('budget_settings', db.budget_settings, existing.id, { startMonth })
        return { ...existing, startMonth, updatedAt: now }
    }

    const settings: BudgetSettings = {
        id: workspaceId,
        workspaceId,
        startMonth,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    await saveEntity('budget_settings', db.budget_settings, settings, workspaceId)
    return settings
}

export function useBudgetAllocations(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const allocations = useLiveQuery(
        () => workspaceId ? db.budget_allocations.where('workspaceId').equals(workspaceId).and(a => !a.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        if (isOnline && workspaceId) {
            fetchTableFromSupabase('budget_allocations', db.budget_allocations, workspaceId)
        }
    }, [isOnline, workspaceId])

    return allocations ?? []
}

export async function setBudgetAllocation(
    workspaceId: string,
    month: string,
    currency: CurrencyCode,
    allocationType: 'fixed' | 'percentage' = 'fixed',
    allocationValue: number = 0
): Promise<BudgetAllocation> {
    const now = new Date().toISOString()
    const existing = await db.budget_allocations
        .where('[workspaceId+month]')
        .equals([workspaceId, month])
        .and(a => !a.isDeleted)
        .first()

    if (existing) {
        await updateEntity('budget_allocations', db.budget_allocations, existing.id, { 
            currency,
            allocationType,
            allocationValue
        })
        return { ...existing, currency, allocationType, allocationValue, updatedAt: now }
    }

    const allocation: BudgetAllocation = {
        id: generateId(),
        workspaceId,
        month,
        currency,
        allocationType,
        allocationValue,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    await saveEntity('budget_allocations', db.budget_allocations, allocation, workspaceId)
    return allocation
}

export function useExpenseSeries(workspaceId: string | undefined, options?: { includeDeleted?: boolean }) {
    const isOnline = useNetworkStatus()
    const includeDeleted = options?.includeDeleted ?? false
    const series = useLiveQuery(
        () => workspaceId
            ? db.expense_series.where('workspaceId').equals(workspaceId).and(s => includeDeleted || !s.isDeleted).toArray()
            : [],
        [workspaceId, includeDeleted]
    )

    useEffect(() => {
        if (isOnline && workspaceId) {
            fetchTableFromSupabase('expense_series', db.expense_series, workspaceId)
        }
    }, [isOnline, workspaceId])

    return series ?? []
}

export async function createExpenseSeries(
    workspaceId: string,
    data: Omit<ExpenseSeries, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>
): Promise<ExpenseSeries> {
    const now = new Date().toISOString()
    const series: ExpenseSeries = {
        ...data,
        id: generateId(),
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    await saveEntity('expense_series', db.expense_series, series, workspaceId)
    return series
}

export async function updateExpenseSeries(id: string, data: Partial<ExpenseSeries>): Promise<void> {
    await updateEntity('expense_series', db.expense_series, id, data)
}

export async function setExpenseSeriesEndMonth(id: string, endMonth: string | null): Promise<void> {
    await updateEntity('expense_series', db.expense_series, id, { endMonth })
}

export async function deleteExpenseItem(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.expense_items.get(id)
    if (!existing) return

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        version: existing.version + 1
    } as ExpenseItem

    if (isOnline()) {
        const client = getSupabaseClientForTable('expense_items')
        const { error } = await runMutation('expense_items.delete', () =>
            client.from('expense_items').update({ is_deleted: true, updated_at: now }).eq('id', id)
        )
        if (error) throw normalizeSupabaseActionError(error)
        await db.expense_items.put(updated)
    } else {
        await db.expense_items.put(updated)
        await addToOfflineMutations('expense_items', id, 'delete', { id }, existing.workspaceId)
    }
}

export async function hardDeleteExpenseItem(id: string): Promise<void> {
    const existing = await db.expense_items.get(id)
    if (!existing) return

    if (isOnline()) {
        const client = getSupabaseClientForTable('expense_items')
        const { error } = await runMutation('expense_items.hardDelete', () =>
            client.from('expense_items').delete().eq('id', id)
        )
        if (error) throw normalizeSupabaseActionError(error)
        await db.expense_items.delete(id)
    } else {
        await db.expense_items.delete(id)
        await addToOfflineMutations('expense_items', id, 'delete', { id }, existing.workspaceId)
    }
}

export function useExpenseItems(workspaceId: string | undefined, month: string | undefined) {
    const isOnline = useNetworkStatus()
    const items = useLiveQuery(
        () => workspaceId && month
            ? db.expense_items.where('workspaceId').equals(workspaceId).and(i => !i.isDeleted && i.month === month).toArray()
            : [],
        [workspaceId, month]
    )

    useEffect(() => {
        if (isOnline && workspaceId) {
            fetchTableFromSupabase('expense_items', db.expense_items, workspaceId)
        }
    }, [isOnline, workspaceId])

    return items ?? []
}

function buildDueDateFromMonth(month: string, dueDay: number): string {
    const [year, monthIndex] = month.split('-').map(Number)
    const daysInMonth = new Date(year, monthIndex, 0).getDate()
    const day = Math.min(Math.max(dueDay, 1), daysInMonth)
    return `${month}-${String(day).padStart(2, '0')}`
}

export async function createExpenseItem(
    workspaceId: string,
    data: Omit<ExpenseItem, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>
): Promise<ExpenseItem> {
    const now = new Date().toISOString()
    const item: ExpenseItem = {
        ...data,
        id: generateId(),
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    await saveEntity('expense_items', db.expense_items, item, workspaceId)
    return item
}

export async function updateExpenseItem(id: string, data: Partial<ExpenseItem>): Promise<void> {
    await updateEntity('expense_items', db.expense_items, id, data)
}

export async function ensureExpenseItemsForMonth(workspaceId: string, month: string): Promise<void> {
    const series = await db.expense_series.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).toArray()
    if (series.length === 0) return

    const existingItems = await db.expense_items.where('workspaceId').equals(workspaceId).and(i => !i.isDeleted && i.month === month).toArray()
    const existingKey = new Set(existingItems.map(item => `${item.seriesId}:${item.month}`))

    const toCreate: ExpenseItem[] = []
    const now = new Date().toISOString()

    for (const entry of series) {
        const seriesStart = entry.startMonth
        const seriesEnd = entry.endMonth || null

        if (month < seriesStart) continue
        if (seriesEnd && month > seriesEnd) continue
        if (entry.recurrence === 'one_time' && month !== seriesStart) continue

        const key = `${entry.id}:${month}`
        if (existingKey.has(key)) continue

        const dueDate = buildDueDateFromMonth(month, entry.dueDay)

        toCreate.push({
            id: generateId(),
            workspaceId,
            seriesId: entry.id,
            month,
            dueDate,
            amount: entry.amount,
            currency: entry.currency,
            status: 'pending',
            snoozedUntil: null,
            snoozedIndefinite: false,
            snoozeCount: 0,
            paidAt: null,
            isLocked: false,
            createdAt: now,
            updatedAt: now,
            syncStatus: (isOnline() ? 'synced' : 'pending') as any,
            lastSyncedAt: isOnline() ? now : null,
            version: 1,
            isDeleted: false
        } as ExpenseItem)
    }

    if (toCreate.length === 0) return

    if (isOnline()) {
        const payload = toCreate.map(item => toSnakeCase({ ...item, syncStatus: undefined, lastSyncedAt: undefined }))
        const client = getSupabaseClientForTable('expense_items')
        const { error } = await runMutation('expense_items.bulkCreate', () => client.from('expense_items').insert(payload))
        if (error) throw normalizeSupabaseActionError(error)
        await db.expense_items.bulkAdd(toCreate)
    } else {
        await db.expense_items.bulkAdd(toCreate)
        for (const item of toCreate) {
            await addToOfflineMutations('expense_items', item.id, 'create', item as unknown as Record<string, unknown>, workspaceId)
        }
    }
}

export function usePayrollStatuses(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const statuses = useLiveQuery(
        () => workspaceId ? db.payroll_statuses.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        if (isOnline && workspaceId) {
            fetchTableFromSupabase('payroll_statuses', db.payroll_statuses, workspaceId)
        }
    }, [isOnline, workspaceId])

    return statuses ?? []
}

export function useDividendStatuses(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const statuses = useLiveQuery(
        () => workspaceId ? db.dividend_statuses.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        if (isOnline && workspaceId) {
            fetchTableFromSupabase('dividend_statuses', db.dividend_statuses, workspaceId)
        }
    }, [isOnline, workspaceId])

    return statuses ?? []
}

async function upsertBudgetStatus<T extends PayrollStatus | DividendStatus>(
    tableName: 'payroll_statuses' | 'dividend_statuses',
    table: any,
    workspaceId: string,
    employeeId: string,
    month: string,
    data: Partial<T>
): Promise<void> {
    const existing = await table
        .where('[employeeId+month]')
        .equals([employeeId, month])
        .and((s: T) => !s.isDeleted)
        .first()

    if (existing) {
        await updateEntity(tableName, table, existing.id, data)
        return
    }

    const now = new Date().toISOString()
    const status = {
        id: generateId(),
        workspaceId,
        employeeId,
        month,
        status: 'pending',
        snoozedUntil: null,
        snoozedIndefinite: false,
        snoozeCount: 0,
        paidAt: null,
        isLocked: false,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false,
        ...data
    }

    await saveEntity(tableName, table, status, workspaceId)
}

export async function upsertPayrollStatus(
    workspaceId: string,
    employeeId: string,
    month: string,
    data: Partial<PayrollStatus>
): Promise<void> {
    await upsertBudgetStatus('payroll_statuses', db.payroll_statuses, workspaceId, employeeId, month, data)
}

export async function upsertDividendStatus(
    workspaceId: string,
    employeeId: string,
    month: string,
    data: Partial<DividendStatus>
): Promise<void> {
    await upsertBudgetStatus('dividend_statuses', db.dividend_statuses, workspaceId, employeeId, month, data)
}

// ===================
// WORKSPACE CONTACTS HOOKS
// ===================

export function useWorkspaceContacts(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    const contacts = useLiveQuery(
        () => workspaceId ? db.workspace_contacts.where('workspaceId').equals(workspaceId).toArray() : [],
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId) {
                const { data, error } = await supabase
                    .from('workspace_contacts')
                    .select('*')
                    .eq('workspace_id', workspaceId)

                if (data && !error) {
                    await db.transaction('rw', db.workspace_contacts, async () => {
                        const remoteIds = new Set(data.map(d => d.id))
                        const localItems = await db.workspace_contacts.where('workspaceId').equals(workspaceId).toArray()

                        // Cleanup local synced items that are gone from server
                        for (const local of localItems) {
                            if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                                await db.workspace_contacts.delete(local.id)
                            }
                        }

                        for (const remoteItem of data) {
                            const localItem = toCamelCase(remoteItem as any) as unknown as WorkspaceContact
                            localItem.syncStatus = 'synced'
                            localItem.lastSyncedAt = new Date().toISOString()
                            await db.workspace_contacts.put(localItem)
                        }
                    })
                }
            }
        }
        fetchFromSupabase()
    }, [isOnline, workspaceId])

    return contacts ?? []
}

export async function createWorkspaceContact(workspaceId: string, data: Omit<WorkspaceContact, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version'>): Promise<WorkspaceContact> {
    const now = new Date().toISOString()
    const id = generateId()

    const contact: WorkspaceContact = {
        ...data,
        id,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: isOnline() ? 'synced' : 'pending',
        lastSyncedAt: isOnline() ? now : null,
        version: 1
    }

    if (isOnline()) {
        const payload = toSnakeCase(contact as any)
        const { error } = await runMutation('workspace_contacts.create', () => supabase.from('workspace_contacts').insert(payload))
        if (error) throw normalizeSupabaseActionError(error)
        await db.workspace_contacts.put(contact)
    } else {
        await db.workspace_contacts.put(contact)
        await addToOfflineMutations('workspace_contacts', id, 'create', contact as any, workspaceId)
    }

    return contact
}

export async function updateWorkspaceContact(id: string, data: Partial<WorkspaceContact>): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.workspace_contacts.get(id)
    if (!existing) throw new Error('Contact not found')

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus: isOnline() ? 'synced' : 'pending',
        lastSyncedAt: isOnline() ? now : existing.lastSyncedAt,
        version: existing.version + 1
    } as WorkspaceContact

    if (isOnline()) {
        const payload = toSnakeCase({ ...data, updatedAt: now })
        const { error } = await runMutation('workspace_contacts.update', () => supabase.from('workspace_contacts').update(payload).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)
        await db.workspace_contacts.put(updated)
    } else {
        await db.workspace_contacts.put(updated)
        await addToOfflineMutations('workspace_contacts', id, 'update', updated as any, existing.workspaceId)
    }
}

export async function deleteWorkspaceContact(id: string): Promise<void> {
    const existing = await db.workspace_contacts.get(id)
    if (!existing) return

    if (isOnline()) {
        const { error } = await runMutation('workspace_contacts.delete', () => supabase.from('workspace_contacts').delete().eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)
        await db.workspace_contacts.delete(id)
    } else {
        // OFFLINE: Local Hard Delete + Mutation Record
        await db.workspace_contacts.delete(id)
        await addToOfflineMutations('workspace_contacts', id, 'delete', { id }, existing.workspaceId)
    }
}

// ===================
// LOANS HOOKS
// ===================

function normalizeDueDate(value: string): string {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) {
        return new Date().toISOString().slice(0, 10)
    }
    return d.toISOString().slice(0, 10)
}

function roundLoanAmount(amount: number, currency: CurrencyCode): number {
    if (currency === 'iqd') {
        return Math.round(amount)
    }
    return Number(amount.toFixed(2))
}

function generateLoanNo(id: string, now = new Date()): string {
    return `LN-${now.getFullYear()}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`
}

function addInstallmentDate(baseDate: string, frequency: InstallmentFrequency, index: number): string {
    const d = new Date(`${baseDate}T00:00:00`)
    if (frequency === 'weekly') {
        d.setDate(d.getDate() + (index * 7))
    } else if (frequency === 'biweekly') {
        d.setDate(d.getDate() + (index * 14))
    } else {
        d.setMonth(d.getMonth() + index)
    }
    return d.toISOString().slice(0, 10)
}

function computeInstallmentStatus(dueDate: string, balanceAmount: number): InstallmentStatus {
    if (balanceAmount <= 0) return 'paid'
    const today = new Date().toISOString().slice(0, 10)
    return dueDate < today ? 'overdue' : 'unpaid'
}

function computeLoanStatus(nextDueDate: string | null | undefined, balanceAmount: number): LoanStatus {
    if (balanceAmount <= 0) return 'completed'
    const today = new Date().toISOString().slice(0, 10)
    if (nextDueDate && nextDueDate < today) return 'overdue'
    return 'active'
}

function createInstallmentPlan(
    principalAmount: number,
    settlementCurrency: CurrencyCode,
    installmentCount: number,
    installmentFrequency: InstallmentFrequency,
    firstDueDate: string
): Array<{ installmentNo: number; dueDate: string; plannedAmount: number }> {
    const safeCount = Math.max(1, Math.trunc(installmentCount))
    const safePrincipal = roundLoanAmount(Math.max(0, principalAmount), settlementCurrency)
    const baseAmount = roundLoanAmount(safePrincipal / safeCount, settlementCurrency)
    const plan: Array<{ installmentNo: number; dueDate: string; plannedAmount: number }> = []
    let accumulated = 0

    for (let i = 0; i < safeCount; i++) {
        const dueDate = addInstallmentDate(firstDueDate, installmentFrequency, i)
        const plannedAmount = i === safeCount - 1
            ? roundLoanAmount(safePrincipal - accumulated, settlementCurrency)
            : baseAmount
        accumulated = roundLoanAmount(accumulated + plannedAmount, settlementCurrency)
        plan.push({
            installmentNo: i + 1,
            dueDate,
            plannedAmount
        })
    }

    return plan
}

function toSupabaseLoanPayload(entity: Record<string, unknown>): Record<string, unknown> {
    const payload = toSnakeCase(entity)
    // Local offline metadata; not present in Supabase schema
    delete payload.sync_status
    delete payload.last_synced_at
    for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) {
            delete payload[key]
        }
    }
    return payload
}

async function enqueueLoanCreateMutations(workspaceId: string, loan: Loan, installments: LoanInstallment[]) {
    await addToOfflineMutations('loans', loan.id, 'create', loan as unknown as Record<string, unknown>, workspaceId)
    await Promise.all(
        installments.map(installment =>
            addToOfflineMutations(
                'loan_installments',
                installment.id,
                'create',
                installment as unknown as Record<string, unknown>,
                workspaceId
            )
        )
    )
}

interface LoanCreateInput {
    saleId?: string | null
    source: 'pos' | 'manual'
    borrowerName: string
    borrowerPhone: string
    borrowerAddress: string
    borrowerNationalId: string
    principalAmount: number
    settlementCurrency: CurrencyCode
    installmentCount: number
    installmentFrequency: InstallmentFrequency
    firstDueDate: string
    notes?: string
    createdBy?: string
}

export function isLoanDeletionAllowed(
    loan: Pick<Loan, 'source' | 'saleId'>,
    hasLinkedActiveSale: boolean
): boolean {
    if (loan.source === 'manual') return true
    if (!loan.saleId) return true
    return !hasLinkedActiveSale
}

async function createLoanAggregate(workspaceId: string, input: LoanCreateInput): Promise<{ loan: Loan; installments: LoanInstallment[] }> {
    const now = new Date().toISOString()
    const loanId = generateId()
    const firstDueDate = normalizeDueDate(input.firstDueDate)
    const principalAmount = roundLoanAmount(Math.max(0, Number(input.principalAmount || 0)), input.settlementCurrency)
    const borrowerName = typeof input.borrowerName === 'string' ? input.borrowerName.trim() : ''
    const borrowerPhone = typeof input.borrowerPhone === 'string' ? input.borrowerPhone.trim() : ''
    const borrowerAddress = typeof input.borrowerAddress === 'string' ? input.borrowerAddress.trim() : ''
    const borrowerNationalId = typeof input.borrowerNationalId === 'string' ? input.borrowerNationalId.trim() : ''

    if (!principalAmount || principalAmount <= 0) {
        throw new Error('Invalid principal amount')
    }
    if (!borrowerName || !borrowerPhone || !borrowerAddress || !borrowerNationalId) {
        throw new Error('Missing borrower information')
    }

    const plan = createInstallmentPlan(
        principalAmount,
        input.settlementCurrency,
        input.installmentCount,
        input.installmentFrequency,
        firstDueDate
    )

    const installments: LoanInstallment[] = plan.map(entry => {
        const status = computeInstallmentStatus(entry.dueDate, entry.plannedAmount)
        return {
            id: generateId(),
            workspaceId,
            loanId,
            installmentNo: entry.installmentNo,
            dueDate: entry.dueDate,
            plannedAmount: entry.plannedAmount,
            paidAmount: 0,
            balanceAmount: entry.plannedAmount,
            status,
            paidAt: null,
            createdAt: now,
            updatedAt: now,
            syncStatus: 'pending',
            lastSyncedAt: null,
            version: 1,
            isDeleted: false
        }
    })

    const nextDueDate = installments.find(item => item.balanceAmount > 0)?.dueDate || null
    const loan: Loan = {
        id: loanId,
        workspaceId,
        saleId: input.saleId ?? null,
        loanNo: generateLoanNo(loanId),
        source: input.source,
        borrowerName,
        borrowerPhone,
        borrowerAddress,
        borrowerNationalId,
        principalAmount,
        totalPaidAmount: 0,
        balanceAmount: principalAmount,
        settlementCurrency: input.settlementCurrency,
        installmentCount: Math.max(1, Math.trunc(input.installmentCount)),
        installmentFrequency: input.installmentFrequency,
        firstDueDate,
        nextDueDate,
        overdueReminderSnoozedAt: null,
        overdueReminderSnoozedForDueDate: null,
        status: computeLoanStatus(nextDueDate, principalAmount),
        notes: input.notes?.trim(),
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false
    }

    await db.transaction('rw', [db.loans, db.loan_installments], async () => {
        await db.loans.put(loan)
        for (const installment of installments) {
            await db.loan_installments.put(installment)
        }
    })

    if (!isOnline()) {
        await enqueueLoanCreateMutations(workspaceId, loan, installments)
        return { loan, installments }
    }

    try {
        const loanPayload = toSupabaseLoanPayload(loan as unknown as Record<string, unknown>)
        const installmentPayload = installments.map(installment =>
            toSupabaseLoanPayload(installment as unknown as Record<string, unknown>)
        )

        const { error: loanError } = await runMutation('loans.create', () => supabase.from('loans').upsert(loanPayload))
        if (loanError) throw loanError

        const { error: installmentError } = await runMutation('loan_installments.create', () => supabase.from('loan_installments').upsert(installmentPayload))
        if (installmentError) throw installmentError

        const syncedAt = new Date().toISOString()
        await db.transaction('rw', [db.loans, db.loan_installments], async () => {
            await db.loans.update(loan.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            for (const installment of installments) {
                await db.loan_installments.update(installment.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            }
        })

        return {
            loan: { ...loan, syncStatus: 'synced', lastSyncedAt: syncedAt },
            installments: installments.map(item => ({ ...item, syncStatus: 'synced', lastSyncedAt: syncedAt }))
        }
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Online create failed, queued offline mutation:', error)
            await enqueueLoanCreateMutations(workspaceId, loan, installments)
            return { loan, installments }
        }

        await db.transaction('rw', [db.loans, db.loan_installments], async () => {
            await db.loans.delete(loan.id)
            for (const installment of installments) {
                await db.loan_installments.delete(installment.id)
            }
        })

        throw normalizeSupabaseActionError(error)
    }
}

export function useLoans(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const loans = useLiveQuery(
        () => workspaceId
            ? db.loans.where('workspaceId').equals(workspaceId).and(item => !item.isDeleted).reverse().sortBy('createdAt')
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId) {
            fetchTableFromSupabase('loans', db.loans, workspaceId)
        }
    }, [online, workspaceId])

    return loans ?? []
}

export function useLoan(loanId: string | undefined) {
    return useLiveQuery(() => loanId ? db.loans.get(loanId) : undefined, [loanId])
}

export function useLoanBySaleId(saleId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()

    const loan = useLiveQuery(
        async () => {
            if (!saleId) return undefined
            const rows = await db.loans.where('saleId').equals(saleId).and(item => !item.isDeleted).toArray()
            if (rows.length === 0) return undefined
            return rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
        },
        [saleId]
    )

    useEffect(() => {
        if (online && workspaceId) {
            fetchTableFromSupabase('loans', db.loans, workspaceId)
        }
    }, [online, workspaceId])

    return loan
}

export function useLoanInstallments(loanId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()

    const installments = useLiveQuery(
        () => loanId
            ? db.loan_installments.where('loanId').equals(loanId).and(item => !item.isDeleted).sortBy('installmentNo')
            : [],
        [loanId]
    )

    useEffect(() => {
        if (online && workspaceId) {
            fetchTableFromSupabase('loan_installments', db.loan_installments, workspaceId)
        }
    }, [online, workspaceId])

    return installments ?? []
}

export function useLoanPayments(loanId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()

    const payments = useLiveQuery(
        async () => {
            if (!loanId) return []
            const rows = await db.loan_payments.where('loanId').equals(loanId).and(item => !item.isDeleted).toArray()
            return rows.sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
        },
        [loanId]
    )

    useEffect(() => {
        if (online && workspaceId) {
            fetchTableFromSupabase('loan_payments', db.loan_payments, workspaceId)
        }
    }, [online, workspaceId])

    return payments ?? []
}

export async function createManualLoan(
    workspaceId: string,
    input: Omit<LoanCreateInput, 'source'>
): Promise<{ loan: Loan; installments: LoanInstallment[] }> {
    return createLoanAggregate(workspaceId, { ...input, source: 'manual' })
}

export async function createLoanFromPosSale(
    workspaceId: string,
    input: Omit<LoanCreateInput, 'source'>
): Promise<{ loan: Loan; installments: LoanInstallment[] }> {
    return createLoanAggregate(workspaceId, { ...input, source: 'pos' })
}

export async function updateLoanReminderSnooze(
    loanId: string,
    input: {
        snoozedAt: string | null
        snoozedForDueDate: string | null
    }
): Promise<Loan> {
    const existing = await db.loans.get(loanId)
    if (!existing || existing.isDeleted) {
        throw new Error('Loan not found')
    }

    const now = new Date().toISOString()
    const updatedLoan: Loan = {
        ...existing,
        overdueReminderSnoozedAt: input.snoozedAt,
        overdueReminderSnoozedForDueDate: input.snoozedForDueDate,
        updatedAt: now,
        version: existing.version + 1,
        syncStatus: 'pending',
        lastSyncedAt: null
    }

    await db.loans.put(updatedLoan)

    const enqueueMutation = async () => {
        await addToOfflineMutations(
            'loans',
            updatedLoan.id,
            'update',
            updatedLoan as unknown as Record<string, unknown>,
            existing.workspaceId
        )
    }

    if (!isOnline()) {
        await enqueueMutation()
        return updatedLoan
    }

    try {
        const { error } = await runMutation('loans.reminderSnooze.update', () =>
            supabase
                .from('loans')
                .update(toSnakeCase({
                    overdueReminderSnoozedAt: updatedLoan.overdueReminderSnoozedAt,
                    overdueReminderSnoozedForDueDate: updatedLoan.overdueReminderSnoozedForDueDate,
                    updatedAt: updatedLoan.updatedAt,
                    version: updatedLoan.version
                }))
                .eq('id', updatedLoan.id)
        )
        if (error) throw error

        const syncedAt = new Date().toISOString()
        await db.loans.update(updatedLoan.id, {
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        })

        return {
            ...updatedLoan,
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        }
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Reminder snooze sync failed, queued offline mutation:', error)
            await enqueueMutation()
            return updatedLoan
        }

        await db.loans.put(existing)
        throw normalizeSupabaseActionError(error)
    }
}

export async function deleteLoan(loanId: string): Promise<void> {
    const loan = await db.loans.get(loanId)
    if (!loan || loan.isDeleted) {
        return
    }

    const linkedSale = loan.saleId ? await db.sales.get(loan.saleId) : undefined
    const hasLinkedActiveSale = Boolean(linkedSale && !linkedSale.isDeleted)
    if (!isLoanDeletionAllowed(loan, hasLinkedActiveSale)) {
        throw new Error('loan_delete_not_allowed')
    }

    const [installments, payments, offlineMutations] = await Promise.all([
        db.loan_installments.where('loanId').equals(loanId).toArray(),
        db.loan_payments.where('loanId').equals(loanId).toArray(),
        db.offline_mutations.where('workspaceId').equals(loan.workspaceId).toArray()
    ])

    const installmentIds = new Set(installments.map(item => item.id))
    const paymentIds = new Set(payments.map(item => item.id))
    const relatedMutationIds = offlineMutations
        .filter(mutation => {
            if (mutation.status === 'synced') {
                return false
            }

            if (mutation.entityType === 'loans') {
                return mutation.entityId === loanId
            }

            if (mutation.entityType === 'loan_installments') {
                return installmentIds.has(mutation.entityId)
            }

            if (mutation.entityType === 'loan_payments') {
                return paymentIds.has(mutation.entityId)
            }

            return false
        })
        .map(mutation => mutation.id)

    const removeLoanAggregateLocally = async (enqueueDeleteMutation: boolean) => {
        await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments, db.offline_mutations], async () => {
            await db.loans.delete(loanId)
            if (installments.length > 0) {
                await db.loan_installments.bulkDelete(installments.map(item => item.id))
            }
            if (payments.length > 0) {
                await db.loan_payments.bulkDelete(payments.map(item => item.id))
            }
            if (relatedMutationIds.length > 0) {
                await db.offline_mutations.bulkDelete(relatedMutationIds)
            }
            if (enqueueDeleteMutation) {
                await db.offline_mutations.add({
                    id: generateId(),
                    workspaceId: loan.workspaceId,
                    entityType: 'loans',
                    entityId: loanId,
                    operation: 'delete',
                    payload: { id: loanId },
                    createdAt: new Date().toISOString(),
                    status: 'pending'
                })
            }
        })
    }

    if (!isOnline()) {
        await removeLoanAggregateLocally(true)
        return
    }

    try {
        const { error } = await runMutation('loans.delete', () =>
            supabase.from('loans').delete().eq('id', loanId)
        )
        if (error) throw error

        await removeLoanAggregateLocally(false)
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Delete sync failed, queued offline mutation:', error)
            await removeLoanAggregateLocally(true)
            return
        }

        throw normalizeSupabaseActionError(error)
    }
}

interface LoanPaymentInput {
    loanId: string
    amount: number
    paymentMethod: LoanPaymentMethod
    note?: string
    paidAt?: string
    createdBy?: string
}

export async function recordLoanPayment(workspaceId: string, input: LoanPaymentInput): Promise<{
    loan: Loan
    payment: LoanPayment
    installments: LoanInstallment[]
}> {
    const loan = await db.loans.get(input.loanId)
    if (!loan || loan.isDeleted) {
        throw new Error('Loan not found')
    }

    const installmentRows = await db.loan_installments
        .where('loanId')
        .equals(input.loanId)
        .and(item => !item.isDeleted)
        .sortBy('installmentNo')

    if (installmentRows.length === 0) {
        throw new Error('Loan installments not found')
    }

    const requestedAmount = roundLoanAmount(Math.max(0, Number(input.amount || 0)), loan.settlementCurrency)
    const payableAmount = roundLoanAmount(Math.min(requestedAmount, loan.balanceAmount), loan.settlementCurrency)
    if (payableAmount <= 0) {
        throw new Error('Invalid payment amount')
    }

    const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString()
    let remaining = payableAmount
    const now = new Date().toISOString()

    const updatedInstallments: LoanInstallment[] = installmentRows.map(item => ({ ...item }))
    for (const installment of updatedInstallments) {
        if (remaining <= 0) break
        if (installment.balanceAmount <= 0) continue

        const applied = roundLoanAmount(Math.min(installment.balanceAmount, remaining), loan.settlementCurrency)
        if (applied <= 0) continue

        installment.paidAmount = roundLoanAmount(installment.paidAmount + applied, loan.settlementCurrency)
        installment.balanceAmount = roundLoanAmount(Math.max(installment.balanceAmount - applied, 0), loan.settlementCurrency)
        installment.status = installment.balanceAmount <= 0 ? 'paid' : 'partial'
        installment.paidAt = installment.status === 'paid' ? paidAt : installment.paidAt
        installment.updatedAt = now
        installment.version = installment.version + 1
        installment.syncStatus = 'pending'
        installment.lastSyncedAt = null
        remaining = roundLoanAmount(Math.max(remaining - applied, 0), loan.settlementCurrency)
    }

    const today = new Date().toISOString().slice(0, 10)
    for (const installment of updatedInstallments) {
        if (installment.status === 'paid') continue
        if (installment.balanceAmount <= 0) {
            installment.status = 'paid'
            continue
        }
        if (installment.dueDate < today && installment.status !== 'partial') {
            installment.status = 'overdue'
        } else if (installment.status !== 'partial') {
            installment.status = 'unpaid'
        }
    }

    const updatedLoan: Loan = {
        ...loan,
        totalPaidAmount: roundLoanAmount(loan.totalPaidAmount + payableAmount, loan.settlementCurrency),
        balanceAmount: roundLoanAmount(Math.max(loan.balanceAmount - payableAmount, 0), loan.settlementCurrency),
        updatedAt: now,
        version: loan.version + 1,
        syncStatus: 'pending',
        lastSyncedAt: null
    }

    const nextDueDate = updatedInstallments.find(item => item.balanceAmount > 0)?.dueDate || null
    updatedLoan.nextDueDate = nextDueDate
    updatedLoan.status = computeLoanStatus(nextDueDate, updatedLoan.balanceAmount)
    if (updatedInstallments.some(item => item.status === 'overdue')) {
        updatedLoan.status = updatedLoan.balanceAmount <= 0 ? 'completed' : 'overdue'
    }
    const oldestOverdueDueDate = updatedInstallments.find(item => item.balanceAmount > 0 && item.dueDate < today)?.dueDate || null
    if (!oldestOverdueDueDate || oldestOverdueDueDate !== loan.overdueReminderSnoozedForDueDate) {
        updatedLoan.overdueReminderSnoozedAt = null
        updatedLoan.overdueReminderSnoozedForDueDate = null
    }

    const payment: LoanPayment = {
        id: generateId(),
        workspaceId,
        loanId: loan.id,
        amount: payableAmount,
        paymentMethod: input.paymentMethod,
        paidAt,
        note: input.note?.trim(),
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'pending',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false
    }

    await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
        await db.loans.put(updatedLoan)
        for (const installment of updatedInstallments) {
            await db.loan_installments.put(installment)
        }
        await db.loan_payments.put(payment)
    })

    const enqueueMutations = async () => {
        await addToOfflineMutations('loans', updatedLoan.id, 'update', updatedLoan as unknown as Record<string, unknown>, workspaceId)
        await Promise.all(updatedInstallments.map(installment =>
            addToOfflineMutations(
                'loan_installments',
                installment.id,
                'update',
                installment as unknown as Record<string, unknown>,
                workspaceId
            )
        ))
        await addToOfflineMutations('loan_payments', payment.id, 'create', payment as unknown as Record<string, unknown>, workspaceId)
    }

    if (!isOnline()) {
        await enqueueMutations()
        return { loan: updatedLoan, payment, installments: updatedInstallments }
    }

    try {
        const { error: loanError } = await runMutation('loans.recordPayment.loan', () =>
            supabase
                .from('loans')
                .update(toSnakeCase({
                    totalPaidAmount: updatedLoan.totalPaidAmount,
                    balanceAmount: updatedLoan.balanceAmount,
                    nextDueDate: updatedLoan.nextDueDate,
                    overdueReminderSnoozedAt: updatedLoan.overdueReminderSnoozedAt,
                    overdueReminderSnoozedForDueDate: updatedLoan.overdueReminderSnoozedForDueDate,
                    status: updatedLoan.status,
                    updatedAt: updatedLoan.updatedAt,
                    version: updatedLoan.version
                }))
                .eq('id', updatedLoan.id)
        )
        if (loanError) throw loanError

        const { error: installmentsError } = await runMutation('loans.recordPayment.installments', () =>
            supabase.from('loan_installments').upsert(
                updatedInstallments.map(installment =>
                    toSupabaseLoanPayload(installment as unknown as Record<string, unknown>)
                )
            )
        )
        if (installmentsError) throw installmentsError

        const { error: paymentError } = await runMutation('loans.recordPayment.payment', () =>
            supabase
                .from('loan_payments')
                .insert(toSupabaseLoanPayload(payment as unknown as Record<string, unknown>))
        )
        if (paymentError) throw paymentError

        const syncedAt = new Date().toISOString()
        await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
            await db.loans.update(updatedLoan.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            for (const installment of updatedInstallments) {
                await db.loan_installments.update(installment.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            }
            await db.loan_payments.update(payment.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
        })

        return {
            loan: { ...updatedLoan, syncStatus: 'synced', lastSyncedAt: syncedAt },
            payment: { ...payment, syncStatus: 'synced', lastSyncedAt: syncedAt },
            installments: updatedInstallments.map(item => ({ ...item, syncStatus: 'synced', lastSyncedAt: syncedAt }))
        }
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Payment sync failed, queued offline mutation:', error)
            await enqueueMutations()
            return { loan: updatedLoan, payment, installments: updatedInstallments }
        }

        await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
            await db.loans.put(loan)
            for (const installment of installmentRows) {
                await db.loan_installments.put(installment)
            }
            await db.loan_payments.delete(payment.id)
        })

        throw normalizeSupabaseActionError(error)
    }
}

