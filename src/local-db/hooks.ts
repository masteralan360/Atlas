import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { db } from './database'
import { createInventoryTransferTransactions } from './inventoryTransferTransactions'
import { addToOfflineMutations } from './offlineMutations'
import { getPrimaryStorageId as getPrimaryStorageIdForWorkspace, normalizeStorageRecord, sortStoragesByPriority } from './storageUtils'
import {
    deleteInventoryForProduct,
    getInventoryQuantityForProductStorage,
    setProductInventoryFromLegacyInput,
    transferInventoryQuantity,
    useInventory
} from './inventory'
import type {
    Product,
    Category,
    ProductDiscount,
    CategoryDiscount,
    Invoice,
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
    LoanCategory,
    LoanDirection,
    LoanLinkedPartyType,
    LoanPaymentMethod,
    LoanStatus,
    ExchangeRateSnapshot,
    PaymentTransaction,
    PaymentTransactionSourceType
} from './models'
import { generateId, toSnakeCase, toCamelCase } from '@/lib/utils'
import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { resolveActiveDiscountMap, type ResolvedActiveDiscount } from '@/lib/discounts'
import { convertCurrencyAmountWithAvailableSnapshot, getEffectiveExchangeRatesSnapshot } from '@/lib/orderCurrency'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

export { addToOfflineMutations } from './offlineMutations'

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

function shouldUseCloudBusinessData(workspaceId?: string | null): boolean {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

const LOAN_PAYMENT_TRANSACTION_SOURCE_TYPES: PaymentTransactionSourceType[] = ['loan_origination', 'loan_payment', 'simple_loan', 'loan_installment']
const LOAN_SETTLEMENT_TRANSACTION_SOURCE_TYPES: PaymentTransactionSourceType[] = ['loan_payment', 'simple_loan', 'loan_installment']

async function syncUpdatedProductsBestEffort(products: Product[], workspaceId: string): Promise<void> {
    const dedupedProducts = Array.from(new Map(products.map((product) => [product.id, product])).values())
    if (dedupedProducts.length === 0) {
        return
    }

    if (isOnline() && shouldUseCloudBusinessData(workspaceId)) {
        try {
            const payload = dedupedProducts.map((product) => toSnakeCase({
                ...product,
                syncStatus: undefined,
                lastSyncedAt: undefined,
                storageName: undefined
            }))

            const { error } = await runMutation('products.inventorySync', () =>
                supabase.from('products').upsert(payload)
            )

            if (error) {
                throw normalizeSupabaseActionError(error)
            }

            const syncedAt = new Date().toISOString()
            await Promise.all(dedupedProducts.map((product) =>
                db.products.update(product.id, {
                    syncStatus: 'synced',
                    lastSyncedAt: syncedAt
                })
            ))
            return
        } catch (error) {
            if (!shouldUseOfflineMutationFallback(error)) {
                throw normalizeSupabaseActionError(error)
            }
        }
    }

    await Promise.all(dedupedProducts.map((product) =>
        addToOfflineMutations('products', product.id, 'update', product as unknown as Record<string, unknown>, workspaceId)
    ))
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
            if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
                const { data, error } = await supabase
                    .from('categories')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
                    return
                }

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
            if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
                const { data, error } = await supabase
                    .from('products')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
                    return
                }

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

                    for (const remoteItem of data) {
                        const localItem = toCamelCase(remoteItem as any) as unknown as Product
                        await setProductInventoryFromLegacyInput({
                            workspaceId,
                            productId: localItem.id,
                            storageId: localItem.storageId ?? null,
                            quantity: Number(localItem.quantity) || 0,
                            timestamp: localItem.updatedAt,
                            syncSource: 'remote',
                            skipRemoteSync: true
                        })
                    }
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

    const normalizedProduct = await setProductInventoryFromLegacyInput({
        workspaceId,
        productId: id,
        storageId: data.storageId ?? null,
        quantity: Number(data.quantity) || 0,
        timestamp: now
    })

    return normalizedProduct || product
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

    await setProductInventoryFromLegacyInput({
        workspaceId: existing.workspaceId,
        productId: id,
        storageId: data.storageId ?? existing.storageId ?? null,
        quantity: typeof data.quantity === 'number' ? data.quantity : updated.quantity,
        timestamp: now
    })
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

    await deleteInventoryForProduct(id, now)
}

type DiscountEntity = ProductDiscount | CategoryDiscount
type DiscountEntityTableName = 'product_discounts' | 'category_discounts'

function useDiscountTable<T extends DiscountEntity>(
    workspaceId: string | undefined,
    tableName: DiscountEntityTableName,
    table: any
) {
    const online = useNetworkStatus()

    const rows = useLiveQuery(
        () => workspaceId
            ? table.where('workspaceId').equals(workspaceId).and((item: T) => !item.isDeleted).toArray()
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (!workspaceId || !online || !shouldUseCloudBusinessData(workspaceId)) {
            return
        }

        void fetchTableFromSupabase(tableName, table, workspaceId)
    }, [online, table, tableName, workspaceId])

    return rows ?? []
}

async function createDiscountEntity<T extends DiscountEntity>(
    tableName: DiscountEntityTableName,
    table: any,
    workspaceId: string,
    data: Omit<T, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>
): Promise<T> {
    const now = new Date().toISOString()
    const id = generateId()
    const usesCloud = shouldUseCloudBusinessData(workspaceId)
    const syncStatus: T['syncStatus'] = usesCloud
        ? (isOnline() ? 'synced' : 'pending')
        : 'synced'

    const session = usesCloud && isOnline()
        ? await getMutationSession(`${tableName}.create`)
        : null

    const entity: T = {
        ...data,
        id,
        workspaceId,
        createdBy: data.createdBy ?? session?.user?.id,
        createdAt: now,
        updatedAt: now,
        syncStatus,
        lastSyncedAt: syncStatus === 'synced' ? now : null,
        version: 1,
        isDeleted: false
    } as T

    if (usesCloud && isOnline()) {
        const payload = toSnakeCase({
            ...entity,
            syncStatus: undefined,
            lastSyncedAt: undefined
        })
        const { error } = await runMutation(`${tableName}.create`, () => supabase.from(tableName).insert(payload))
        if (error) {
            throw normalizeSupabaseActionError(error)
        }

        await table.put(entity)
        return entity
    }

    await table.put(entity)

    if (usesCloud) {
        await addToOfflineMutations(tableName, id, 'create', entity as unknown as Record<string, unknown>, workspaceId)
    }

    return entity
}

async function updateDiscountEntity<T extends DiscountEntity>(
    tableName: DiscountEntityTableName,
    table: any,
    id: string,
    data: Partial<T>
) {
    const now = new Date().toISOString()
    const existing = await table.get(id) as T | undefined
    if (!existing) {
        throw new Error('Discount not found')
    }

    const usesCloud = shouldUseCloudBusinessData(existing.workspaceId)
    const syncStatus: T['syncStatus'] = usesCloud
        ? (isOnline() ? 'synced' : 'pending')
        : 'synced'

    const updated: T = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus,
        lastSyncedAt: syncStatus === 'synced' ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (usesCloud && isOnline()) {
        const payload = toSnakeCase({
            ...data,
            updatedAt: now
        })
        const { error } = await runMutation(`${tableName}.update`, () => supabase.from(tableName).update(payload).eq('id', id))
        if (error) {
            throw normalizeSupabaseActionError(error)
        }

        await table.put(updated)
        return
    }

    await table.put(updated)

    if (usesCloud) {
        await addToOfflineMutations(tableName, id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }
}

async function deleteDiscountEntity(
    tableName: DiscountEntityTableName,
    table: any,
    id: string
) {
    const now = new Date().toISOString()
    const existing = await table.get(id) as DiscountEntity | undefined
    if (!existing) {
        return
    }

    const usesCloud = shouldUseCloudBusinessData(existing.workspaceId)
    const syncStatus: DiscountEntity['syncStatus'] = usesCloud
        ? (isOnline() ? 'synced' : 'pending')
        : 'synced'

    const updated = {
        ...existing,
        isActive: false,
        isDeleted: true,
        updatedAt: now,
        syncStatus,
        lastSyncedAt: syncStatus === 'synced' ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (usesCloud && isOnline()) {
        const { error } = await runMutation(`${tableName}.delete`, () =>
            supabase
                .from(tableName)
                .update({ is_deleted: true, is_active: false, updated_at: now })
                .eq('id', id)
        )

        if (error) {
            throw normalizeSupabaseActionError(error)
        }

        await table.put(updated)
        return
    }

    await table.put(updated)

    if (usesCloud) {
        await addToOfflineMutations(
            tableName,
            id,
            'delete',
            { id, is_deleted: true, is_active: false, updated_at: now },
            existing.workspaceId
        )
    }
}

export function useProductDiscounts(workspaceId: string | undefined) {
    return useDiscountTable<ProductDiscount>(workspaceId, 'product_discounts', db.product_discounts)
}

export function useCategoryDiscounts(workspaceId: string | undefined) {
    return useDiscountTable<CategoryDiscount>(workspaceId, 'category_discounts', db.category_discounts)
}

export function useActiveDiscountMap(workspaceId: string | undefined) {
    const products = useProducts(workspaceId)
    const inventory = useInventory(workspaceId)
    const productDiscounts = useProductDiscounts(workspaceId)
    const categoryDiscounts = useCategoryDiscounts(workspaceId)

    return useMemo<Map<string, ResolvedActiveDiscount>>(() => resolveActiveDiscountMap({
        products,
        productDiscounts,
        categoryDiscounts,
        inventoryRows: inventory
    }), [categoryDiscounts, inventory, productDiscounts, products])
}

export async function createProductDiscount(
    workspaceId: string,
    data: Omit<ProductDiscount, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>
) {
    return await createDiscountEntity<ProductDiscount>('product_discounts', db.product_discounts, workspaceId, data)
}

export async function updateProductDiscount(id: string, data: Partial<ProductDiscount>) {
    await updateDiscountEntity<ProductDiscount>('product_discounts', db.product_discounts, id, data)
}

export async function deleteProductDiscount(id: string) {
    await deleteDiscountEntity('product_discounts', db.product_discounts, id)
}

export async function createCategoryDiscount(
    workspaceId: string,
    data: Omit<CategoryDiscount, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>
) {
    return await createDiscountEntity<CategoryDiscount>('category_discounts', db.category_discounts, workspaceId, data)
}

export async function updateCategoryDiscount(id: string, data: Partial<CategoryDiscount>) {
    await updateDiscountEntity<CategoryDiscount>('category_discounts', db.category_discounts, id, data)
}

export async function deleteCategoryDiscount(id: string) {
    await deleteDiscountEntity('category_discounts', db.category_discounts, id)
}

// ===================

// ===================

// ===================

// Helpers for repetitive logic
export async function fetchTableFromSupabase<T extends { id: string, syncStatus: any, lastSyncedAt: any }>(
    tableName: string,
    table: any,
    workspaceId: string,
    options?: { includeDeleted?: boolean }
) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    const includeDeleted = options?.includeDeleted ?? false
    const client = getSupabaseClientForTable(tableName)
    let query = client
        .from(tableName)
        .select('*')
        .eq('workspace_id', workspaceId)

    // Only filter by is_deleted for tables that still have that column
    if (tableName !== 'workspace_contacts' && !includeDeleted) {
        query = query.eq('is_deleted', false)
    }

    const { data, error } = await query

    if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

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
            if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
                const { data, error } = await supabase
                    .from('invoices')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
                    return
                }

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

export async function createInvoice(
    workspaceId: string,
    data: Omit<Invoice, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'invoiceid'> & { sequenceId?: number; invoiceid?: string },
    overrideId?: string
): Promise<Invoice> {
    const now = new Date().toISOString()
    const invoiceid = data.invoiceid || `INV-${Date.now().toString(36).toUpperCase()}`
    const id = overrideId || generateId()
    const usesCloudBusinessData = shouldUseCloudBusinessData(workspaceId)
    const syncStatus: Invoice['syncStatus'] = usesCloudBusinessData
        ? (isOnline() ? 'synced' : 'pending')
        : 'synced'

    const invoice: Invoice = {
        ...data,
        id,
        workspaceId,
        invoiceid,
        createdAt: now,
        updatedAt: now,
        syncStatus,
        lastSyncedAt: syncStatus === 'synced' ? now : null,
        version: 1,
        isDeleted: false,
        createdByName: data.createdByName,
        cashierName: data.cashierName,
        sequenceId: data.sequenceId,
        printFormat: data.printFormat
    }


    if (usesCloudBusinessData && isOnline()) {
        // ONLINE
        // Omit items/blobs and legacy fields that don't belong in the table schema
        // We keep createdBy/created_by in local but map to user_id in remote for RLS
        const {
            items,
            currency,
            subtotal,
            discount,
            printMetadata,
            pdfBlobA4,
            pdfBlobReceipt,
            localPathA4,
            localPathReceipt,
            ...rest
        } = invoice as any

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
        // Local Mode and offline-cloud both persist locally first.
        await db.invoices.put(invoice)

        if (usesCloudBusinessData) {
            await addToOfflineMutations('invoices', id, 'create', invoice as unknown as Record<string, unknown>, workspaceId)
        }
    }

    return invoice
}

/**
 * Specifically for automated Invoice snapshots from Print Preview
 */
export async function saveInvoiceFromSnapshot(
    workspaceId: string,
    data: Omit<Invoice, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'invoiceid'> & { invoiceid?: string },
    overrideId?: string
): Promise<Invoice> {

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
    const usesCloudBusinessData = shouldUseCloudBusinessData(existing.workspaceId)
    const syncStatus: Invoice['syncStatus'] = usesCloudBusinessData
        ? (isOnline() ? 'synced' : 'pending')
        : 'synced'

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus,
        lastSyncedAt: syncStatus === 'synced' ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (usesCloudBusinessData && isOnline()) {
        // ONLINE
        // Filter out legacy fields from update payload
        const {
            items,
            currency,
            subtotal,
            discount,
            printMetadata,
            pdfBlobA4,
            pdfBlobReceipt,
            localPathA4,
            localPathReceipt,
            ...restData
        } = data as any
        const payload = toSnakeCase({ ...restData, updatedAt: now })
        const { error } = await runMutation('invoices.update', () => supabase.from('invoices').update(payload).eq('id', id))

        if (error) throw normalizeSupabaseActionError(error)

        await db.invoices.put(updated)
    } else {
        // Local Mode and offline-cloud both persist locally first.
        await db.invoices.put(updated)

        if (usesCloudBusinessData) {
            await addToOfflineMutations('invoices', id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
        }
    }
}

export async function deleteInvoice(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.invoices.get(id)
    if (!existing) return
    const usesCloudBusinessData = shouldUseCloudBusinessData(existing.workspaceId)
    const syncStatus: Invoice['syncStatus'] = usesCloudBusinessData
        ? (isOnline() ? 'synced' : 'pending')
        : 'synced'

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus,
        lastSyncedAt: syncStatus === 'synced' ? now : existing.lastSyncedAt,
        version: existing.version + 1
    } as Invoice

    if (usesCloudBusinessData && isOnline()) {
        // ONLINE
        const { error } = await runMutation('invoices.delete', () => supabase.from('invoices').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)

        await db.invoices.put(updated)
    } else {
        // Local Mode and offline-cloud both persist locally first.
        await db.invoices.put(updated)

        if (usesCloudBusinessData) {
            await addToOfflineMutations('invoices', id, 'delete', { id }, existing.workspaceId)
        }
    }
}

// ===================
// SALES HOOKS
// ===================

async function enrichSalesForUiRows(workspaceId: string, sales: Sale[]) {
    if (sales.length === 0) {
        return sales
    }

    const saleIds = sales.map((sale) => sale.id)
    const localItems = saleIds.length > 0
        ? await db.sale_items.where('saleId').anyOf(saleIds).toArray()
        : []

    const productIds = Array.from(new Set(
        localItems
            .map((item) => item.productId)
            .filter((productId): productId is string => typeof productId === 'string' && productId.length > 0)
    ))
    const products = productIds.length > 0
        ? await db.products.bulkGet(productIds)
        : []
    const productById = new Map(
        products
            .filter((product): product is Product => !!product)
            .map((product) => [product.id, product] as const)
    )

    const categoryIds = Array.from(new Set(
        products
            .map((product) => product?.categoryId)
            .filter((categoryId): categoryId is string => typeof categoryId === 'string' && categoryId.length > 0)
    ))
    const categories = categoryIds.length > 0
        ? await db.categories.bulkGet(categoryIds)
        : []
    const categoryById = new Map(
        categories
            .filter((category): category is Category => !!category)
            .map((category) => [category.id, category] as const)
    )

    const cashierIds = Array.from(new Set(
        sales
            .map((sale) => sale.cashierId)
            .filter((cashierId): cashierId is string => typeof cashierId === 'string' && cashierId.length > 0)
    ))
    const cashierUsers = cashierIds.length > 0
        ? await db.users.bulkGet(cashierIds)
        : []
    const cashierNameById = new Map(
        cashierUsers
            .filter((user): user is User => !!user)
            .map((user) => [user.id, user.name || user.email || 'Staff'] as const)
    )

    const itemsBySaleId = new Map<string, Record<string, unknown>[]>()
    for (const item of localItems) {
        const product = productById.get(item.productId)
        const categoryName = product?.categoryId
            ? (categoryById.get(product.categoryId)?.name || '')
            : ''

        const enrichedItem: Record<string, unknown> = {
            id: item.id,
            sale_id: item.saleId,
            product_id: item.productId,
            storage_id: item.storageId,
            quantity: item.quantity,
            unit_price: item.unitPrice,
            total_price: item.totalPrice,
            cost_price: item.costPrice,
            converted_cost_price: item.convertedCostPrice,
            product_name: product?.name || 'Unknown Product',
            product_sku: product?.sku || '',
            original_currency: item.originalCurrency,
            original_unit_price: item.originalUnitPrice,
            converted_unit_price: item.convertedUnitPrice,
            settlement_currency: item.settlementCurrency,
            negotiated_price: item.negotiatedPrice,
            inventory_snapshot: item.inventorySnapshot,
            returned_quantity: item.returnedQuantity,
            is_returned: (item as SaleItem & { isReturned?: boolean }).isReturned,
            return_reason: (item as SaleItem & { returnReason?: string }).returnReason,
            returned_at: (item as SaleItem & { returnedAt?: string }).returnedAt,
            returned_by: (item as SaleItem & { returnedBy?: string }).returnedBy,
            product_category: categoryName,
            product: {
                name: product?.name || 'Unknown Product',
                sku: product?.sku || '',
                category: categoryName || undefined,
                can_be_returned: product?.canBeReturned ?? true,
                return_rules: product?.returnRules
            }
        }

        const existing = itemsBySaleId.get(item.saleId) ?? []
        existing.push(enrichedItem)
        itemsBySaleId.set(item.saleId, existing)
    }

    return sales.map((sale) => {
        const existingItems = Array.isArray((sale as Sale & { _enrichedItems?: unknown[] })._enrichedItems)
            ? ((sale as Sale & { _enrichedItems?: Record<string, unknown>[] })._enrichedItems ?? [])
            : []
        const enrichedItems = existingItems.length > 0
            ? existingItems
            : (itemsBySaleId.get(sale.id) ?? [])
        const cashierName = (sale as Sale & { _cashierName?: string })._cashierName
            || cashierNameById.get(sale.cashierId)
            || 'Staff'

        return {
            ...sale,
            workspaceId,
            _cashierName: cashierName,
            _enrichedItems: enrichedItems
        }
    })
}

export function useSales(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    const sales = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const rows = await db.sales.where('workspaceId').equals(workspaceId).toArray()
            return enrichSalesForUiRows(workspaceId, rows)
        },
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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

                if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
                    return
                }

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

                    if (!shouldUseCloudBusinessData(workspaceId)) {
                        return
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
            invoiceCount,
            recentSales,
            pendingInvoices,
            lowStockProducts,
            allSales
        ] = await Promise.all([
            db.products.where('workspaceId').equals(workspaceId).and(p => !p.isDeleted).count(),
            db.categories.where('workspaceId').equals(workspaceId).and(c => !c.isDeleted).count(),
            db.invoices.where('workspaceId').equals(workspaceId).and(i => !i.isDeleted && i.origin !== 'upload').count(),
            db.sales.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).reverse().sortBy('createdAt').then(sales => sales.slice(0, 3)),
            db.invoices.where('workspaceId').equals(workspaceId).and(inv => !inv.isDeleted && inv.origin !== 'upload').reverse().sortBy('createdAt').then(inv => inv.slice(0, 4)),
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
        async () => {
            if (!workspaceId) {
                return []
            }

            const rows = await db.storages
                .where('workspaceId')
                .equals(workspaceId)
                .and((storage) => !storage.isDeleted)
                .toArray()

            return sortStoragesByPriority(rows.map(normalizeStorageRecord))
        },
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
                const { data, error } = await supabase
                    .from('storages')
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)

                if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
                    return
                }

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
                            const localItem = normalizeStorageRecord(toCamelCase(remoteItem as any) as unknown as Storage)
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
    const activeStorageCount = await db.storages
        .where('workspaceId')
        .equals(workspaceId)
        .and((storage) => !storage.isDeleted)
        .count()

    const storage: Storage = {
        id,
        workspaceId,
        name: data.name,
        isSystem: false,
        isProtected: false,
        isPrimary: activeStorageCount === 0,
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

export async function transferInventoryBetweenStorages(
    workspaceId: string,
    sourceStorageId: string,
    targetStorageId: string,
    items: Array<{ productId: string; quantity: number }>
): Promise<{ movedCount: number }> {
    const completedTransfers: Array<{ productId: string; quantity: number }> = []
    const updatedProducts: Product[] = []
    const affectedProductIds = new Set<string>()
    const now = new Date().toISOString()

    try {
        for (const item of items) {
            const quantity = Number(item.quantity)
            if (!Number.isInteger(quantity) || quantity <= 0) {
                throw new Error('Transfer quantity must be a whole number greater than zero')
            }

            const availableQuantity = await getInventoryQuantityForProductStorage(item.productId, sourceStorageId)
            if (availableQuantity < quantity) {
                throw new Error('Insufficient inventory in source storage')
            }

            const updatedProduct = await transferInventoryQuantity({
                workspaceId,
                productId: item.productId,
                sourceStorageId,
                targetStorageId,
                quantity,
                timestamp: now,
                skipReorderCheck: true
            })

            completedTransfers.push({ productId: item.productId, quantity })
            affectedProductIds.add(item.productId)
            if (updatedProduct) {
                updatedProducts.push(updatedProduct)
            }
        }

        await syncUpdatedProductsBestEffort(updatedProducts, workspaceId)
        if (affectedProductIds.size > 0) {
            const { evaluateReorderTransferRulesForProduct } = await import('./reorderTransferRules')
            await Promise.all(Array.from(affectedProductIds).map((productId) =>
                evaluateReorderTransferRulesForProduct(workspaceId, productId)
            ))
        }

        await createInventoryTransferTransactions(
            workspaceId,
            completedTransfers.map((transfer) => ({
                productId: transfer.productId,
                sourceStorageId,
                destinationStorageId: targetStorageId,
                quantity: transfer.quantity,
                transferType: 'manual' as const
            })),
            { timestamp: now }
        )

        return { movedCount: completedTransfers.length }
    } catch (error) {
        for (const transfer of [...completedTransfers].reverse()) {
            try {
                await transferInventoryQuantity({
                    workspaceId,
                    productId: transfer.productId,
                    sourceStorageId: targetStorageId,
                    targetStorageId: sourceStorageId,
                    quantity: transfer.quantity,
                    timestamp: now,
                    skipReorderCheck: true
                })
            } catch (rollbackError) {
                console.error('[InventoryTransfer] Failed to rollback transfer:', rollbackError)
            }
        }

        throw error
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

    const now = new Date().toISOString()
    const inventoryToMove = await db.inventory.where('storageId').equals(id).and((row) => !row.isDeleted).toArray()
    const completedMoves: Array<{ productId: string; quantity: number }> = []
    const updatedProducts: Product[] = []

    try {
        for (const row of inventoryToMove) {
            const updatedProduct = await transferInventoryQuantity({
                workspaceId: existing.workspaceId,
                productId: row.productId,
                sourceStorageId: id,
                targetStorageId: moveProductsToStorageId,
                quantity: row.quantity,
                timestamp: now,
                skipReorderCheck: true
            })

            completedMoves.push({ productId: row.productId, quantity: row.quantity })
            if (updatedProduct) {
                updatedProducts.push(updatedProduct)
            }
        }
    } catch (error) {
        console.error('[Storage] Failed to move inventory while deleting storage:', error)
        throw normalizeSupabaseActionError(error)
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
                for (const move of [...completedMoves].reverse()) {
                    await transferInventoryQuantity({
                        workspaceId: existing.workspaceId,
                        productId: move.productId,
                        sourceStorageId: moveProductsToStorageId,
                        targetStorageId: id,
                        quantity: move.quantity,
                        timestamp: now,
                        skipReorderCheck: true
                    })
                }
                throw normalizeSupabaseActionError(error)
            }
        }
    } else {
        await addToOfflineMutations('storages', id, 'update', { is_deleted: true } as any, existing.workspaceId)
    }

    try {
        await syncUpdatedProductsBestEffort(updatedProducts, existing.workspaceId)
    } catch (error) {
        console.error('[Storage] Failed to sync product snapshots after storage delete:', error)
    }

    return { success: true, movedCount: inventoryToMove.length }
}

export async function getReserveStorageId(workspaceId: string): Promise<string | null> {
    return getPrimaryStorageIdForWorkspace(workspaceId)
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
        if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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
            if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
                // Fetch profiles for the workspace
                const { data, error } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('workspace_id', workspaceId)

                if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
                    return
                }

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
    const usesCloudBusinessData = shouldUseCloudBusinessData(workspaceId)
    const [hasCompletedInitialCloudSync, setHasCompletedInitialCloudSync] = useState(
        () => !workspaceId || !usesCloudBusinessData || !isOnline
    )

    // 1. Local Cache
    const settings = useLiveQuery(
        () => workspaceId ? db.budget_settings.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).toArray() : [],
        [workspaceId]
    )

    // 2. Online Sync
    useEffect(() => {
        if (!workspaceId || !usesCloudBusinessData || !isOnline) {
            setHasCompletedInitialCloudSync(true)
            return
        }

        let isCancelled = false
        setHasCompletedInitialCloudSync(false)

        void fetchTableFromSupabase('budget_settings', db.budget_settings, workspaceId).finally(() => {
            if (!isCancelled) {
                setHasCompletedInitialCloudSync(true)
            }
        })

        return () => {
            isCancelled = true
        }
    }, [isOnline, usesCloudBusinessData, workspaceId])

    if (
        settings !== undefined &&
        settings.length === 0 &&
        workspaceId &&
        usesCloudBusinessData &&
        isOnline &&
        !hasCompletedInitialCloudSync
    ) {
        return undefined
    }

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
        if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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
        if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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

async function clearPendingOfflineMutations(
    workspaceId: string,
    targets: Array<{ entityType: 'expense_series' | 'expense_items'; entityId: string }>
): Promise<void> {
    const targetKeys = new Set(targets.map(target => `${target.entityType}:${target.entityId}`))
    const pendingMutations = await db.offline_mutations.where('workspaceId').equals(workspaceId).toArray()
    const mutationIds = pendingMutations
        .filter(mutation =>
            mutation.status !== 'synced' &&
            targetKeys.has(`${mutation.entityType}:${mutation.entityId}`)
        )
        .map(mutation => mutation.id)

    if (mutationIds.length > 0) {
        await db.offline_mutations.bulkDelete(mutationIds)
    }
}

export async function hardDeleteExpenseSeries(id: string): Promise<void> {
    const [series, relatedItems] = await Promise.all([
        db.expense_series.get(id),
        db.expense_items.where('seriesId').equals(id).toArray()
    ])

    if (!series && relatedItems.length === 0) {
        return
    }

    const workspaceId = series?.workspaceId || relatedItems[0]?.workspaceId
    if (!workspaceId) {
        return
    }

    const relatedItemIds = relatedItems.map(item => item.id)

    if (isOnline()) {
        const expenseItemsClient = getSupabaseClientForTable('expense_items')
        const expenseSeriesClient = getSupabaseClientForTable('expense_series')

        if (relatedItemIds.length > 0) {
            const { error: itemsError } = await runMutation('expense_items.deleteBySeries', () =>
                expenseItemsClient.from('expense_items').delete().eq('series_id', id)
            )
            if (itemsError) throw normalizeSupabaseActionError(itemsError)
        }

        const { error: seriesError } = await runMutation('expense_series.hardDelete', () =>
            expenseSeriesClient.from('expense_series').delete().eq('id', id)
        )
        if (seriesError) throw normalizeSupabaseActionError(seriesError)

        await db.transaction('rw', [db.expense_series, db.expense_items], async () => {
            await db.expense_series.delete(id)
            if (relatedItemIds.length > 0) {
                await db.expense_items.bulkDelete(relatedItemIds)
            }
        })

        await clearPendingOfflineMutations(workspaceId, [
            { entityType: 'expense_series', entityId: id },
            ...relatedItemIds.map(entityId => ({ entityType: 'expense_items' as const, entityId }))
        ])
        return
    }

    await db.transaction('rw', [db.expense_series, db.expense_items], async () => {
        await db.expense_series.delete(id)
        if (relatedItemIds.length > 0) {
            await db.expense_items.bulkDelete(relatedItemIds)
        }
    })

    for (const itemId of relatedItemIds) {
        await addToOfflineMutations('expense_items', itemId, 'delete', { id: itemId, hardDelete: true }, workspaceId)
    }
    await addToOfflineMutations('expense_series', id, 'delete', { id, hardDelete: true }, workspaceId)
}

export async function deleteExpenseItem(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.expense_items.get(id)
    if (!existing) return

    const series = await db.expense_series.get(existing.seriesId)
    if (series?.recurrence === 'one_time') {
        await hardDeleteExpenseSeries(series.id)
        return
    }

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

    const series = await db.expense_series.get(existing.seriesId)
    if (series?.recurrence === 'one_time') {
        await hardDeleteExpenseSeries(series.id)
        return
    }

    if (isOnline()) {
        const client = getSupabaseClientForTable('expense_items')
        const { error } = await runMutation('expense_items.hardDelete', () =>
            client.from('expense_items').delete().eq('id', id)
        )
        if (error) throw normalizeSupabaseActionError(error)
        await db.expense_items.delete(id)
        await clearPendingOfflineMutations(existing.workspaceId, [
            { entityType: 'expense_items', entityId: id }
        ])
    } else {
        await db.expense_items.delete(id)
        await addToOfflineMutations('expense_items', id, 'delete', { id, hardDelete: true }, existing.workspaceId)
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
        if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('expense_items', db.expense_items, workspaceId, { includeDeleted: true })
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

    const existingItems = await db.expense_items.where('workspaceId').equals(workspaceId).and(i => i.month === month).toArray()
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
        if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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
        if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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
            if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
                const { data, error } = await supabase
                    .from('workspace_contacts')
                    .select('*')
                    .eq('workspace_id', workspaceId)

                if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
                    return
                }

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

async function resolveLinkedBusinessPartner(linkedPartyType?: LoanLinkedPartyType | null, linkedPartyId?: string | null) {
    if (linkedPartyType !== 'business_partner' || !linkedPartyId) {
        return undefined
    }

    const { getBusinessPartnerByAnyId } = await import('./businessPartners')
    const partner = await getBusinessPartnerByAnyId(linkedPartyId)
    if (!partner || partner.isDeleted || partner.mergedIntoBusinessPartnerId) {
        return undefined
    }

    return partner
}

async function assertLoanCreditLimit(
    workspaceId: string,
    input: Pick<LoanCreateInput, 'linkedPartyType' | 'linkedPartyId' | 'principalAmount' | 'settlementCurrency' | 'direction' | 'exchangeRateSnapshot'>
) {
    if (input.direction === 'borrowed') {
        return
    }

    const partner = await resolveLinkedBusinessPartner(input.linkedPartyType, input.linkedPartyId)
    if (!partner?.creditLimit || partner.creditLimit <= 0) {
        return
    }

    const { recalculateBusinessPartnerSummary } = await import('./businessPartners')
    const refreshedPartner = await recalculateBusinessPartnerSummary(workspaceId, partner.id)
    const activePartner = refreshedPartner || partner
    const convertedPrincipal = convertCurrencyAmountWithAvailableSnapshot(
        input.principalAmount,
        input.settlementCurrency,
        activePartner.defaultCurrency,
        input.exchangeRateSnapshot
    )
    if (convertedPrincipal === null) {
        throw new Error(`Missing exchange rate snapshot for ${input.settlementCurrency.toUpperCase()} to ${activePartner.defaultCurrency.toUpperCase()} loan conversion`)
    }
    const nextExposure = roundLoanAmount(
        activePartner.netExposure + convertedPrincipal,
        activePartner.defaultCurrency
    )

    if (nextExposure > 0 && nextExposure > activePartner.creditLimit) {
        throw new Error('credit_limit_exceeded')
    }
}

async function recalculateLoanLinkedBusinessPartnerSummary(workspaceId: string, linkedPartyType?: LoanLinkedPartyType | null, linkedPartyId?: string | null) {
    const partner = await resolveLinkedBusinessPartner(linkedPartyType, linkedPartyId)
    if (!partner) {
        return
    }

    const { recalculateBusinessPartnerSummary } = await import('./businessPartners')
    await recalculateBusinessPartnerSummary(workspaceId, partner.id)
}

function generateLoanNo(id: string, now = new Date(), loanCategory: LoanCategory = 'standard'): string {
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const prefix = loanCategory === 'simple' ? 'SL' : 'LN'
    return `${prefix}-${yyyy}${mm}${dd}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`
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

function resolveLoanPaymentIdFromTransaction(
    transaction: Pick<PaymentTransaction, 'sourceType' | 'sourceSubrecordId' | 'metadata'>
) {
    const metadataPaymentId = transaction.metadata?.loanPaymentId
    if (typeof metadataPaymentId === 'string' && metadataPaymentId) {
        return metadataPaymentId
    }

    if (
        transaction.sourceType !== 'loan_installment'
        && typeof transaction.sourceSubrecordId === 'string'
        && transaction.sourceSubrecordId
    ) {
        return transaction.sourceSubrecordId
    }

    return null
}

function resolveLoanTargetInstallmentId(
    transaction?: Pick<PaymentTransaction, 'sourceType' | 'sourceSubrecordId'> | null
) {
    if (
        transaction?.sourceType === 'loan_installment'
        && typeof transaction.sourceSubrecordId === 'string'
        && transaction.sourceSubrecordId
    ) {
        return transaction.sourceSubrecordId
    }

    return null
}

async function listLoanPaymentTransactionsByLoan(workspaceId: string, loanId: string) {
    const groups = await Promise.all(
        LOAN_PAYMENT_TRANSACTION_SOURCE_TYPES.map((sourceType) =>
            db.payment_transactions
                .where('[workspaceId+sourceType+sourceRecordId]')
                .equals([workspaceId, sourceType, loanId])
                .toArray()
        )
    )

    return groups.flat()
}

export async function hasLoanTransactionHistory(workspaceId: string, loanId: string) {
    const [activeLoanPayments, settlementTransactions] = await Promise.all([
        db.loan_payments.where('loanId').equals(loanId).and((item) => !item.isDeleted).count(),
        Promise.all(
            LOAN_SETTLEMENT_TRANSACTION_SOURCE_TYPES.map((sourceType) =>
                db.payment_transactions
                    .where('[workspaceId+sourceType+sourceRecordId]')
                    .equals([workspaceId, sourceType, loanId])
                    .toArray()
            )
        ).then((groups) => groups.flat())
    ])

    if (activeLoanPayments > 0) {
        return true
    }

    return settlementTransactions.some((transaction) => !transaction.isDeleted && !transaction.reversalOfTransactionId)
}

function rebuildLoanStateFromPayments(
    loan: Loan,
    installmentRows: LoanInstallment[],
    payments: Array<{ payment: LoanPayment; targetInstallmentId?: string | null }>,
    now: string
) {
    const today = now.slice(0, 10)
    const updatedInstallments = installmentRows
        .slice()
        .sort((left, right) => left.installmentNo - right.installmentNo)
        .map((installment) => ({
            ...installment,
            paidAmount: 0,
            balanceAmount: roundLoanAmount(installment.plannedAmount, loan.settlementCurrency),
            status: computeInstallmentStatus(installment.dueDate, installment.plannedAmount),
            paidAt: null as string | null,
            updatedAt: now,
            version: installment.version + 1,
            syncStatus: 'pending' as const,
            lastSyncedAt: null
        }))

    const sortedPayments = payments
        .slice()
        .sort((left, right) =>
            left.payment.paidAt.localeCompare(right.payment.paidAt)
            || left.payment.createdAt.localeCompare(right.payment.createdAt)
            || left.payment.id.localeCompare(right.payment.id)
        )

    for (const { payment, targetInstallmentId } of sortedPayments) {
        let remaining = roundLoanAmount(Math.max(0, Number(payment.amount || 0)), loan.settlementCurrency)
        const paymentOrder = targetInstallmentId
            ? [
                ...updatedInstallments.filter((installment) => installment.id === targetInstallmentId),
                ...updatedInstallments.filter((installment) => installment.id !== targetInstallmentId)
            ]
            : updatedInstallments

        for (const installment of paymentOrder) {
            if (remaining <= 0) {
                break
            }

            if (installment.balanceAmount <= 0) {
                continue
            }

            const applied = roundLoanAmount(Math.min(installment.balanceAmount, remaining), loan.settlementCurrency)
            if (applied <= 0) {
                continue
            }

            installment.paidAmount = roundLoanAmount(installment.paidAmount + applied, loan.settlementCurrency)
            installment.balanceAmount = roundLoanAmount(Math.max(installment.balanceAmount - applied, 0), loan.settlementCurrency)
            installment.status = installment.balanceAmount <= 0 ? 'paid' : 'partial'
            installment.paidAt = installment.status === 'paid' ? payment.paidAt : null
            remaining = roundLoanAmount(Math.max(remaining - applied, 0), loan.settlementCurrency)
        }
    }

    for (const installment of updatedInstallments) {
        if (installment.balanceAmount <= 0) {
            installment.status = 'paid'
            continue
        }

        installment.paidAt = null
        if (installment.paidAmount > 0) {
            installment.status = 'partial'
            continue
        }

        installment.status = installment.dueDate < today ? 'overdue' : 'unpaid'
    }

    const totalPaidAmount = roundLoanAmount(
        updatedInstallments.reduce((sum, installment) => sum + installment.paidAmount, 0),
        loan.settlementCurrency
    )
    const balanceAmount = roundLoanAmount(
        updatedInstallments.reduce((sum, installment) => sum + installment.balanceAmount, 0),
        loan.settlementCurrency
    )
    const nextDueDate = updatedInstallments.find((installment) => installment.balanceAmount > 0)?.dueDate || null
    const oldestOverdueDueDate = updatedInstallments.find((installment) => installment.balanceAmount > 0 && installment.dueDate < today)?.dueDate || null
    const keepReminderSnooze = !!oldestOverdueDueDate && oldestOverdueDueDate === loan.overdueReminderSnoozedForDueDate
    const baseLoanNo = loan.loanNo.replace(/-\d+$/, '')
    const rebuiltLoanNo = payments.length > 0 ? `${baseLoanNo}-${payments.length}` : baseLoanNo

    const updatedLoan: Loan = {
        ...loan,
        loanNo: rebuiltLoanNo,
        totalPaidAmount,
        balanceAmount,
        nextDueDate,
        overdueReminderSnoozedAt: keepReminderSnooze ? loan.overdueReminderSnoozedAt || null : null,
        overdueReminderSnoozedForDueDate: keepReminderSnooze ? loan.overdueReminderSnoozedForDueDate || null : null,
        status: computeLoanStatus(nextDueDate, balanceAmount),
        updatedAt: now,
        version: loan.version + 1,
        syncStatus: 'pending',
        lastSyncedAt: null
    }

    if (updatedInstallments.some((installment) => installment.status === 'overdue')) {
        updatedLoan.status = balanceAmount <= 0 ? 'completed' : 'overdue'
    }

    return {
        updatedLoan,
        updatedInstallments
    }
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
    loanCategory?: LoanCategory
    direction?: LoanDirection
    linkedPartyType?: LoanLinkedPartyType | null
    linkedPartyId?: string | null
    linkedPartyName?: string | null
    borrowerName: string
    borrowerPhone: string
    borrowerAddress: string
    borrowerNationalId: string
    principalAmount: number
    settlementCurrency: CurrencyCode
    exchangeRateSnapshot?: ExchangeRateSnapshot[] | null
    installmentCount: number
    installmentFrequency: InstallmentFrequency
    firstDueDate: string
    notes?: string
    createdBy?: string
}

export function isLoanDeletionAllowed(
    loan: Pick<Loan, 'source' | 'saleId'>,
    hasLinkedActiveSale: boolean,
    hasTransactionHistory = false
): boolean {
    if (hasTransactionHistory) return false
    if (loan.source === 'manual') return true
    if (!loan.saleId) return true
    return !hasLinkedActiveSale
}

async function resolveLoanExchangeRateSnapshot(input: Pick<LoanCreateInput, 'saleId' | 'exchangeRateSnapshot'>) {
    if (Array.isArray(input.exchangeRateSnapshot) && input.exchangeRateSnapshot.length > 0) {
        return getEffectiveExchangeRatesSnapshot(input.exchangeRateSnapshot)
    }

    if (input.saleId) {
        const sale = await db.sales.get(input.saleId)
        const saleSnapshot = Array.isArray(sale?.exchangeRates)
            ? getEffectiveExchangeRatesSnapshot(sale.exchangeRates as ExchangeRateSnapshot[])
            : null
        if (saleSnapshot && saleSnapshot.length > 0) {
            return saleSnapshot
        }
    }

    return getEffectiveExchangeRatesSnapshot(null)
}

async function appendLoanOriginationTransactionBestEffort(workspaceId: string, loan: Loan) {
    if (loan.source !== 'manual') {
        return
    }

    try {
        const { appendLoanOriginationTransactionForLoan } = await import('./payments')
        await appendLoanOriginationTransactionForLoan(workspaceId, loan)
    } catch (error) {
        console.error('[Loans] Failed to append origination transaction:', error)
    }
}

async function createLoanAggregate(workspaceId: string, input: LoanCreateInput): Promise<{ loan: Loan; installments: LoanInstallment[] }> {
    const now = new Date().toISOString()
    const loanId = generateId()
    const firstDueDate = normalizeDueDate(input.firstDueDate)
    const principalAmount = roundLoanAmount(Math.max(0, Number(input.principalAmount || 0)), input.settlementCurrency)
    const loanCategory = input.loanCategory === 'simple' ? 'simple' : 'standard'
    const direction = input.direction === 'borrowed' ? 'borrowed' : 'lent'
    const linkedPartyType = input.linkedPartyType === 'business_partner'
        ? input.linkedPartyType
        : null
    let linkedPartyId = typeof input.linkedPartyId === 'string' ? input.linkedPartyId.trim() : ''
    let linkedPartyName = typeof input.linkedPartyName === 'string' ? input.linkedPartyName.trim() : ''
    const borrowerName = typeof input.borrowerName === 'string' ? input.borrowerName.trim() : ''
    const borrowerPhone = typeof input.borrowerPhone === 'string' ? input.borrowerPhone.trim() : ''
    const borrowerAddress = typeof input.borrowerAddress === 'string' ? input.borrowerAddress.trim() : ''
    const borrowerNationalId = typeof input.borrowerNationalId === 'string' ? input.borrowerNationalId.trim() : ''

    if (!principalAmount || principalAmount <= 0) {
        throw new Error('Invalid principal amount')
    }
    if (!borrowerName) {
        throw new Error('Missing borrower information')
    }
    if (loanCategory === 'standard' && (!borrowerPhone || !borrowerAddress || !borrowerNationalId)) {
        throw new Error('Missing borrower information')
    }

    const exchangeRateSnapshot = await resolveLoanExchangeRateSnapshot(input)

    const linkedBusinessPartner = await resolveLinkedBusinessPartner(linkedPartyType, linkedPartyId)
    if (linkedPartyType && linkedPartyId && !linkedBusinessPartner) {
        throw new Error('Business partner not found')
    }
    if (linkedBusinessPartner) {
        linkedPartyId = linkedBusinessPartner.id
        linkedPartyName = linkedPartyName || linkedBusinessPartner.name
        await assertLoanCreditLimit(workspaceId, {
            linkedPartyType,
            linkedPartyId,
            principalAmount,
            settlementCurrency: input.settlementCurrency,
            direction,
            exchangeRateSnapshot
        })
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
        loanNo: generateLoanNo(loanId, new Date(now), loanCategory),
        source: input.source,
        loanCategory,
        direction,
        linkedPartyType: linkedPartyType && linkedPartyId && linkedPartyName ? linkedPartyType : null,
        linkedPartyId: linkedPartyType && linkedPartyId && linkedPartyName ? linkedPartyId : null,
        linkedPartyName: linkedPartyType && linkedPartyId && linkedPartyName ? linkedPartyName : null,
        borrowerName,
        borrowerPhone,
        borrowerAddress,
        borrowerNationalId,
        principalAmount,
        totalPaidAmount: 0,
        balanceAmount: principalAmount,
        settlementCurrency: input.settlementCurrency,
        exchangeRateSnapshot: exchangeRateSnapshot && exchangeRateSnapshot.length > 0 ? exchangeRateSnapshot : null,
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
        await appendLoanOriginationTransactionBestEffort(workspaceId, loan)
        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)
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

        await appendLoanOriginationTransactionBestEffort(workspaceId, { ...loan, syncStatus: 'synced', lastSyncedAt: syncedAt })
        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)

        return {
            loan: { ...loan, syncStatus: 'synced', lastSyncedAt: syncedAt },
            installments: installments.map(item => ({ ...item, syncStatus: 'synced', lastSyncedAt: syncedAt }))
        }
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Online create failed, queued offline mutation:', error)
            await enqueueLoanCreateMutations(workspaceId, loan, installments)
            await appendLoanOriginationTransactionBestEffort(workspaceId, loan)
            await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)
            return { loan, installments }
        }

        await db.transaction('rw', [db.loans, db.loan_installments], async () => {
            await db.loans.delete(loan.id)
            for (const installment of installments) {
                await db.loan_installments.delete(installment.id)
            }
        })

        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)

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
            if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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
            if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
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
    const hasTransactionHistory = await hasLoanTransactionHistory(loan.workspaceId, loanId)
    if (!isLoanDeletionAllowed(loan, hasLinkedActiveSale, hasTransactionHistory)) {
        throw new Error('loan_delete_not_allowed')
    }

    const hideLoanTransactions = async () => {
        const { hideLoanTransactionsForDeletedLoan } = await import('./payments')
        await hideLoanTransactionsForDeletedLoan(loan.workspaceId, loanId)
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
        await hideLoanTransactions()
        await removeLoanAggregateLocally(true)
        await recalculateLoanLinkedBusinessPartnerSummary(loan.workspaceId, loan.linkedPartyType, loan.linkedPartyId)
        return
    }

    try {
        const { error } = await runMutation('loans.delete', () =>
            supabase.from('loans').delete().eq('id', loanId)
        )
        if (error) throw error

        await hideLoanTransactions()
        await removeLoanAggregateLocally(false)
        await recalculateLoanLinkedBusinessPartnerSummary(loan.workspaceId, loan.linkedPartyType, loan.linkedPartyId)
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Delete sync failed, queued offline mutation:', error)
            await hideLoanTransactions()
            await removeLoanAggregateLocally(true)
            await recalculateLoanLinkedBusinessPartnerSummary(loan.workspaceId, loan.linkedPartyType, loan.linkedPartyId)
            return
        }

        throw normalizeSupabaseActionError(error)
    }
}

export async function reverseLoanPayment(
    workspaceId: string,
    transaction: Pick<PaymentTransaction, 'id' | 'workspaceId' | 'sourceType' | 'sourceRecordId' | 'sourceSubrecordId' | 'metadata'>
) {
    if (transaction.workspaceId !== workspaceId) {
        throw new Error('Workspace mismatch')
    }

    const loan = await db.loans.get(transaction.sourceRecordId)
    if (!loan || loan.isDeleted) {
        throw new Error('Loan not found')
    }

    const loanPaymentId = resolveLoanPaymentIdFromTransaction(transaction)
    if (!loanPaymentId) {
        throw new Error('Loan payment reversal metadata is incomplete')
    }

    const [installmentRows, paymentRows, loanTransactions] = await Promise.all([
        db.loan_installments.where('loanId').equals(loan.id).and((item) => !item.isDeleted).sortBy('installmentNo'),
        db.loan_payments.where('loanId').equals(loan.id).toArray(),
        listLoanPaymentTransactionsByLoan(workspaceId, loan.id)
    ])

    const payment = paymentRows.find((item) => item.id === loanPaymentId && !item.isDeleted)
    if (!payment) {
        throw new Error('Loan payment not found')
    }

    const transactionByPaymentId = new Map<string, Pick<PaymentTransaction, 'sourceType' | 'sourceSubrecordId' | 'metadata'>>()
    loanTransactions
        .filter((item) => !item.isDeleted && !item.reversalOfTransactionId)
        .forEach((item) => {
            const currentLoanPaymentId = resolveLoanPaymentIdFromTransaction(item)
            if (currentLoanPaymentId) {
                transactionByPaymentId.set(currentLoanPaymentId, item)
            }
        })

    const now = new Date().toISOString()
    const remainingPayments = paymentRows
        .filter((item) => !item.isDeleted && item.id !== payment.id)
        .map((item) => ({
            payment: item,
            targetInstallmentId: resolveLoanTargetInstallmentId(transactionByPaymentId.get(item.id))
        }))

    const { updatedLoan, updatedInstallments } = rebuildLoanStateFromPayments(loan, installmentRows, remainingPayments, now)
    const deletedPayment: LoanPayment = {
        ...payment,
        isDeleted: true,
        updatedAt: now,
        version: payment.version + 1,
        syncStatus: 'pending',
        lastSyncedAt: null
    }

    await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
        await db.loans.put(updatedLoan)
        for (const installment of updatedInstallments) {
            await db.loan_installments.put(installment)
        }
        await db.loan_payments.put(deletedPayment)
    })

    const enqueueMutations = async () => {
        await addToOfflineMutations('loans', updatedLoan.id, 'update', updatedLoan as unknown as Record<string, unknown>, workspaceId)
        await Promise.all(updatedInstallments.map((installment) =>
            addToOfflineMutations(
                'loan_installments',
                installment.id,
                'update',
                installment as unknown as Record<string, unknown>,
                workspaceId
            )
        ))
        await addToOfflineMutations('loan_payments', deletedPayment.id, 'delete', { id: deletedPayment.id }, workspaceId)
    }

    if (!isOnline()) {
        await enqueueMutations()
        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, updatedLoan.linkedPartyType, updatedLoan.linkedPartyId)
        return { loan: updatedLoan, installments: updatedInstallments, payment: deletedPayment }
    }

    try {
        const { error: loanError } = await runMutation('loans.reversePayment.loan', () =>
            supabase
                .from('loans')
                .update(toSnakeCase({
                    loanNo: updatedLoan.loanNo,
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

        const { error: installmentsError } = await runMutation('loans.reversePayment.installments', () =>
            supabase.from('loan_installments').upsert(
                updatedInstallments.map((installment) =>
                    toSupabaseLoanPayload(installment as unknown as Record<string, unknown>)
                )
            )
        )
        if (installmentsError) throw installmentsError

        const { error: paymentError } = await runMutation('loans.reversePayment.payment', () =>
            supabase
                .from('loan_payments')
                .update({ is_deleted: true, updated_at: now, version: deletedPayment.version })
                .eq('id', deletedPayment.id)
        )
        if (paymentError) throw paymentError

        const syncedAt = new Date().toISOString()
        await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
            await db.loans.update(updatedLoan.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            for (const installment of updatedInstallments) {
                await db.loan_installments.update(installment.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            }
            await db.loan_payments.update(deletedPayment.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
        })

        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, updatedLoan.linkedPartyType, updatedLoan.linkedPartyId)

        return {
            loan: { ...updatedLoan, syncStatus: 'synced', lastSyncedAt: syncedAt },
            installments: updatedInstallments.map((installment) => ({ ...installment, syncStatus: 'synced', lastSyncedAt: syncedAt })),
            payment: { ...deletedPayment, syncStatus: 'synced', lastSyncedAt: syncedAt }
        }
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Reverse payment sync failed, queued offline mutation:', error)
            await enqueueMutations()
            await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, updatedLoan.linkedPartyType, updatedLoan.linkedPartyId)
            return { loan: updatedLoan, installments: updatedInstallments, payment: deletedPayment }
        }

        await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
            await db.loans.put(loan)
            for (const installment of installmentRows) {
                await db.loan_installments.put(installment)
            }
            await db.loan_payments.put(payment)
        })

        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)
        throw normalizeSupabaseActionError(error)
    }
}

interface LoanPaymentInput {
    loanId: string
    installmentId?: string
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
    const installmentsById = new Map(updatedInstallments.map(item => [item.id, item]))
    const paymentOrder = input.installmentId
        ? [
            ...installmentRows.filter(item => item.id === input.installmentId),
            ...installmentRows.filter(item => item.id !== input.installmentId)
        ]
        : installmentRows
    const touchedInstallmentIds = new Set<string>()

    for (const originalInstallment of paymentOrder) {
        const installment = installmentsById.get(originalInstallment.id)
        if (!installment) {
            continue
        }

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
        touchedInstallmentIds.add(installment.id)
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

    const existingPayments = await db.loan_payments
        .where('loanId')
        .equals(input.loanId)
        .and(item => !item.isDeleted)
        .count()
    const paymentSuffix = existingPayments + 1
    const baseLoanNo = loan.loanNo.replace(/-\d+$/, '')
    const newLoanNo = `${baseLoanNo}-${paymentSuffix}`

    const updatedLoan: Loan = {
        ...loan,
        loanNo: newLoanNo,
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

    const appendLedger = async () => {
        const { appendPaymentTransaction } = await import('./payments')
        await appendPaymentTransaction(workspaceId, {
            sourceModule: 'loans',
            sourceType: (loan.loanCategory || 'standard') === 'simple'
                ? 'simple_loan'
                : (input.installmentId ? 'loan_installment' : 'loan_payment'),
            sourceRecordId: loan.id,
            sourceSubrecordId: input.installmentId || payment.id,
            direction: (loan.direction || 'lent') === 'borrowed' ? 'outgoing' : 'incoming',
            amount: payableAmount,
            currency: loan.settlementCurrency,
            paymentMethod: input.paymentMethod,
            paidAt,
            counterpartyName: loan.borrowerName,
            referenceLabel: updatedLoan.loanNo || loan.loanNo,
            note: input.note?.trim() || null,
            createdBy: input.createdBy || null,
            metadata: {
                loanPaymentId: payment.id,
                loanCategory: loan.loanCategory || 'standard',
                loanDirection: loan.direction || 'lent',
                touchedInstallmentIds: Array.from(touchedInstallmentIds)
            }
        })
    }

    if (!isOnline()) {
        await enqueueMutations()
        await appendLedger()
        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, updatedLoan.linkedPartyType, updatedLoan.linkedPartyId)
        return { loan: updatedLoan, payment, installments: updatedInstallments }
    }

    try {
        const { error: loanError } = await runMutation('loans.recordPayment.loan', () =>
            supabase
                .from('loans')
                .update(toSnakeCase({
                    loanNo: updatedLoan.loanNo,
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

        await appendLedger()
        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, updatedLoan.linkedPartyType, updatedLoan.linkedPartyId)

        return {
            loan: { ...updatedLoan, syncStatus: 'synced', lastSyncedAt: syncedAt },
            payment: { ...payment, syncStatus: 'synced', lastSyncedAt: syncedAt },
            installments: updatedInstallments.map(item => ({ ...item, syncStatus: 'synced', lastSyncedAt: syncedAt }))
        }
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Payment sync failed, queued offline mutation:', error)
            await enqueueMutations()
            await appendLedger()
            await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, updatedLoan.linkedPartyType, updatedLoan.linkedPartyId)
            return { loan: updatedLoan, payment, installments: updatedInstallments }
        }

        await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
            await db.loans.put(loan)
            for (const installment of installmentRows) {
                await db.loan_installments.put(installment)
            }
            await db.loan_payments.delete(payment.id)
        })

        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)

        throw normalizeSupabaseActionError(error)
    }
}


/**
 * Maps a SalesOrder (camelCase) to the UI Sale type (snake_case).
 */
export function toUISaleFromOrder(order: any): any {
    const items = (order.items || []).map((item: any) => ({
        id: item.id || Math.random().toString(36).substr(2, 9),
        sale_id: order.id,
        product_id: item.productId,
        product_name: item.productName || 'Unknown Product',
        product_sku: item.productSku || '',
        quantity: item.quantity || 0,
        unit_price: item.convertedUnitPrice || item.unitPrice || 0,
        total_price: item.lineTotal || (item.quantity * (item.convertedUnitPrice || 0)),
        cost_price: item.costPrice || 0,
        converted_cost_price: item.convertedCostPrice || 0,
        original_currency: item.originalCurrency || order.currency,
        original_unit_price: item.originalUnitPrice || item.original_unit_price || item.unitPrice || item.unit_price || 0,
        converted_unit_price: item.convertedUnitPrice || item.converted_unit_price || item.unitPrice || item.unit_price || 0,
        settlement_currency: order.currency || order.settlement_currency,
        returned_quantity: 0,
        is_returned: false,
        product: {
            name: item.productName || 'Unknown Product',
            sku: item.productSku || '',
            can_be_returned: false
        }
    }))

    return {
        id: order.id,
        workspace_id: order.workspaceId,
        cashier_id: order.createdBy || '',
        total_amount: Number(order.total || (order as any).total_amount || 0),
        settlement_currency: order.currency || 'usd',
        exchange_source: order.exchangeRateSource,
        exchange_rate: order.exchangeRate,
        exchange_rate_timestamp: order.exchangeRateTimestamp,
        exchange_rates: order.exchangeRates,
        created_at: order.actualDeliveryDate || order.updatedAt || order.createdAt,
        updated_at: order.updatedAt,
        origin: 'sales_order',
        payment_method: order.paymentMethod || 'cash',
        cashier_name: order.customerName || 'Order',
        items,
        is_returned: false,
        sequenceId: order.orderNumber || order.order_number,
        notes: order.notes,
        _isOrder: true,
        _orderNumber: order.orderNumber || order.order_number,
        _sourceChannel: order.sourceChannel || order.source_channel || null
    }
}

/**
 * Maps a TravelAgencySale (camelCase) to the UI Sale type (snake_case).
 */
export function toUISaleFromTravelAgency(sale: any): any {
    const tourists = sale.tourists || sale.tourist_list || []
    const groupRev = Number(sale.groupRevenue || sale.group_revenue || 0)
    const supplierCost = Number(sale.supplierCost || sale.supplier_cost || 0)
    const currency = sale.currency || (sale as any).currency || 'usd'

    let items: any[] = []

    // 1. Add individual tourists as items
    tourists.forEach((tourist: any) => {
        const fullName = tourist.fullName || tourist.full_name || tourist.name || ''
        const surname = tourist.surname || ''
        const revenue = Number(tourist.revenue || tourist.tourist_revenue || 0)
        
        items.push({
            id: tourist.id || generateId(),
            sale_id: sale.id,
            product_id: 'travel_agency_tourist',
            product_name: `${fullName} ${surname}`.trim() || 'Tourist',
            product_sku: 'TA-TOURIST',
            quantity: 1,
            unit_price: revenue,
            total_price: revenue,
            cost_price: 0, // Will be distributed below
            converted_cost_price: 0,
            original_currency: currency,
            original_unit_price: revenue,
            converted_unit_price: revenue,
            settlement_currency: currency,
            returned_quantity: 0,
            is_returned: false,
            product: {
                name: `${fullName} ${surname}`.trim() || 'Tourist',
                sku: 'TA-TOURIST',
                can_be_returned: false
            }
        })
    })

    // 2. Add group revenue as an item if > 0
    if (groupRev > 0) {
        items.push({
            id: generateId(),
            sale_id: sale.id,
            product_id: 'travel_agency_group',
            product_name: sale.groupName || sale.group_name || 'Group Revenue',
            product_sku: 'TA-GROUP',
            quantity: 1,
            unit_price: groupRev,
            total_price: groupRev,
            cost_price: 0, // Will be distributed below
            converted_cost_price: 0,
            original_currency: currency,
            original_unit_price: groupRev,
            converted_unit_price: groupRev,
            settlement_currency: currency,
            returned_quantity: 0,
            is_returned: false,
            product: {
                name: sale.groupName || sale.group_name || 'Group Revenue',
                sku: 'TA-GROUP',
                can_be_returned: false
            }
        })
    }

    // 3. Ensure at least one item exists
    if (items.length === 0) {
        items.push({
            id: generateId(),
            sale_id: sale.id,
            product_id: 'travel_agency_service',
            product_name: 'Travel Service',
            product_sku: 'TA-SERVICE',
            quantity: 1,
            unit_price: 0,
            total_price: 0,
            cost_price: 0,
            converted_cost_price: 0,
            original_currency: currency,
            original_unit_price: 0,
            converted_unit_price: 0,
            settlement_currency: currency,
            returned_quantity: 0,
            is_returned: false,
            product: {
                name: 'Travel Service',
                sku: 'TA-SERVICE',
                can_be_returned: false
            }
        })
    }

    // 4. Distribute supplier cost across all items
    const costPerItem = supplierCost / items.length
    items.forEach(item => {
        item.cost_price = costPerItem
        item.converted_cost_price = costPerItem
    })

    // 5. Final total amount is the sum of all items
    const totalAmount = items.reduce((sum, item) => sum + item.total_price, 0)

    return {
        id: sale.id,
        workspace_id: sale.workspaceId || sale.workspace_id,
        cashier_id: sale.createdBy || sale.created_by || '',
        total_amount: totalAmount,
        settlement_currency: currency,
        exchange_source: sale.exchangeRateSnapshot?.source || sale.exchange_rate_snapshot?.source || 'Manual (Travel Agency)',
        exchange_rate: sale.exchangeRateSnapshot?.rate || sale.exchange_rate_snapshot?.rate || 1,
        exchange_rate_timestamp: sale.exchangeRateSnapshot?.timestamp || sale.exchange_rate_snapshot?.timestamp || sale.createdAt || sale.created_at || new Date().toISOString(),
        exchange_rates: null,
        created_at: sale.paidAt || sale.paid_at || sale.saleDate || sale.sale_date || sale.createdAt || sale.created_at,
        updated_at: sale.updatedAt || sale.updated_at,
        origin: 'travel_agency',
        payment_method: sale.paymentMethod || sale.payment_method || 'cash',
        cashier_name: sale.groupName || sale.group_name || 'Travel Sale',
        items,
        is_returned: false,
        sequenceId: sale.saleNumber || sale.sale_number,
        notes: sale.notes,
        _isTravelAgency: true,
        _saleNumber: sale.saleNumber || sale.sale_number
    }
}
