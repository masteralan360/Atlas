import { useCallback, useEffect, useMemo, useState } from 'react'
import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import { useViewOwnRecordScope, type ViewOwnRecordScope } from '@/permissions/useViewOwnRecordScope'

import { db } from './database'
import { canAccessBusinessPartnerInLocalCache } from './businessPartnerPrivacy'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'
import { createInventoryTransferTransactions } from './inventoryTransferTransactions'
import { addToOfflineMutations } from './offlineMutations'
import { isSyncIntegrityError } from '@/sync/syncErrors'
import { refreshStockBatchesFromSupabase } from './stockBatches'
import { roundOrderValue } from '@/lib/orderPrecision'
import { getPrimaryStorageId as getPrimaryStorageIdForWorkspace, normalizeStorageRecord, sortStoragesByPriority } from './storageUtils'
import {
    deleteInventoryForProduct,
    getInventoryQuantityForProductStorage,
    setProductInventoryFromLegacyInput,
    transferInventoryQuantityWithBatches,
    useInventory
} from './inventory'
import type {
    Product,
    Inventory,
    ProductBarcode,
    Category,
    Unit,
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
    SalesExchange,
    SaleProductExchange,
    PaymentTransaction,
    PaymentTransactionSourceType,
    OfflineMutation
} from './models'
import { isReservedUnitCode, normalizeUnitCode } from './models'
import {
    DuplicateProductBarcodeError,
    findActiveProductBarcodeByValue,
    normalizeProductBarcodeLabel,
    normalizeProductBarcodeValue,
    sortProductBarcodes,
    syncProductBarcodeCache,
    syncProductBarcodeCachesForWorkspace
} from './productBarcodes'
import { DuplicateProductSkuError, normalizeProductSku, trimProductSku } from './productSku'
import { replaceProductPriceBookItems } from './priceBooks'
import { isService } from '@/lib/catalogItem'
import { generateId, toSnakeCase, toCamelCase } from '@/lib/utils'
import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { getActiveBusinessUserId, isOnline } from '@/lib/network'
import {
    buildInventoryTotalsByProduct,
    resolveActiveDiscountForPriceContext,
    resolveActiveDiscountMap,
    type DiscountPriceContext,
    type ResolvedActiveDiscount
} from '@/lib/discounts'
import { convertCurrencyAmountWithAvailableSnapshot, getEffectiveExchangeRatesSnapshot } from '@/lib/orderCurrency'
import { QUANTITY_EPSILON, isPositiveQuantity, roundQuantity } from '@/lib/quantity'
import { salesExchangeRowsToSnapshots } from '@/lib/salesExchange'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { getSupabaseClientForTable, getSupabaseRemoteTableName, getVisibilityScopedTableRpc } from '@/lib/supabaseSchema'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import {
    cancelWorkspaceDataHydration,
    completeWorkspaceDataHydration,
    failWorkspaceDataHydration,
    recordWorkspaceDataFetch,
    startWorkspaceDataHydration,
    updateWorkspaceDataHydrationProgress
} from '@/workspace/workspaceDataFreshness'

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

function sanitizeInvoiceRemotePayload(source: Record<string, unknown>): Record<string, unknown> {
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
        customerId,
        status,
        isSnapshot,
        syncStatus,
        lastSyncedAt,
        ...remotePayload
    } = source

    return remotePayload
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

function toSupabaseProductPayload(product: Partial<Product>) {
    const hasCategory = Object.prototype.hasOwnProperty.call(product, 'category')
    const hasCategoryId = Object.prototype.hasOwnProperty.call(product, 'categoryId')
    const payload: Record<string, unknown> = {
        ...product,
        syncStatus: undefined,
        lastSyncedAt: undefined,
        skuKey: undefined,
        // Stock is derived by the database from inventory rows.  Do not let a
        // product edit or a stale local snapshot overwrite it.
        quantity: undefined,
        storageId: undefined,
        storageName: undefined,
        barcode: undefined,
        barcodes: undefined
    }

    if (product.isService === true) {
        payload.sku = null
        payload.unit = null
        payload.quantity = null
        payload.minStockLevel = null
        payload.storageId = null
        payload.parentProductId = null
    }

    if (hasCategoryId && product.categoryId == null && (!hasCategory || product.category === undefined)) {
        payload.category = null
    }

    return toSnakeCase(payload)
}

function toSupabaseCategoryPayload(category: Partial<Category>) {
    return toSnakeCase({
        ...category,
        syncStatus: undefined,
        lastSyncedAt: undefined
    })
}

function toSupabaseProductBarcodePayload(productBarcode: ProductBarcode) {
    return toSnakeCase({
        ...productBarcode,
        syncStatus: undefined,
        lastSyncedAt: undefined
    })
}

function isDuplicateProductBarcodeMutationError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false
    }

    const code = (error as { code?: unknown }).code
    const message = typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message.toLowerCase()
        : ''

    return code === '23505'
        || (message.includes('duplicate') && message.includes('barcode'))
        || message.includes('already assigned to another product')
}

function isDuplicateProductSkuMutationError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false
    }

    const code = (error as { code?: unknown }).code
    const constraint = typeof (error as { constraint?: unknown }).constraint === 'string'
        ? (error as { constraint: string }).constraint.toLowerCase()
        : ''
    const message = typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message.toLowerCase()
        : ''

    return code === '23505' && (
        constraint.includes('products_workspace_sku')
        || message.includes('product with this sku')
        || (message.includes('duplicate') && message.includes('sku'))
    )
}

export async function findActiveProductBySku(
    workspaceId: string,
    sku: string,
    options?: { excludeId?: string }
) {
    const skuKey = normalizeProductSku(sku)
    if (!workspaceId || !skuKey) {
        return undefined
    }

    return db.products
        .where('[workspaceId+skuKey]')
        .equals([workspaceId, skuKey])
        .and((product) => !product.isDeleted && product.id !== options?.excludeId)
        .first()
}

function belongsToSameSkuVariantFamily(
    product: Product,
    productId: string,
    parentProductId: string | null
) {
    const candidateFamilyId = parentProductId ?? productId
    const existingFamilyId = product.parentProductId ?? product.id

    return candidateFamilyId === existingFamilyId
}

async function ensureProductSkuIsAvailable(
    workspaceId: string,
    sku: string,
    options: { productId: string; parentProductId: string | null }
) {
    const skuKey = normalizeProductSku(sku)
    if (!workspaceId || !skuKey) {
        return
    }

    const productsWithSku = await db.products
        .where('[workspaceId+skuKey]')
        .equals([workspaceId, skuKey])
        .and((product) => !product.isDeleted && product.id !== options.productId)
        .toArray()

    const hasProductOutsideFamily = productsWithSku.some((product) =>
        !belongsToSameSkuVariantFamily(product, options.productId, options.parentProductId)
    )

    if (hasProductOutsideFamily) {
        throw new DuplicateProductSkuError()
    }
}

const LOAN_PAYMENT_TRANSACTION_SOURCE_TYPES: PaymentTransactionSourceType[] = ['loan_origination', 'loan_payment', 'simple_loan', 'loan_installment']
const LOAN_SETTLEMENT_TRANSACTION_SOURCE_TYPES: PaymentTransactionSourceType[] = ['loan_payment', 'simple_loan', 'loan_installment']

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
        if (!isOnline || !workspaceId || !shouldUseCloudBusinessData(workspaceId)) {
            return
        }

        void fetchTableFromSupabase('categories', db.categories, workspaceId)
    }, [isOnline, workspaceId])

    return categories ?? []
}

export async function createCategory(workspaceId: string, data: Omit<Category, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>): Promise<Category> {
    const now = new Date().toISOString()
    const id = generateId()
    const session = isOnline() ? await getMutationSession('categories.create') : null

    const category: Category = {
        ...data,
        id,
        workspaceId,
        createdBy: data.createdBy ?? getActiveBusinessUserId() ?? session?.user?.id ?? null,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any, // Optimistic status
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    if (isOnline()) {
        // ONLINE: Write directly to Supabase
        const payload = toSupabaseCategoryPayload(category)
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
        const payload = toSupabaseCategoryPayload({ ...data, updatedAt: now })
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

    const attachedProductsById = await db.products.where('categoryId').equals(id).toArray()
    const legacyAttachedProducts = existing.name
        ? await db.products
            .where('workspaceId')
            .equals(existing.workspaceId)
            .and((product) => !product.isDeleted && !product.categoryId && product.category?.trim() === existing.name.trim())
            .toArray()
        : []
    const attachedProducts = Array.from(
        new Map([...attachedProductsById, ...legacyAttachedProducts].map((product) => [product.id, product])).values()
    )
    const shouldSyncOnline = shouldUseCloudBusinessData(existing.workspaceId) && isOnline()
    const updatedProducts = attachedProducts.map((product) => ({
        ...product,
        categoryId: null,
        category: null,
        updatedAt: now,
        syncStatus: shouldSyncOnline ? 'synced' : 'pending',
        lastSyncedAt: shouldSyncOnline ? now : product.lastSyncedAt,
        version: product.version + 1
    }) as Product)

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: shouldSyncOnline ? 'synced' : 'pending',
        version: existing.version + 1
    } as Category

    if (shouldSyncOnline) {
        // ONLINE: Delete in Supabase (Soft Delete)
        const { error: productsError } = await runMutation('categories.clearProducts', () =>
            supabase
                .from('products')
                .update({ category_id: null, category: null, updated_at: now })
                .eq('category_id', id)
        )
        if (productsError) throw normalizeSupabaseActionError(productsError)

        if (existing.name.trim()) {
            const { error: legacyProductsError } = await runMutation('categories.clearLegacyProducts', () =>
                supabase
                    .from('products')
                    .update({ category: null, updated_at: now })
                    .eq('workspace_id', existing.workspaceId)
                    .is('category_id', null)
                    .eq('category', existing.name)
            )
            if (legacyProductsError) throw normalizeSupabaseActionError(legacyProductsError)
        }

        const { error } = await runMutation('categories.delete', () => supabase.from('categories').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)

        await db.transaction('rw', [db.products, db.categories], async () => {
            for (const product of updatedProducts) {
                await db.products.put(product)
            }
            await db.categories.put(updated)
        })
    } else {
        // OFFLINE
        await db.transaction('rw', [db.products, db.categories], async () => {
            for (const product of updatedProducts) {
                await db.products.put(product)
            }
            await db.categories.put(updated)
        })

        if (shouldUseCloudBusinessData(existing.workspaceId)) {
            await Promise.all(updatedProducts.map((product) =>
                addToOfflineMutations('products', product.id, 'update', product as unknown as Record<string, unknown>, existing.workspaceId)
            ))
            // For delete, we might just need the ID, but passing full updated record is safe or just payload with ID
            await addToOfflineMutations('categories', id, 'delete', { id }, existing.workspaceId)
        }
    }
}

// ===================
// UNITS HOOKS
// ===================

export class UnitInUseError extends Error {
    constructor() {
        super('Unit is used by one or more products')
        this.name = 'UnitInUseError'
    }
}

export class UnitReservedCodeError extends Error {
    constructor() {
        super('Unit code is reserved for a built-in unit')
        this.name = 'UnitReservedCodeError'
    }
}

function toSupabaseUnitPayload(unit: Partial<Unit>) {
    return toSnakeCase({
        ...unit,
        syncStatus: undefined,
        lastSyncedAt: undefined
    })
}

export function useUnits(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()

    // 1. Local Cache (Always Source of Truth for UI)
    // Built-in units are hardcoded in DEFAULT_UNITS and never stored here.
    // Rows whose code collides with a built-in are legacy seed data from the
    // old auto-seed logic, so they are excluded from the UI entirely.
    const units = useLiveQuery(
        () => workspaceId
            ? db.units.where('workspaceId').equals(workspaceId)
                .and(u => !u.isDeleted && !isReservedUnitCode(u.code))
                .toArray()
            : [],
        [workspaceId]
    )

    // 2. Online: Fetch fresh data from Supabase & cleanup cache
    useEffect(() => {
        if (!isOnline || !workspaceId || !shouldUseCloudBusinessData(workspaceId)) {
            return
        }

        void fetchTableFromSupabase('units', db.units, workspaceId).then(() => {
            // Drop any legacy seeded built-in rows that were synced before the
            // units table became custom-only. Built-in codes are reserved, so
            // these rows can never be legitimate custom units.
            return db.units
                .where('workspaceId')
                .equals(workspaceId)
                .filter((unit) => !unit.isDeleted && isReservedUnitCode(unit.code))
                .delete()
        })
    }, [isOnline, workspaceId])

    return units ?? []
}

function assertCustomUnitCode(code: string): void {
    if (isReservedUnitCode(code)) {
        throw new UnitReservedCodeError()
    }
}

export async function createUnit(workspaceId: string, data: Omit<Unit, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>): Promise<Unit> {
    const code = normalizeUnitCode(data.code)
    assertCustomUnitCode(code)
    const now = new Date().toISOString()
    const id = generateId()
    const session = isOnline() ? await getMutationSession('units.create') : null

    const unit: Unit = {
        ...data,
        code,
        id,
        workspaceId,
        createdBy: data.createdBy ?? getActiveBusinessUserId() ?? session?.user?.id ?? null,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any, // Optimistic status
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

    if (isOnline()) {
        // ONLINE: Write directly to Supabase
        const payload = toSupabaseUnitPayload(unit)
        const { error } = await runMutation('units.create', () => supabase.from('units').upsert(payload))

        if (error) {
            console.error('Supabase write failed:', error)
            throw normalizeSupabaseActionError(error) // Fail loudly if online
        }

        // Update local cache as synced
        await db.units.put(unit)
    } else {
        // OFFLINE: Write to local mutation queue
        await db.units.put(unit)
        await addToOfflineMutations('units', id, 'create', unit as unknown as Record<string, unknown>, workspaceId)
    }

    return unit
}

export async function updateUnit(id: string, data: Partial<Unit>): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.units.get(id)
    if (!existing) throw new Error('Unit not found')
    const nextCode = data.code !== undefined ? normalizeUnitCode(data.code) : undefined
    if (nextCode !== undefined) assertCustomUnitCode(nextCode)
    const oldCode = existing.code
    const codeChanged = nextCode !== undefined && nextCode !== oldCode

    const updated = {
        ...existing,
        ...data,
        ...(nextCode !== undefined ? { code: nextCode } : {}),
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (isOnline()) {
        // ONLINE: Update Supabase directly
        const payload = toSupabaseUnitPayload({ ...data, ...(nextCode !== undefined ? { code: nextCode } : {}), updatedAt: now })
        const { error } = await runMutation('units.update', () => supabase.from('units').update(payload).eq('id', id))

        if (error) throw normalizeSupabaseActionError(error)

        await db.units.put(updated)
    } else {
        // OFFLINE: Local mutation
        await db.units.put(updated)
        await addToOfflineMutations('units', id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }

    // A renamed unit must update every product that references the old code,
    // otherwise the products keep pointing at a code that no longer exists in
    // the registry (empty dropdown trigger, missing prints).
    if (codeChanged) {
        await migrateProductUnitsToRenamedUnit(existing.workspaceId, oldCode, nextCode as string)
    }
}

async function migrateProductUnitsToRenamedUnit(workspaceId: string, oldCode: string, newCode: string) {
    const affectedProducts = await db.products
        .where('workspaceId')
        .equals(workspaceId)
        .and((product) => !product.isDeleted && product.unit === oldCode)
        .toArray()

    for (const product of affectedProducts) {
        await updateProduct(product.id, { unit: newCode })
    }
}

export async function deleteUnit(id: string): Promise<void> {
    const existing = await db.units.get(id)
    if (!existing) return

    const usedCount = await db.products
        .where('workspaceId')
        .equals(existing.workspaceId)
        .and((product) => !product.isDeleted && product.unit === existing.code)
        .count()

    if (usedCount > 0) {
        throw new UnitInUseError()
    }

    const shouldSyncOnline = shouldUseCloudBusinessData(existing.workspaceId) && isOnline()

    if (shouldSyncOnline) {
        // ONLINE: Hard delete from Supabase
        const { error } = await runMutation('units.delete', () => supabase.from('units').delete().eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)

        await db.units.delete(id)
    } else {
        // OFFLINE: Remove locally and queue a hard delete for the next sync
        await db.units.delete(id)

        if (shouldUseCloudBusinessData(existing.workspaceId)) {
            await addToOfflineMutations('units', id, 'delete', { id, hardDelete: true }, existing.workspaceId)
        }
    }
}

// ===================
// PRODUCTS HOOKS
// ===================

export interface UseProductsOptions {
    syncRemote?: boolean
    syncBarcodeCache?: boolean
    enabled?: boolean
}

export function useProducts(workspaceId: string | undefined, options: UseProductsOptions = {}) {
    const isOnline = useNetworkStatus()
    const enabled = options.enabled ?? true
    const syncRemote = options.syncRemote ?? true
    const syncBarcodeCache = options.syncBarcodeCache ?? true

    const products = useLiveQuery(
        () => enabled && workspaceId ? db.products.where('workspaceId').equals(workspaceId).and(p => !p.isDeleted).toArray() : [],
        [enabled, workspaceId]
    )

    useEffect(() => {
        if (!enabled || !syncRemote || !isOnline || !workspaceId || !shouldUseCloudBusinessData(workspaceId)) {
            return
        }

        void fetchTableFromSupabase('products', db.products, workspaceId)
            .then(() => syncBarcodeCache ? syncProductBarcodeCachesForWorkspace(workspaceId) : undefined)
            .catch((error) => {
                console.error('[Products] Failed to hydrate products:', error)
            })
    }, [enabled, isOnline, syncBarcodeCache, syncRemote, workspaceId])

    return products ?? []
}

export function useProductsByIds(workspaceId: string | undefined, productIds: string[]) {
    const productIdKey = productIds.join('|')

    const products = useLiveQuery(
        async () => {
            if (!workspaceId || productIds.length === 0) {
                return []
            }

            const rows = await db.products.bulkGet(productIds)
            return rows.filter((product): product is Product =>
                !!product && product.workspaceId === workspaceId && !product.isDeleted
            )
        },
        [workspaceId, productIdKey]
    )

    return products ?? []
}

export function useProduct(id: string | undefined) {
    const product = useLiveQuery(
        () => id ? db.products.get(id) : undefined,
        [id]
    )
    return product
}

export function useProductVariants(parentProductId: string | undefined) {
    const variants = useLiveQuery(
        () => parentProductId
            ? db.products
                .where('parentProductId')
                .equals(parentProductId)
                .and((product) => !product.isDeleted)
                .sortBy('name')
            : [],
        [parentProductId]
    )

    return variants ?? []
}

export class ProductVariantRelationshipError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ProductVariantRelationshipError'
    }
}

async function assertCanUseProductAsVariantParent(
    workspaceId: string,
    parentProductId: string,
    variantProductId?: string,
    currentParentProductId?: string | null
) {
    const parent = await db.products.get(parentProductId)
    if (!parent || parent.isDeleted || parent.workspaceId !== workspaceId) {
        throw new ProductVariantRelationshipError('The selected parent product is not available in this workspace.')
    }

    if (isService(parent)) {
        throw new ProductVariantRelationshipError('Services cannot be variant parents or variants.')
    }

    if (parent.parentProductId) {
        throw new ProductVariantRelationshipError('A variant cannot be used as a parent product.')
    }

    if (!variantProductId) {
        return
    }

    if (parentProductId === variantProductId) {
        throw new ProductVariantRelationshipError('A product cannot be linked to itself.')
    }

    if (currentParentProductId && currentParentProductId !== parentProductId) {
        throw new ProductVariantRelationshipError('Unlink this product before assigning it to a different parent.')
    }

    const childVariants = await db.products
        .where('parentProductId')
        .equals(variantProductId)
        .and((product) => !product.isDeleted)
        .count()

    if (childVariants > 0) {
        throw new ProductVariantRelationshipError('A product with variants cannot become a variant itself.')
    }
}

export async function linkProductVariant(parentProductId: string, variantProductId: string) {
    const variant = await db.products.get(variantProductId)
    if (!variant || variant.isDeleted) {
        throw new ProductVariantRelationshipError('The selected product is no longer available.')
    }

    if (isService(variant)) {
        throw new ProductVariantRelationshipError('Services cannot be variant parents or variants.')
    }

    await assertCanUseProductAsVariantParent(
        variant.workspaceId,
        parentProductId,
        variant.id,
        variant.parentProductId
    )
    await updateProduct(variant.id, { parentProductId })
}

export async function unlinkProductVariant(variantProductId: string) {
    const variant = await db.products.get(variantProductId)
    if (!variant || variant.isDeleted) {
        throw new ProductVariantRelationshipError('The selected product is no longer available.')
    }

    if (!variant.parentProductId) {
        return
    }

    await updateProduct(variant.id, { parentProductId: null })
}

export async function createProduct(workspaceId: string, data: Omit<Product, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'>): Promise<Product> {
    const now = new Date().toISOString()
    const id = generateId()
    const service = isService(data)
    const sku = service ? '' : trimProductSku(data.sku)
    const isSavingOnline = isOnline(workspaceId)
    const initialQuantity = service ? 0 : Number(data.quantity) || 0
    const initialStorageId = service ? null : data.storageId ?? null

    if (service && data.parentProductId) {
        throw new ProductVariantRelationshipError('Services cannot be variant parents or variants.')
    }

    if (data.parentProductId) {
        await assertCanUseProductAsVariantParent(workspaceId, data.parentProductId)
    }

    if (!service) {
        await ensureProductSkuIsAvailable(workspaceId, sku, {
            productId: id,
            parentProductId: data.parentProductId ?? null
        })
    }

    const product: Product = {
        ...data,
        isService: service,
        sku,
        skuKey: normalizeProductSku(sku),
        // The initial quantity is written as inventory below.  Keeping the
        // product snapshot empty prevents it racing the inventory sync.
        quantity: 0,
        minStockLevel: service ? 0 : data.minStockLevel,
        unit: service ? '' : data.unit,
        parentProductId: service ? null : data.parentProductId ?? null,
        storageId: null,
        storageName: undefined,
        id,
        workspaceId,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isSavingOnline ? 'synced' : 'pending') as any, // Cast to any or SyncStatus to fix TS error
        lastSyncedAt: isSavingOnline ? now : null,
        version: 1,
        isDeleted: false
    }

    if (isSavingOnline) {
        // ONLINE
        const payload = toSupabaseProductPayload(product)
        const { error } = await runMutation('products.create', () => supabase.from('products').insert(payload))

        if (error) {
            if (isDuplicateProductSkuMutationError(error)) {
                throw new DuplicateProductSkuError()
            }
            console.error('Supabase write failed:', error)
            throw normalizeSupabaseActionError(error)
        }

        await db.products.add(product)
    } else {
        // OFFLINE
        await db.transaction('rw', db.products, async () => {
            await db.products.add(product)
        })
        await addToOfflineMutations('products', id, 'create', product as unknown as Record<string, unknown>, workspaceId)
    }

    const normalizedProduct = service
        ? product
        : await setProductInventoryFromLegacyInput({
            workspaceId,
            productId: id,
            storageId: initialStorageId,
            quantity: initialQuantity,
            timestamp: now
        })

    return normalizedProduct || product
}

export async function updateProduct(id: string, data: Partial<Product>): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.products.get(id)
    if (!existing) throw new Error('Product not found')
    const isSavingOnline = isOnline(existing.workspaceId)
    const {
        quantity: _ignoredQuantity,
        storageId: _ignoredStorageId,
        storageName: _ignoredStorageName,
        ...productData
    } = data
    const hasIsServiceUpdate = Object.prototype.hasOwnProperty.call(productData, 'isService')
    const nextIsService = hasIsServiceUpdate ? productData.isService === true : isService(existing)
    const hasSkuUpdate = Object.prototype.hasOwnProperty.call(productData, 'sku')
    const hasParentProductIdUpdate = Object.prototype.hasOwnProperty.call(productData, 'parentProductId')
    const hasIsDeletedUpdate = Object.prototype.hasOwnProperty.call(productData, 'isDeleted')
    const sku = nextIsService ? '' : hasSkuUpdate ? trimProductSku(productData.sku ?? '') : existing.sku

    if (isService(existing) && hasIsServiceUpdate && !nextIsService) {
        throw new Error('Services cannot be converted into inventory products.')
    }

    if (nextIsService && (productData.parentProductId || existing.parentProductId)) {
        throw new ProductVariantRelationshipError('Services cannot be variant parents or variants.')
    }

    if (hasParentProductIdUpdate && productData.parentProductId) {
        await assertCanUseProductAsVariantParent(
            existing.workspaceId,
            productData.parentProductId,
            existing.id,
            existing.parentProductId
        )
    }

    const parentProductId = hasParentProductIdUpdate
        ? productData.parentProductId ?? null
        : existing.parentProductId ?? null

    const remainsActive = hasIsDeletedUpdate ? !productData.isDeleted : !existing.isDeleted
    if (!nextIsService && remainsActive && (hasSkuUpdate || hasParentProductIdUpdate || (hasIsDeletedUpdate && productData.isDeleted === false))) {
        await ensureProductSkuIsAvailable(existing.workspaceId, sku, {
            productId: id,
            parentProductId
        })
    }

    const updated = {
        ...existing,
        ...productData,
        ...(nextIsService ? {
            isService: true,
            sku: '',
            skuKey: '',
            unit: '',
            quantity: 0,
            minStockLevel: 0,
            storageId: null,
            storageName: undefined,
            parentProductId: null
        } : {}),
        ...(hasSkuUpdate ? { sku, skuKey: normalizeProductSku(sku) } : {}),
        updatedAt: now,
        syncStatus: (isSavingOnline ? 'synced' : 'pending') as any,
        lastSyncedAt: isSavingOnline ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (isSavingOnline) {
        // ONLINE
        const payload = toSupabaseProductPayload({
            ...productData,
            ...(hasSkuUpdate ? { sku } : {}),
            updatedAt: now
        })
        const { error } = await runMutation('products.update', () => supabase.from('products').update(payload).eq('id', id))

        if (error) {
            if (isDuplicateProductSkuMutationError(error)) {
                throw new DuplicateProductSkuError()
            }
            throw normalizeSupabaseActionError(error)
        }

        await db.products.put(updated)
    } else {
        // OFFLINE
        await db.transaction('rw', db.products, async () => {
            await db.products.put(updated)
        })
        await addToOfflineMutations('products', id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
    }
}

async function softDeleteProductBarcodesForDeletedProduct(productId: string, workspaceId: string, now: string) {
    const activeRows = await db.product_barcodes.where('productId').equals(productId).and((row) => !row.isDeleted).toArray()
    if (activeRows.length === 0) {
        return
    }

    const usesCloud = shouldUseCloudBusinessData(workspaceId)
    let shouldQueueOffline = usesCloud && !isOnline(workspaceId)
    let deletedRows: ProductBarcode[] = activeRows.map((row) => ({
        ...row,
        isPrimary: false,
        isDeleted: true,
        updatedAt: now,
        syncStatus: shouldQueueOffline ? 'pending' : 'synced',
        lastSyncedAt: shouldQueueOffline ? row.lastSyncedAt : now,
        version: row.version + 1
    }))

    if (usesCloud && isOnline(workspaceId)) {
        try {
            const { error } = await runMutation('product_barcodes.cascadeDelete', () =>
                supabase.from('product_barcodes').upsert(deletedRows.map(toSupabaseProductBarcodePayload))
            )
            if (error) {
                throw normalizeSupabaseActionError(error)
            }
        } catch (error) {
            if (!shouldUseOfflineMutationFallback(error)) {
                throw normalizeSupabaseActionError(error)
            }

            shouldQueueOffline = true
            deletedRows = deletedRows.map((row, index) => ({
                ...row,
                syncStatus: 'pending',
                lastSyncedAt: activeRows[index]?.lastSyncedAt ?? row.lastSyncedAt
            }))
        }
    }

    await putProductBarcodeRowsAndRefreshCache(deletedRows)

    if (usesCloud && shouldQueueOffline) {
        await Promise.all(deletedRows.map((row) =>
            addToOfflineMutations('product_barcodes', row.id, 'update', row as unknown as Record<string, unknown>, row.workspaceId)
        ))
    }
}

async function detachProductVariantsAfterParentDeletion(
    parentProductId: string,
    workspaceId: string,
    timestamp: string,
    savedOnline: boolean
) {
    const variants = await db.products
        .where('parentProductId')
        .equals(parentProductId)
        .and((product) => !product.isDeleted)
        .toArray()

    if (variants.length === 0) {
        return
    }

    const detachedVariants = variants.map((variant) => ({
        ...variant,
        parentProductId: null,
        updatedAt: timestamp,
        syncStatus: savedOnline ? 'synced' as const : 'pending' as const,
        lastSyncedAt: savedOnline ? timestamp : variant.lastSyncedAt,
        version: savedOnline ? variant.version : variant.version + 1
    }))

    await db.products.bulkPut(detachedVariants)

    if (!savedOnline && shouldUseCloudBusinessData(workspaceId)) {
        await Promise.all(detachedVariants.map((variant) =>
            addToOfflineMutations('products', variant.id, 'update', variant as unknown as Record<string, unknown>, workspaceId)
        ))
    }
}

async function assertVariantsCanBecomeIndependentAfterParentDeletion(parentProductId: string) {
    const variants = await db.products
        .where('parentProductId')
        .equals(parentProductId)
        .and((product) => !product.isDeleted)
        .toArray()
    const seenSkuKeys = new Set<string>()

    for (const variant of variants) {
        const skuKey = normalizeProductSku(variant.sku)
        if (!skuKey) {
            continue
        }
        if (seenSkuKeys.has(skuKey)) {
            throw new ProductVariantRelationshipError(
                'Variants that share an SKU must stay linked to their parent. Change one of their SKUs before deleting this parent.'
            )
        }
        seenSkuKeys.add(skuKey)
    }
}

export async function deleteProduct(id: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = await db.products.get(id)
    if (!existing) return
    const isSavingOnline = isOnline(existing.workspaceId)

    if (!existing.parentProductId) {
        await assertVariantsCanBecomeIndependentAfterParentDeletion(id)
    }

    await replaceProductPriceBookItems(existing.workspaceId, id, [])

    const updated = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        syncStatus: (isSavingOnline ? 'synced' : 'pending') as any,
        version: existing.version + 1
    } as Product

    if (isSavingOnline) {
        // ONLINE
        const { error } = await runMutation('products.delete', () => supabase.from('products').update({ is_deleted: true, updated_at: now }).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)

        await db.products.put(updated)
    } else {
        // OFFLINE
        await db.products.put(updated)
        await addToOfflineMutations('products', id, 'delete', { id }, existing.workspaceId)
    }

    await detachProductVariantsAfterParentDeletion(id, existing.workspaceId, now, isSavingOnline)

    await softDeleteProductBarcodesForDeletedProduct(id, existing.workspaceId, now)

    await deleteInventoryForProduct(id, now)
}

interface UseProductBarcodeTableOptions {
    syncProductCache?: boolean
}

function useProductBarcodeTable(
    workspaceId: string | undefined,
    query: () => Promise<ProductBarcode[]>,
    options: UseProductBarcodeTableOptions = {}
) {
    const online = useNetworkStatus()
    const syncProductCache = options.syncProductCache ?? true

    const rows = useLiveQuery(
        () => query().then(sortProductBarcodes),
        [query]
    )

    useEffect(() => {
        if (!workspaceId || !online || !shouldUseCloudBusinessData(workspaceId)) {
            return
        }

        void fetchTableFromSupabase('product_barcodes', db.product_barcodes, workspaceId)
            .then(() => syncProductCache ? syncProductBarcodeCachesForWorkspace(workspaceId) : undefined)
    }, [online, syncProductCache, workspaceId])

    return rows ?? []
}

export function useWorkspaceProductBarcodes(
    workspaceId: string | undefined,
    options: UseProductBarcodeTableOptions = {}
) {
    return useProductBarcodeTable(
        workspaceId,
        () => workspaceId
            ? db.product_barcodes.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
            : Promise.resolve([]),
        options
    )
}

export function useProductBarcodes(productId: string | undefined) {
    const product = useProduct(productId)

    return useProductBarcodeTable(
        product?.workspaceId,
        () => productId
            ? db.product_barcodes.where('productId').equals(productId).and((row) => !row.isDeleted).toArray()
            : Promise.resolve([])
    )
}

async function putProductBarcodeRowsAndRefreshCache(rows: ProductBarcode[]) {
    if (rows.length === 0) {
        return
    }

    await db.transaction('rw', [db.product_barcodes, db.products], async () => {
        await db.product_barcodes.bulkPut(rows)
        await syncProductBarcodeCache(rows[0].productId)
    })
}

export async function addProductBarcode(
    workspaceId: string,
    productId: string,
    barcode: string,
    label?: string
): Promise<ProductBarcode> {
    const normalizedBarcode = normalizeProductBarcodeValue(barcode)
    if (!normalizedBarcode) {
        throw new Error('Barcode is required')
    }

    const product = await db.products.get(productId)
    if (!product || product.isDeleted || product.workspaceId !== workspaceId) {
        throw new Error('Product not found')
    }

    const duplicateBarcode = await findActiveProductBarcodeByValue(workspaceId, normalizedBarcode)
    if (duplicateBarcode) {
        throw new DuplicateProductBarcodeError()
    }

    const now = new Date().toISOString()
    const existingRows = await db.product_barcodes.where('productId').equals(productId).and((row) => !row.isDeleted).toArray()
    const usesCloud = shouldUseCloudBusinessData(workspaceId)
    let shouldQueueOffline = usesCloud && !isOnline()

    let productBarcode: ProductBarcode = {
        id: generateId(),
        workspaceId,
        productId,
        barcode: normalizedBarcode,
        label: normalizeProductBarcodeLabel(label),
        isPrimary: existingRows.length === 0,
        createdAt: now,
        updatedAt: now,
        syncStatus: shouldQueueOffline ? 'pending' : 'synced',
        lastSyncedAt: shouldQueueOffline ? null : now,
        version: 1,
        isDeleted: false
    }

    if (usesCloud && isOnline()) {
        try {
            const { error } = await runMutation('product_barcodes.create', () =>
                supabase.from('product_barcodes').insert(toSupabaseProductBarcodePayload(productBarcode))
            )
            if (error) {
                throw error
            }
        } catch (error) {
            if (isDuplicateProductBarcodeMutationError(error)) {
                throw new DuplicateProductBarcodeError()
            }

            if (!shouldUseOfflineMutationFallback(error)) {
                throw normalizeSupabaseActionError(error)
            }

            shouldQueueOffline = true
            productBarcode = {
                ...productBarcode,
                syncStatus: 'pending',
                lastSyncedAt: null
            }
        }
    }

    await putProductBarcodeRowsAndRefreshCache([productBarcode])

    if (usesCloud && shouldQueueOffline) {
        await addToOfflineMutations('product_barcodes', productBarcode.id, 'create', productBarcode as unknown as Record<string, unknown>, workspaceId)
    }

    return productBarcode
}

export async function updateProductBarcode(
    id: string,
    data: Partial<Pick<ProductBarcode, 'label' | 'isPrimary' | 'barcode'>>
): Promise<void> {
    const existing = await db.product_barcodes.get(id)
    if (!existing) {
        throw new Error('Product barcode not found')
    }

    const now = new Date().toISOString()
    const usesCloud = shouldUseCloudBusinessData(existing.workspaceId)
    let shouldQueueOffline = usesCloud && !isOnline()
    const normalizedBarcode = data.barcode !== undefined
        ? normalizeProductBarcodeValue(data.barcode)
        : existing.barcode
    if (!normalizedBarcode) {
        throw new Error('Barcode is required')
    }

    const duplicateBarcode = await findActiveProductBarcodeByValue(existing.workspaceId, normalizedBarcode, { excludeId: id })
    if (duplicateBarcode) {
        throw new DuplicateProductBarcodeError()
    }

    const activeRows = await db.product_barcodes.where('productId').equals(existing.productId).and((row) => !row.isDeleted).toArray()
    let rowsToPersist: ProductBarcode[] = []
    const primaryChanged = data.isPrimary === true

    for (const row of activeRows) {
        if (row.id === id) {
            rowsToPersist.push({
                ...row,
                barcode: normalizedBarcode,
                label: data.label !== undefined ? normalizeProductBarcodeLabel(data.label) : row.label,
                isPrimary: data.isPrimary ?? row.isPrimary,
                updatedAt: now,
                syncStatus: shouldQueueOffline ? 'pending' : 'synced',
                lastSyncedAt: shouldQueueOffline ? row.lastSyncedAt : now,
                version: row.version + 1
            })
            continue
        }

        if (primaryChanged && row.isPrimary) {
            rowsToPersist.push({
                ...row,
                isPrimary: false,
                updatedAt: now,
                syncStatus: shouldQueueOffline ? 'pending' : 'synced',
                lastSyncedAt: shouldQueueOffline ? row.lastSyncedAt : now,
                version: row.version + 1
            })
        }
    }

    if (rowsToPersist.length === 0) {
        return
    }

    if (usesCloud && isOnline()) {
        try {
            const { error } = await runMutation('product_barcodes.update', () =>
                supabase.from('product_barcodes').upsert(rowsToPersist.map(toSupabaseProductBarcodePayload))
            )
            if (error) {
                throw error
            }
        } catch (error) {
            if (isDuplicateProductBarcodeMutationError(error)) {
                throw new DuplicateProductBarcodeError()
            }
            if (!shouldUseOfflineMutationFallback(error)) {
                throw normalizeSupabaseActionError(error)
            }

            shouldQueueOffline = true
            rowsToPersist = rowsToPersist.map((row) => {
                const previousRow = activeRows.find((item) => item.id === row.id)
                return {
                    ...row,
                    syncStatus: 'pending',
                    lastSyncedAt: previousRow?.lastSyncedAt ?? row.lastSyncedAt
                }
            })
        }
    }

    await putProductBarcodeRowsAndRefreshCache(rowsToPersist)

    if (usesCloud && shouldQueueOffline) {
        await Promise.all(rowsToPersist.map((row) =>
            addToOfflineMutations('product_barcodes', row.id, 'update', row as unknown as Record<string, unknown>, row.workspaceId)
        ))
    }
}

export async function deleteProductBarcode(id: string): Promise<void> {
    const existing = await db.product_barcodes.get(id)
    if (!existing) {
        return
    }

    const now = new Date().toISOString()
    const usesCloud = shouldUseCloudBusinessData(existing.workspaceId)
    let shouldQueueOffline = usesCloud && !isOnline()
    const activeRows = sortProductBarcodes(
        await db.product_barcodes.where('productId').equals(existing.productId).and((row) => !row.isDeleted).toArray()
    )
    const nextPrimary = existing.isPrimary
        ? activeRows.find((row) => row.id !== existing.id)
        : null
    let rowsToPersist: ProductBarcode[] = activeRows
        .filter((row) => row.id === existing.id || (nextPrimary?.id === row.id))
        .map((row) => {
            if (row.id === existing.id) {
            return {
                ...row,
                isPrimary: false,
                isDeleted: true,
                updatedAt: now,
                syncStatus: shouldQueueOffline ? 'pending' : 'synced',
                lastSyncedAt: shouldQueueOffline ? row.lastSyncedAt : now,
                version: row.version + 1
            }
        }

        return {
            ...row,
            isPrimary: true,
            updatedAt: now,
            syncStatus: shouldQueueOffline ? 'pending' : 'synced',
            lastSyncedAt: shouldQueueOffline ? row.lastSyncedAt : now,
            version: row.version + 1
        }
    })

    if (rowsToPersist.length === 0) {
        return
    }

    if (usesCloud && isOnline()) {
        try {
            const { error } = await runMutation('product_barcodes.delete', () =>
                supabase.from('product_barcodes').upsert(rowsToPersist.map(toSupabaseProductBarcodePayload))
            )
            if (error) {
                throw error
            }
        } catch (error) {
            if (!shouldUseOfflineMutationFallback(error)) {
                throw normalizeSupabaseActionError(error)
            }

            shouldQueueOffline = true
            rowsToPersist = rowsToPersist.map((row) => {
                const previousRow = activeRows.find((item) => item.id === row.id)
                return {
                    ...row,
                    syncStatus: 'pending',
                    lastSyncedAt: previousRow?.lastSyncedAt ?? row.lastSyncedAt
                }
            })
        }
    }

    await putProductBarcodeRowsAndRefreshCache(rowsToPersist)

    if (usesCloud && shouldQueueOffline) {
        await Promise.all(rowsToPersist.map((row) =>
            addToOfflineMutations('product_barcodes', row.id, 'update', row as unknown as Record<string, unknown>, row.workspaceId)
        ))
    }
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
        createdBy: data.createdBy ?? getActiveBusinessUserId() ?? session?.user?.id ?? undefined,
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

export interface UseActiveDiscountMapOptions {
    products?: Product[]
    inventoryRows?: Inventory[]
    syncRemote?: boolean
    storageId?: string
}

export function useActiveDiscountMap(workspaceId: string | undefined, options: UseActiveDiscountMapOptions = {}) {
    const hasProductOverride = options.products !== undefined
    const hasInventoryOverride = options.inventoryRows !== undefined
    const syncRemote = options.syncRemote ?? true

    const localProducts = useProducts(workspaceId, {
        enabled: !hasProductOverride,
        syncRemote: syncRemote && !hasProductOverride
    })
    const localInventory = useInventory(workspaceId, {
        enabled: !hasInventoryOverride,
        storageId: options.storageId,
        syncRemote: syncRemote && !hasInventoryOverride
    })
    const productDiscounts = useProductDiscounts(workspaceId)
    const categoryDiscounts = useCategoryDiscounts(workspaceId)
    const products = options.products ?? localProducts
    const inventory = options.inventoryRows ?? localInventory

    return useMemo<Map<string, ResolvedActiveDiscount>>(() => resolveActiveDiscountMap({
        products,
        productDiscounts,
        categoryDiscounts,
        inventoryRows: inventory
    }), [categoryDiscounts, inventory, productDiscounts, products])
}

/** Resolves discounts against the price source currently selected by a selling flow. */
export function useDiscountPriceResolver(workspaceId: string | undefined, options: UseActiveDiscountMapOptions = {}) {
    const hasInventoryOverride = options.inventoryRows !== undefined
    const syncRemote = options.syncRemote ?? true

    const localInventory = useInventory(workspaceId, {
        enabled: !hasInventoryOverride,
        storageId: options.storageId,
        syncRemote: syncRemote && !hasInventoryOverride
    })
    const productDiscounts = useProductDiscounts(workspaceId)
    const categoryDiscounts = useCategoryDiscounts(workspaceId)
    const inventory = options.inventoryRows ?? localInventory
    const inventoryTotals = useMemo(() => buildInventoryTotalsByProduct(inventory), [inventory])

    return useCallback((product: Product, context: DiscountPriceContext) => {
        return resolveActiveDiscountForPriceContext({
            product,
            productDiscounts,
            categoryDiscounts,
            inventoryRows: inventory,
            context,
            stockTotal: isService(product) ? Number.MAX_SAFE_INTEGER : (inventoryTotals.get(product.id) ?? 0)
        })
    }, [categoryDiscounts, inventory, inventoryTotals, productDiscounts])
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
const TABLE_FETCH_PAGE_SIZE = 1000
const tableFetchesInFlight = new Map<string, Promise<void>>()

async function fetchTableFromSupabaseInternal<T extends { id: string, syncStatus: any, lastSyncedAt: any }>(
    tableName: string,
    table: any,
    workspaceId: string,
    options?: { includeDeleted?: boolean },
    hydrationOperationId?: string
): Promise<boolean> {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return false
    }

    const includeDeleted = options?.includeDeleted ?? false
    const client = getSupabaseClientForTable(tableName)
    const remoteTableName = getSupabaseRemoteTableName(tableName)
    const visibilityScopedRpc = getVisibilityScopedTableRpc(tableName)
    const remoteRows: any[] = []

    for (let from = 0; ; from += TABLE_FETCH_PAGE_SIZE) {
        let query = visibilityScopedRpc
            ? client.rpc(visibilityScopedRpc, { p_workspace_id: workspaceId })
            : client
                .from(remoteTableName)
                .select('*')
                .eq('workspace_id', workspaceId)

        // Only filter by is_deleted for tables that still have that column.
        if (!visibilityScopedRpc && tableName !== 'workspace_contacts' && !includeDeleted) {
            query = query.eq('is_deleted', false)
        }

        query = query
            .order('id', { ascending: true })
            .range(from, from + TABLE_FETCH_PAGE_SIZE - 1)

        const { data, error } = await query
        if (error) {
            throw error
        }
        if (!data) {
            throw new Error(`No data returned while reading ${tableName}`)
        }
        if (!await canReconcileCloudWorkspaceData(workspaceId)) {
            return false
        }

        remoteRows.push(...data)
        updateWorkspaceDataHydrationProgress(
            workspaceId,
            'supabase',
            tableName,
            remoteRows.length,
            hydrationOperationId
        )
        if (data.length < TABLE_FETCH_PAGE_SIZE) {
            break
        }
    }

    const syncedAt = new Date().toISOString()
    const remoteIds = new Set(remoteRows.map((row) => row.id))
    const remoteItems = remoteRows.map((remoteItem) => {
        const localItem = toCamelCase(remoteItem as any) as unknown as T
        if (tableName === 'products') {
            const product = localItem as unknown as Product
            product.isService = product.isService === true
            // Service-only NULL fields are valid in Supabase but legacy client
            // presentation code expects strings. Keep the local representation
            // safe without ever writing these values back for services.
            product.sku = product.sku ?? ''
            product.unit = product.unit ?? ''
            product.quantity = Number(product.quantity ?? 0)
            product.minStockLevel = Number(product.minStockLevel ?? 0)
            product.skuKey = normalizeProductSku(product.sku)
        }
        localItem.syncStatus = 'synced'
        localItem.lastSyncedAt = syncedAt
        return localItem
    })

    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return false
    }

    await db.transaction('rw', table, async () => {
        const localItems = await table.where('workspaceId').equals(workspaceId).toArray()
        const deletedIds = (localItems as any[])
            .filter((local) => !remoteIds.has(local.id) && local.syncStatus === 'synced')
            .map((local) => local.id)

        if (deletedIds.length > 0) {
            await table.bulkDelete(deletedIds)
        }
        if (remoteItems.length > 0) {
            await table.bulkPut(remoteItems)
        }
    })

    recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, tableName)
    return true
}

export function fetchTableFromSupabase<T extends { id: string, syncStatus: any, lastSyncedAt: any }>(
    tableName: string,
    table: any,
    workspaceId: string,
    options?: { includeDeleted?: boolean }
): Promise<void> {
    if (!workspaceId) {
        return Promise.resolve()
    }

    const includeDeleted = options?.includeDeleted ?? false
    const key = `${tableName}:${workspaceId}:${includeDeleted ? 'all' : 'active'}`
    const existing = tableFetchesInFlight.get(key)
    if (existing) {
        return existing
    }

    const request = (async () => {
        if (!await canReconcileCloudWorkspaceData(workspaceId)) {
            return
        }

        startWorkspaceDataHydration(workspaceId, 'supabase', tableName, key)
        try {
            const completed = await fetchTableFromSupabaseInternal<T>(tableName, table, workspaceId, options, key)
            if (completed) {
                completeWorkspaceDataHydration(workspaceId, 'supabase', tableName, undefined, key)
            } else {
                cancelWorkspaceDataHydration(workspaceId, 'supabase', tableName, key)
            }
        } catch (error) {
            failWorkspaceDataHydration(workspaceId, 'supabase', tableName, undefined, key)
            console.error(`[${tableName}] Failed to hydrate from Supabase:`, error)
        }
    })()
        .finally(() => {
            if (tableFetchesInFlight.get(key) === request) {
                tableFetchesInFlight.delete(key)
            }
        })

    tableFetchesInFlight.set(key, request)
    return request
}

async function saveEntity<T extends { id: string }>(tableName: string, table: any, entity: T, workspaceId: string) {
    const usesCloudBusinessData = shouldUseCloudBusinessData(workspaceId)
    const online = isOnline(workspaceId)
    if (usesCloudBusinessData && online) {
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
        if (usesCloudBusinessData) {
            await addToOfflineMutations(tableName as any, entity.id, 'create', entity as unknown as Record<string, unknown>, workspaceId)
        }
    }
}

async function updateEntity<T extends { id: string, workspaceId: string, version: number, lastSyncedAt: any }>(tableName: string, table: any, id: string, data: Partial<T> & Record<string, any>) {
    const now = new Date().toISOString()
    const existing = await table.get(id)
    if (!existing) throw new Error('Entity not found')
    const usesCloudBusinessData = shouldUseCloudBusinessData(existing.workspaceId)
    const online = isOnline(existing.workspaceId)
    const syncStatus = usesCloudBusinessData
        ? (online ? 'synced' : 'pending')
        : 'synced'

    const updated = {
        ...existing,
        ...data,
        updatedAt: now,
        syncStatus: syncStatus as any,
        lastSyncedAt: syncStatus === 'synced' ? now : existing.lastSyncedAt,
        version: existing.version + 1
    }

    if (usesCloudBusinessData && online) {
        const client = getSupabaseClientForTable(tableName)
        const payload = toSnakeCase({ ...data, updatedAt: now })
        const { error } = await runMutation(`${tableName}.update`, () => client.from(tableName).update(payload).eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)
        await table.put(updated)
    } else {
        await table.put(updated)
        if (usesCloudBusinessData) {
            await addToOfflineMutations(tableName as any, id, 'update', updated as unknown as Record<string, unknown>, existing.workspaceId)
        }
    }
}

// ===================
// INVOICES HOOKS
// ===================

export function useInvoices(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const viewOwnScope = useViewOwnRecordScope('invoice_history.view_own')

    const invoices = useLiveQuery(
        () => workspaceId
            ? db.invoices
                .where('workspaceId')
                .equals(workspaceId)
                .and((invoice) => !invoice.isDeleted && (
                    !viewOwnScope.isRestricted
                    || invoice.createdBy === viewOwnScope.userId
                    || invoice.userId === viewOwnScope.userId
                ))
                .toArray()
            : [],
        [workspaceId, viewOwnScope.isRestricted, viewOwnScope.userId]
    )

    const syncInvoicesFromSupabase = useCallback(async () => {
        if (isOnline && workspaceId && await canReconcileCloudWorkspaceData(workspaceId)) {
            const { data, error } = await supabase
                .from('invoices')
                .select('*')
                .eq('workspace_id', workspaceId)
                .eq('is_deleted', false)

            if (!data || error || !await canReconcileCloudWorkspaceData(workspaceId)) {
                return
            }

            if (data && !error) {
                if (!await canReconcileCloudWorkspaceData(workspaceId)) {
                    return
                }
                await db.transaction('rw', [db.invoices, db.offline_mutations], async () => {
                    const remoteIds = new Set(data.map(d => d.id))
                    const localItems = await db.invoices.where('workspaceId').equals(workspaceId).toArray()

                    // Delete local items that are missing from server (remotely deleted).
                    // Handles 'synced', 'pending', and orphan items with no syncStatus.
                    // Pending items also get their offline mutations cleaned up to prevent re-creation.
                    for (const local of localItems) {
                        if (!remoteIds.has(local.id)) {
                            if (local.syncStatus === 'pending') {
                                await db.offline_mutations
                                    .where({ entityType: 'invoices', entityId: local.id, status: 'pending' })
                                    .delete()
                            }
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
    }, [isOnline, workspaceId])

    useEffect(() => {
        syncInvoicesFromSupabase()
    }, [
        syncInvoicesFromSupabase,
        viewOwnScope.isRestricted,
        viewOwnScope.userId,
    ])

    // Re-sync on window focus/visibility so deletions from another tab/client are reflected
    useEffect(() => {
        const handleFocus = () => {
            syncInvoicesFromSupabase()
        }
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                syncInvoicesFromSupabase()
            }
        }
        window.addEventListener('focus', handleFocus)
        document.addEventListener('visibilitychange', handleVisibility)
        return () => {
            window.removeEventListener('focus', handleFocus)
            document.removeEventListener('visibilitychange', handleVisibility)
        }
    }, [syncInvoicesFromSupabase])

    return { invoices: invoices ?? [], refreshInvoices: syncInvoicesFromSupabase }
}

export function useInvoice(id: string | undefined) {
    const viewOwnScope = useViewOwnRecordScope('invoice_history.view_own')
    const invoice = useLiveQuery(
        async () => {
            if (!id) return undefined
            const row = await db.invoices.get(id)
            if (
                !row
                || (
                    viewOwnScope.isRestricted
                    && row.createdBy !== viewOwnScope.userId
                    && row.userId !== viewOwnScope.userId
                )
            ) {
                return undefined
            }
            return row
        },
        [id, viewOwnScope.isRestricted, viewOwnScope.userId]
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
        sourceId: data.sourceId || overrideId || id,
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
        // Get current auth user to satisfy RLS 'user_id' check
        const session = await getMutationSession('invoices.create')
        const currentUserId = getActiveBusinessUserId() ?? session?.user?.id

        const payload = toSnakeCase(sanitizeInvoiceRemotePayload({
            ...invoice,
            userId: currentUserId // Explicitly set user_id for RLS
        } as unknown as Record<string, unknown>))

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

    // Legacy order/report prints may have a random invoice primary key. Reuse the
    // newest parent with the same origin identity instead of creating another row.
    if (data.sourceId && data.origin) {
        const identityMatches = await db.invoices
            .where('[workspaceId+origin+sourceId]')
            .equals([workspaceId, data.origin, data.sourceId])
            .filter((invoice) => !invoice.isDeleted)
            .toArray()
        const existingByOrigin = identityMatches.sort((left, right) =>
            new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
        )[0]
        if (existingByOrigin) {
            await updateInvoice(existingByOrigin.id, {
                ...data,
                updatedAt: new Date().toISOString()
            })
            return { ...existingByOrigin, ...data } as Invoice
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
        // Filter out local-only fields from update payload.
        const payload = toSnakeCase({
            ...sanitizeInvoiceRemotePayload(data as unknown as Record<string, unknown>),
            updatedAt: now
        })
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

export async function enrichSalesForUiRows(workspaceId: string, sales: Sale[]) {
    if (sales.length === 0) {
        return sales
    }

    const saleIds = sales.map((sale) => sale.id)
    const cashierIds = Array.from(new Set(
        sales
            .map((sale) => sale.cashierId)
            .filter((cashierId): cashierId is string => typeof cashierId === 'string' && cashierId.length > 0)
    ))
    const [localItems, localExchangeRows, localReturns, localProductExchanges, cashierUsers, profileRows] = await Promise.all([
        db.sale_items.where('saleId').anyOf(saleIds).toArray(),
        db.sales_exchange.where('saleId').anyOf(saleIds).toArray(),
        db.sale_returns.where('saleId').anyOf(saleIds).toArray(),
        db.sale_product_exchanges.where('saleId').anyOf(saleIds).toArray(),
        cashierIds.length > 0 ? db.users.bulkGet(cashierIds) : Promise.resolve([]),
        cashierIds.length > 0 ? db.profiles.where('id').anyOf(cashierIds).toArray() : Promise.resolve([]),
    ])
    const returnIds = localReturns.map((saleReturn) => saleReturn.id)

    const productIds = Array.from(new Set(
        localItems
            .map((item) => item.productId)
            .filter((productId): productId is string => typeof productId === 'string' && productId.length > 0)
    ))
    const [localReturnItems, products] = await Promise.all([
        returnIds.length > 0 ? db.sale_return_items.where('returnId').anyOf(returnIds).toArray() : Promise.resolve([]),
        productIds.length > 0 ? db.products.bulkGet(productIds) : Promise.resolve([]),
    ])
    const availableProducts = products.filter(Boolean) as Product[]
    const productById = new Map(
        availableProducts
            .map((product) => [product.id, product] as const)
    )

    const categoryIds = Array.from(new Set(
        availableProducts
            .map((product) => product.categoryId)
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

    const cashierNameById = new Map(
        (cashierUsers.filter(Boolean) as User[])
            .map((user) => [user.id, user.name || user.email || 'Staff'] as const)
    )
    // Fallback to profiles table for users not in the users table
    for (const p of profileRows) {
        if (!cashierNameById.has(p.id)) {
            cashierNameById.set(p.id, p.name || 'Staff')
        }
    }

    const itemsBySaleId = new Map<string, Record<string, unknown>[]>()
    for (const item of localItems) {
        const product = productById.get(item.productId)
        const categoryName = product?.categoryId
            ? (categoryById.get(product.categoryId)?.name || product.category || '')
            : (product?.category || '')

        const enrichedItem: Record<string, unknown> = {
            id: item.id,
            workspace_id: item.workspaceId,
            sale_id: item.saleId,
            created_at: item.createdAt,
            updated_at: item.updatedAt,
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
            batch_allocations: item.batchAllocations,
            original_batch_allocations: item.originalBatchAllocations,
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
                return_rules: product?.returnRules,
                unit: product?.unit || '',
                is_deleted: product?.isDeleted ?? false
            }
        }

        const existing = itemsBySaleId.get(item.saleId) ?? []
        existing.push(enrichedItem)
        itemsBySaleId.set(item.saleId, existing)
    }

    const exchangeBySaleId = new Map<string, typeof localExchangeRows>()
    for (const exchangeRow of localExchangeRows) {
        const existing = exchangeBySaleId.get(exchangeRow.saleId) ?? []
        existing.push(exchangeRow)
        exchangeBySaleId.set(exchangeRow.saleId, existing)
    }

    const productExchangeBySaleId = new Map<string, typeof localProductExchanges>()
    for (const exchange of localProductExchanges) {
        const existing = productExchangeBySaleId.get(exchange.saleId) ?? []
        existing.push(exchange)
        productExchangeBySaleId.set(exchange.saleId, existing)
    }

    const returnItemsByReturnId = new Map<string, Record<string, unknown>[]>()
    for (const item of localReturnItems) {
        const existing = returnItemsByReturnId.get(item.returnId) ?? []
        existing.push({
            id: item.id,
            workspace_id: item.workspaceId,
            return_id: item.returnId,
            sale_id: item.saleId,
            sale_item_id: item.saleItemId,
            quantity: item.quantity,
            unit_refund_amount: item.unitRefundAmount,
            refund_amount: item.refundAmount,
            restored_storage_id: item.restoredStorageId,
            restored_batch_allocations: item.restoredBatchAllocations,
            created_at: item.createdAt,
            updated_at: item.updatedAt
        })
        returnItemsByReturnId.set(item.returnId, existing)
    }

    const returnsBySaleId = new Map<string, Record<string, unknown>[]>()
    for (const saleReturn of localReturns) {
        const existing = returnsBySaleId.get(saleReturn.saleId) ?? []
        existing.push({
            id: saleReturn.id,
            workspace_id: saleReturn.workspaceId,
            sale_id: saleReturn.saleId,
            reason: saleReturn.reason,
            status: saleReturn.status,
            refund_method: saleReturn.refundMethod,
            refund_amount: saleReturn.refundAmount,
            returned_by: saleReturn.returnedBy,
            returned_at: saleReturn.returnedAt,
            source: saleReturn.source,
            created_at: saleReturn.createdAt,
            updated_at: saleReturn.updatedAt,
            items: returnItemsByReturnId.get(saleReturn.id) ?? []
        })
        returnsBySaleId.set(saleReturn.saleId, existing)
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
            _enrichedItems: enrichedItems,
            _salesExchange: exchangeBySaleId.get(sale.id) ?? [],
            _returns: returnsBySaleId.get(sale.id) ?? [],
            _productExchanges: productExchangeBySaleId.get(sale.id) ?? []
        }
    })
}

export async function generateLocalSaleSequenceId(workspaceId: string): Promise<number> {
  const sales = await db.sales
    .where("workspaceId")
    .equals(workspaceId)
    .toArray();
  const maxSequenceId = sales.reduce(
    (max, sale) => Math.max(max, sale.sequenceId ?? 0),
    0,
  );
  return maxSequenceId + 1;
}

type SalesSyncOptions = { startDate?: string; endDate?: string }
type SalesSyncResult = 'complete' | 'cancelled' | 'error'

const SALES_VERSION_PAGE_SIZE = 1000
const SALES_DETAIL_CHUNK_SIZE = 100
const SALES_FETCH_CONCURRENCY = 4
const salesSyncsInFlight = new Map<string, Promise<void>>()

async function fetchSalesChunks<T>(
  ids: string[],
  fetchChunk: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += SALES_DETAIL_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + SALES_DETAIL_CHUNK_SIZE))
  }

  const rows: T[] = []
  for (let index = 0; index < chunks.length; index += SALES_FETCH_CONCURRENCY) {
    const batch = chunks.slice(index, index + SALES_FETCH_CONCURRENCY)
    const batchRows = await Promise.all(batch.map(fetchChunk))
    batchRows.forEach((result) => rows.push(...result))
  }
  return rows
}

async function performSalesSync(
  workspaceId: string,
  options?: SalesSyncOptions,
  hydrationOperationId?: string,
): Promise<SalesSyncResult> {
  if (!await canReconcileCloudWorkspaceData(workspaceId)) return 'cancelled'

  const remoteChecks: Array<{ id: string; version: number; updated_at: string }> = []

  for (let from = 0; ; from += SALES_VERSION_PAGE_SIZE) {
    let versionQuery = supabase
      .from('sales')
      .select('id, version, updated_at')
      .eq('workspace_id', workspaceId)

    if (options?.startDate) {
      versionQuery = versionQuery.gte('created_at', options.startDate)
    }
    if (options?.endDate) {
      versionQuery = versionQuery.lte('created_at', options.endDate)
    }

    const result = await runSupabaseAction(
      'sales.cachedVersionCheck',
      () => versionQuery
        .order('id', { ascending: true })
        .range(from, from + SALES_VERSION_PAGE_SIZE - 1),
    )

    if (!result.data || result.error) return 'error'
    remoteChecks.push(...result.data)
    updateWorkspaceDataHydrationProgress(
      workspaceId,
      'supabase',
      'sales',
      remoteChecks.length,
      hydrationOperationId,
    )
    if (result.data.length < SALES_VERSION_PAGE_SIZE) break
  }

  if (!await canReconcileCloudWorkspaceData(workspaceId)) return 'cancelled'

  const localSales = await db.sales
    .where('workspaceId')
    .equals(workspaceId)
    .toArray()

  const relevantLocalSales = localSales.filter((sale) => {
    if (options?.startDate && sale.createdAt < options.startDate) return false
    if (options?.endDate && sale.createdAt > options.endDate) return false
    return true
  })
  const relevantSaleIds = relevantLocalSales.map((sale) => sale.id)
  const localSaleIdsWithItems = new Set(
    relevantSaleIds.length > 0
      ? (await db.sale_items.where('saleId').anyOf(relevantSaleIds).toArray())
        .map((item) => item.saleId)
      : []
  )

  const staleIds: string[] = []
  const remoteMap = new Map<string, { id: string; version: number; updated_at: string }>(
    remoteChecks.map((value) => [value.id, value]),
  )

  for (const local of relevantLocalSales) {
    const remote = remoteMap.get(local.id)
    if (remote) {
      const hasItemSnapshot = localSaleIdsWithItems.has(local.id) || Array.isArray(
        (local as Sale & { _enrichedItems?: unknown })._enrichedItems
      )
      if (
        remote.version !== local.version ||
        remote.updated_at !== local.updatedAt ||
        !hasItemSnapshot
      ) {
        staleIds.push(local.id)
      }
      remoteMap.delete(local.id)
    }
  }

  const missingIds = [...remoteMap.keys()]
  const idsToFetch = [...staleIds, ...missingIds]
  const remoteIds = new Set(remoteChecks.map((r) => r.id))

  let fullData: any[] | null = null
  let profilesMap: Record<string, string> = {}
  let remoteExchangeRows: any[] | null = null

  if (idsToFetch.length > 0) {
    try {
      remoteExchangeRows = await fetchSalesChunks(idsToFetch, async (chunk) => {
        const result = await runSupabaseAction('sales.cachedExchangeFetch', () =>
          supabase
            .from('sales_exchange')
            .select('*')
            .eq('workspace_id', workspaceId)
            .in('sale_id', chunk),
        )
        if (result.error) {
          throw result.error
        }
        return (result.data || []) as any[]
      })
    } catch {
      // Keep the local snapshot cache unchanged if the relation fetch fails.
      remoteExchangeRows = null
    }
  } else {
    remoteExchangeRows = []
  }

  if (idsToFetch.length > 0) {
    try {
      fullData = await fetchSalesChunks(idsToFetch, async (chunk) => {
        const result = await runSupabaseAction('sales.cachedFullFetch', () =>
          supabase
            .from('sales')
            .select(`
              *, instant_sale_tables(table_number), sale_items(*, product:product_id(name, sku, category, category_id, can_be_returned, return_rules, unit, is_deleted)),
              sale_returns(*, sale_return_items(*)),
              sale_product_exchanges(*)
            `)
            .eq('workspace_id', workspaceId)
            .in('id', chunk),
        )
        if (result.error) throw result.error
        return (result.data || []) as any[]
      })
    } catch {
      return 'error'
    }

    if (fullData) {
      const cashierIds = Array.from(
        new Set(fullData.map((s: any) => s.cashier_id).filter(Boolean)),
      )
      if (cashierIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, name, workspace_id, current_workspace')
          .in('id', cashierIds)
        if (profiles) {
          profilesMap = profiles.reduce(
            (acc: any, p: any) => ({ ...acc, [p.id]: p.name }),
            {},
          )
          if (!await canReconcileCloudWorkspaceData(workspaceId)) return 'cancelled'
          await db.profiles.bulkPut(
            profiles.map((p: any) => ({
              id: p.id,
              workspaceId: p.workspace_id,
              currentWorkspaceId: p.current_workspace || p.workspace_id,
              name: p.name,
              role: '',
            })),
          )
        }
      }
    }
  }

  const syncedAt = new Date().toISOString()
  const existingSaleById = new Map(relevantLocalSales.map((sale) => [sale.id, sale]))
  const salesToPut: Sale[] = []
  const saleItemsToPut: SaleItem[] = []
  const saleReturnsToPut: any[] = []
  const saleReturnItemsToPut: any[] = []
  const saleProductExchangesToPut: SaleProductExchange[] = []

  for (const remoteSale of fullData || []) {
    const {
      sale_items: remoteItems,
      sale_returns: remoteReturns,
      sale_product_exchanges: remoteProductExchanges,
      instant_sale_tables: remoteInstantSaleTables,
      ...saleData
    } = remoteSale as any
    const localSale = toCamelCase(saleData) as unknown as Sale
    const remoteInstantSaleTable = Array.isArray(remoteInstantSaleTables)
      ? remoteInstantSaleTables[0]
      : remoteInstantSaleTables
    localSale.tableNumber = remoteInstantSaleTable?.table_number ?? null
    localSale.syncStatus = 'synced'
    localSale.lastSyncedAt = syncedAt

    const enrichedItems = (remoteItems || []).map((item: any) => ({
      ...item,
      product_name: item.product?.name || 'Unknown Product',
      product_sku: item.product?.sku || '',
      product_category: item.product?.category || '',
      product_unit: item.product?.unit || '',
    }))
    ;(localSale as any)._enrichedItems = enrichedItems
    ;(localSale as any)._cashierName = profilesMap[saleData.cashier_id]
      || (existingSaleById.get(localSale.id) as any)?._cashierName
      || 'Staff'
    salesToPut.push(localSale)

    for (const item of remoteItems || []) {
      const { product, ...itemData } = item
      saleItemsToPut.push({
        ...(toCamelCase(itemData) as unknown as SaleItem),
        // Supabase rows created before the ownership migration may not carry
        // workspace_id yet; their parent sale is the authoritative fallback.
        workspaceId,
      })
    }

    for (const remoteReturn of remoteReturns || []) {
      const { sale_return_items: remoteReturnItems, ...returnData } = remoteReturn
      saleReturnsToPut.push({
        ...(toCamelCase(returnData) as any),
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
        version: 1,
        isDeleted: false,
      })

      for (const remoteReturnItem of remoteReturnItems || []) {
        saleReturnItemsToPut.push({
          ...(toCamelCase(remoteReturnItem) as any),
          syncStatus: 'synced',
          lastSyncedAt: syncedAt,
          version: 1,
          isDeleted: false,
        })
      }
    }

    for (const remoteExchange of remoteProductExchanges || []) {
      saleProductExchangesToPut.push({
        ...(toCamelCase(remoteExchange) as unknown as SaleProductExchange),
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
        version: 1,
        isDeleted: false,
      })
    }
  }

  if (!await canReconcileCloudWorkspaceData(workspaceId)) return 'cancelled'

  await db.transaction('rw', [db.sales, db.sales_exchange, db.sale_items, db.sale_returns, db.sale_return_items, db.sale_product_exchanges], async () => {
    if (remoteExchangeRows) {
      await db.sales_exchange.where('saleId').anyOf(idsToFetch).delete()
      if (remoteExchangeRows.length > 0) {
        await db.sales_exchange.bulkPut(
          remoteExchangeRows.map((row: any) => toCamelCase(row) as unknown as SalesExchange),
        )
      }
    }

    const deletedSaleIds = relevantLocalSales
      .filter((local) => !remoteIds.has(local.id) && local.syncStatus === 'synced')
      .map((local) => local.id)
    if (deletedSaleIds.length > 0) {
      await db.sales.bulkDelete(deletedSaleIds)
      await db.sales_exchange.where('saleId').anyOf(deletedSaleIds).delete()
      await db.sale_items.where('saleId').anyOf(deletedSaleIds).delete()
      await db.sale_returns.where('saleId').anyOf(deletedSaleIds).delete()
      await db.sale_return_items.where('saleId').anyOf(deletedSaleIds).delete()
      await db.sale_product_exchanges.where('saleId').anyOf(deletedSaleIds).delete()
    }

    const fetchedSaleIds = salesToPut.map((sale) => sale.id)
    if (fetchedSaleIds.length > 0) {
      await db.sale_items.where('saleId').anyOf(fetchedSaleIds).delete()
      await db.sale_returns.where('saleId').anyOf(fetchedSaleIds).delete()
      await db.sale_return_items.where('saleId').anyOf(fetchedSaleIds).delete()
      await db.sale_product_exchanges.where('saleId').anyOf(fetchedSaleIds).delete()
      await db.sales.bulkPut(salesToPut)
      if (saleItemsToPut.length > 0) await db.sale_items.bulkPut(saleItemsToPut)
      if (saleReturnsToPut.length > 0) await db.sale_returns.bulkPut(saleReturnsToPut)
      if (saleReturnItemsToPut.length > 0) await db.sale_return_items.bulkPut(saleReturnItemsToPut)
      if (saleProductExchangesToPut.length > 0) await db.sale_product_exchanges.bulkPut(saleProductExchangesToPut)
    }
  })

  return 'complete'
}

export function syncSalesFromSupabase(workspaceId: string, options?: SalesSyncOptions): Promise<void> {
  if (!workspaceId) return Promise.resolve()

  const key = `${workspaceId}:${options?.startDate || ''}:${options?.endDate || ''}`
  const existing = salesSyncsInFlight.get(key)
  if (existing) return existing

  const request = (async () => {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) return

    startWorkspaceDataHydration(workspaceId, 'supabase', 'sales', key)
    try {
      const result = await performSalesSync(workspaceId, options, key)
      if (result === 'complete') {
        recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, 'sales')
        completeWorkspaceDataHydration(workspaceId, 'supabase', 'sales', undefined, key)
      } else if (result === 'error') {
        failWorkspaceDataHydration(workspaceId, 'supabase', 'sales', undefined, key)
      } else {
        cancelWorkspaceDataHydration(workspaceId, 'supabase', 'sales', key)
      }
    } catch (error) {
      failWorkspaceDataHydration(workspaceId, 'supabase', 'sales', undefined, key)
      throw error
    }
  })().finally(() => {
    if (salesSyncsInFlight.get(key) === request) {
      salesSyncsInFlight.delete(key)
    }
  })
  salesSyncsInFlight.set(key, request)
  return request
}

type UseSalesOptions = { syncRemote?: boolean }

export function useSales(
  workspaceId: string | undefined,
  startDate?: string,
  endDate?: string,
  options: UseSalesOptions = {},
) {
    const isOnline = useNetworkStatus()
    const syncRemote = options.syncRemote ?? true
    const viewOwnScope = useViewOwnRecordScope('sales.view_own')

    const sales = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const query = startDate || endDate
              ? db.sales
                  .where('[workspaceId+createdAt]')
                  .between(
                    [workspaceId, startDate || Dexie.minKey],
                    [workspaceId, endDate || Dexie.maxKey],
                    true,
                    true,
                  )
              : db.sales.where('workspaceId').equals(workspaceId)

            const rows = await query.toArray()
            const visibleRows = viewOwnScope.isRestricted
                ? rows.filter((sale) => sale.cashierId === viewOwnScope.userId)
                : rows
            return enrichSalesForUiRows(workspaceId, visibleRows)
        },
        [workspaceId, startDate, endDate, viewOwnScope.isRestricted, viewOwnScope.userId]
    )

    useEffect(() => {
        if (syncRemote && isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void syncSalesFromSupabase(workspaceId, { startDate, endDate }).catch((error) => {
              console.error('[Sales] Failed to synchronize sales', error)
            })
        }
    }, [
        syncRemote,
        isOnline,
        workspaceId,
        startDate,
        endDate,
        viewOwnScope.isRestricted,
        viewOwnScope.userId,
    ])

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
            return_rules: item.return_rules,
            unit: item.product_unit || '',
            is_deleted: false
        }
    }))

    const salesExchange = localSale._salesExchange || []
    const exchangeRates = salesExchangeRowsToSnapshots(salesExchange)

    return {
        id: localSale.id,
        workspace_id: localSale.workspaceId,
        cashier_id: localSale.cashierId,
        total_amount: localSale.totalAmount,
        original_total_amount: localSale.originalTotalAmount,
        returned_amount: localSale.returnedAmount,
        return_status: localSale.returnStatus,
        settlement_currency: localSale.settlementCurrency,
        currency_conversion_applied: localSale.currencyConversionApplied,
        sales_exchange: salesExchange.map((row: any) => toSnakeCase(row)),
        exchange_rates: exchangeRates.length > 0 ? exchangeRates : null,
        created_at: localSale.createdAt,
        updated_at: localSale.updatedAt,
        origin: localSale.origin,
        payment_method: localSale.payment_method ?? localSale.paymentMethod,
        cashier_name: localSale._cashierName || 'Staff',
        items: enrichedItems,
        returns: (localSale as Sale & { _returns?: unknown[] })._returns ?? [],
        product_exchanges: (localSale as Sale & { _productExchanges?: unknown[] })._productExchanges ?? [],
        is_returned: localSale.isReturned,
        return_reason: localSale.returnReason,
        returned_at: localSale.returnedAt,
        returned_by: localSale.returnedBy,
        sequenceId: localSale.sequenceId,
        system_verified: localSale.systemVerified,
        system_review_status: localSale.systemReviewStatus,
        system_review_reason: localSale.systemReviewReason,
        table_number: localSale.tableNumber ?? null,
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

export function usePendingSyncMutations(): OfflineMutation[] {
    const mutations = useLiveQuery(async () => {
        const [pending, syncing, failedSaleCreates, failedIntegrityIssues] = await Promise.all([
            db.offline_mutations.where('status').equals('pending').toArray(),
            db.offline_mutations.where('status').equals('syncing').toArray(),
            db.offline_mutations
                .where('status')
                .equals('failed')
                .filter((mutation) => (
                    mutation.entityType === 'sales'
                    && mutation.operation === 'create'
                    && !isSyncIntegrityError(mutation.error)
                ))
                .toArray(),
            db.offline_mutations
                .where('status')
                .equals('failed')
                .filter((mutation) => isSyncIntegrityError(mutation.error))
                .toArray()
        ])

        return [...pending, ...syncing, ...failedSaleCreates, ...failedIntegrityIssues]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    }, [])

    return mutations ?? []
}

export function usePendingSyncCount() {
    return usePendingSyncMutations().length
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
    const salesViewOwnScope = useViewOwnRecordScope('sales.view_own')
    const invoicesViewOwnScope = useViewOwnRecordScope('invoice_history.view_own')
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
            db.invoices.where('workspaceId').equals(workspaceId).and((invoice) => !invoice.isDeleted && invoice.origin !== 'upload' && (
                !invoicesViewOwnScope.isRestricted
                || invoice.createdBy === invoicesViewOwnScope.userId
                || invoice.userId === invoicesViewOwnScope.userId
            )).count(),
            db.sales.where('workspaceId').equals(workspaceId).and((sale) => !sale.isDeleted && (
                !salesViewOwnScope.isRestricted || sale.cashierId === salesViewOwnScope.userId
            )).reverse().sortBy('createdAt').then(sales => sales.slice(0, 3)),
            db.invoices.where('workspaceId').equals(workspaceId).and((invoice) => !invoice.isDeleted && invoice.origin !== 'upload' && (
                !invoicesViewOwnScope.isRestricted
                || invoice.createdBy === invoicesViewOwnScope.userId
                || invoice.userId === invoicesViewOwnScope.userId
            )).reverse().sortBy('createdAt').then(invoices => invoices.slice(0, 4)),
            db.products.where('workspaceId').equals(workspaceId).and(p => !p.isDeleted && !isService(p) && p.quantity <= p.minStockLevel).toArray(),
            db.sales.where('workspaceId').equals(workspaceId).and((sale) => !sale.isDeleted && sale.createdAt >= thirtyDaysAgoStr && (
                !salesViewOwnScope.isRestricted || sale.cashierId === salesViewOwnScope.userId
            )).toArray()
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
    }, [
        workspaceId,
        invoicesViewOwnScope.isRestricted,
        invoicesViewOwnScope.userId,
        salesViewOwnScope.isRestricted,
        salesViewOwnScope.userId,
    ])

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
        if (!online || !workspaceId || !shouldUseCloudBusinessData(workspaceId)) {
            return
        }

        void fetchTableFromSupabase('storages', db.storages, workspaceId)
            .catch((error) => {
                console.error('[Storages] Failed to hydrate storages:', error)
            })
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
        isMarketplace: activeStorageCount === 0,
        createdAt: now,
        updatedAt: now,
        syncStatus: (isOnline() ? 'synced' : 'pending') as any,
        lastSyncedAt: isOnline() ? now : null,
        version: 1,
        isDeleted: false
    }

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

function toSupabaseStoragePayload(storage: Partial<Storage>) {
    return toSnakeCase({
        ...storage,
        syncStatus: undefined,
        lastSyncedAt: undefined,
        version: undefined
    })
}

async function queueStorageUpdateRows(rows: Storage[], workspaceId: string) {
    await Promise.all(rows.map((row) =>
        addToOfflineMutations(
            'storages',
            row.id,
            'update',
            toSupabaseStoragePayload(row) as any,
            workspaceId
        )
    ))
}

async function syncStorageUpdatesSequentially(rows: Storage[]) {
    for (const row of rows) {
        const payload = toSupabaseStoragePayload(row)
        const { error } = await runMutation('storages.syncRow', () =>
            supabase
                .from('storages')
                .update(payload)
                .eq('id', row.id)
        )

        if (error) {
            throw normalizeSupabaseActionError(error)
        }
    }
}

export async function setMarketplaceStorage(workspaceId: string, storageId: string): Promise<void> {
    const activeStorages = (await db.storages
        .where('workspaceId')
        .equals(workspaceId)
        .and((storage) => !storage.isDeleted)
        .toArray())
        .map(normalizeStorageRecord)

    const targetStorage = activeStorages.find((storage) => storage.id === storageId)
    if (!targetStorage) {
        throw new Error('Storage not found')
    }

    const hasExclusiveMarketplaceSelection = activeStorages.every((storage) =>
        storage.id === storageId ? storage.isMarketplace : !storage.isMarketplace
    )
    if (hasExclusiveMarketplaceSelection) {
        return
    }

    const now = new Date().toISOString()
    const updatedRows = activeStorages
        .filter((storage) => storage.id === storageId || storage.isMarketplace)
        .map((storage) => ({
            ...storage,
            isMarketplace: storage.id === storageId,
            updatedAt: now,
            syncStatus: 'pending' as const,
            lastSyncedAt: isOnline() ? storage.lastSyncedAt : null,
            version: storage.version + 1
        }))

    const previousRows = new Map(updatedRows.map((row) => {
        const previousRow = activeStorages.find((storage) => storage.id === row.id)
        return [row.id, previousRow ? { ...previousRow } : null] as const
    }))

    await db.transaction('rw', db.storages, async () => {
        for (const row of updatedRows) {
            await db.storages.put(row)
        }
    })

    if (isOnline()) {
        try {
            await syncStorageUpdatesSequentially(updatedRows)

            const syncedAt = new Date().toISOString()
            await Promise.all(updatedRows.map((row) =>
                db.storages.update(row.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            ))
        } catch (error) {
            if (shouldUseOfflineMutationFallback(error)) {
                await queueStorageUpdateRows(updatedRows, workspaceId)
            } else {
                await db.transaction('rw', db.storages, async () => {
                    for (const row of updatedRows) {
                        const previousRow = previousRows.get(row.id)
                        if (previousRow) {
                            await db.storages.put(previousRow)
                        }
                    }
                })
                throw normalizeSupabaseActionError(error)
            }
        }
    } else {
        await queueStorageUpdateRows(updatedRows, workspaceId)
    }
}

export async function transferInventoryBetweenStorages(
    workspaceId: string,
    sourceStorageId: string,
    targetStorageId: string,
    items: Array<{
        productId: string
        quantity: number
        batchSelections?: Array<{ batchId: string; quantity: number }>
    }>
): Promise<{ movedCount: number }> {
    const completedTransfers: Array<{
        productId: string
        quantity: number
        batchAllocations: Awaited<ReturnType<typeof transferInventoryQuantityWithBatches>>['batchAllocations']
        reverseBatchSelections: Awaited<ReturnType<typeof transferInventoryQuantityWithBatches>>['reverseBatchSelections']
    }> = []
    const affectedProductIds = new Set<string>()
    const now = new Date().toISOString()

    try {
        await refreshStockBatchesFromSupabase(workspaceId)

        for (const item of items) {
            const quantity = Number(item.quantity)
            if (!isPositiveQuantity(quantity)) {
                throw new Error('Transfer quantity must be greater than zero')
            }

            const availableQuantity = await getInventoryQuantityForProductStorage(item.productId, sourceStorageId)
            if (quantity - availableQuantity > QUANTITY_EPSILON) {
                throw new Error('Insufficient inventory in source storage')
            }

            const transferResult = await transferInventoryQuantityWithBatches({
                workspaceId,
                productId: item.productId,
                sourceStorageId,
                targetStorageId,
                quantity: roundQuantity(quantity),
                batchSelections: item.batchSelections,
                timestamp: now,
                skipBatchRefresh: true,
                skipReorderCheck: true
            })

            completedTransfers.push({
                productId: item.productId,
                quantity: roundQuantity(quantity),
                batchAllocations: transferResult.batchAllocations,
                reverseBatchSelections: transferResult.reverseBatchSelections
            })
            affectedProductIds.add(item.productId)
        }

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
                batchAllocations: transfer.batchAllocations,
                transferType: 'manual' as const
            })),
            { timestamp: now }
        )

        return { movedCount: completedTransfers.length }
    } catch (error) {
        for (const transfer of [...completedTransfers].reverse()) {
            try {
                await transferInventoryQuantityWithBatches({
                    workspaceId,
                    productId: transfer.productId,
                    sourceStorageId: targetStorageId,
                    targetStorageId: sourceStorageId,
                    quantity: transfer.quantity,
                    batchSelections: transfer.reverseBatchSelections,
                    timestamp: now,
                    skipBatchRefresh: true,
                    skipReorderCheck: true,
                    skipTransactionLog: true
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
    const completedMoves: Array<{
        productId: string
        quantity: number
        reverseBatchSelections: Awaited<ReturnType<typeof transferInventoryQuantityWithBatches>>['reverseBatchSelections']
    }> = []

    try {
        await refreshStockBatchesFromSupabase(existing.workspaceId)

        for (const row of inventoryToMove) {
            const transferResult = await transferInventoryQuantityWithBatches({
                workspaceId: existing.workspaceId,
                productId: row.productId,
                sourceStorageId: id,
                targetStorageId: moveProductsToStorageId,
                quantity: row.quantity,
                timestamp: now,
                skipBatchRefresh: true,
                skipReorderCheck: true
            })

            completedMoves.push({
                productId: row.productId,
                quantity: row.quantity,
                reverseBatchSelections: transferResult.reverseBatchSelections
            })
        }
    } catch (error) {
        console.error('[Storage] Failed to move inventory while deleting storage:', error)
        throw normalizeSupabaseActionError(error)
    }

    const fallbackStorage = existing.isMarketplace
        ? await db.storages.get(moveProductsToStorageId)
        : null

    const deletedStorage: Storage = {
        ...normalizeStorageRecord(existing),
        isMarketplace: false,
        isDeleted: true,
        updatedAt: now,
        syncStatus: 'pending',
        lastSyncedAt: isOnline() ? existing.lastSyncedAt : null,
        version: existing.version + 1
    }
    const promotedFallbackStorage: Storage | null = existing.isMarketplace && fallbackStorage && !fallbackStorage.isDeleted
        ? {
            ...normalizeStorageRecord(fallbackStorage),
            isMarketplace: true,
            updatedAt: now,
            syncStatus: 'pending',
            lastSyncedAt: isOnline() ? fallbackStorage.lastSyncedAt : null,
            version: fallbackStorage.version + 1
        }
        : null

    await db.transaction('rw', db.storages, async () => {
        await db.storages.put(deletedStorage)
        if (promotedFallbackStorage) {
            await db.storages.put(promotedFallbackStorage)
        }
    })

    if (isOnline()) {
        try {
            const rowsToSync = promotedFallbackStorage
                ? [deletedStorage, promotedFallbackStorage]
                : [deletedStorage]
            await syncStorageUpdatesSequentially(rowsToSync)

            await db.storages.update(id, { syncStatus: 'synced', lastSyncedAt: now })
            if (promotedFallbackStorage) {
                await db.storages.update(promotedFallbackStorage.id, { syncStatus: 'synced', lastSyncedAt: now })
            }
        } catch (error) {
            if (shouldUseOfflineMutationFallback(error)) {
                await addToOfflineMutations('storages', id, 'update', toSupabaseStoragePayload(deletedStorage) as any, existing.workspaceId)
                if (promotedFallbackStorage) {
                    await addToOfflineMutations(
                        'storages',
                        promotedFallbackStorage.id,
                        'update',
                        toSupabaseStoragePayload(promotedFallbackStorage) as any,
                        existing.workspaceId
                    )
                }
            } else {
                await db.storages.put(existing)
                if (fallbackStorage) {
                    await db.storages.put(normalizeStorageRecord(fallbackStorage))
                }
                for (const move of [...completedMoves].reverse()) {
                    await transferInventoryQuantityWithBatches({
                        workspaceId: existing.workspaceId,
                        productId: move.productId,
                        sourceStorageId: moveProductsToStorageId,
                        targetStorageId: id,
                        quantity: move.quantity,
                        batchSelections: move.reverseBatchSelections,
                        timestamp: now,
                        skipBatchRefresh: true,
                        skipReorderCheck: true,
                        skipTransactionLog: true
                    })
                }
                throw normalizeSupabaseActionError(error)
            }
        }
    } else {
        await addToOfflineMutations('storages', id, 'update', toSupabaseStoragePayload(deletedStorage) as any, existing.workspaceId)
        if (promotedFallbackStorage) {
            await addToOfflineMutations(
                'storages',
                promotedFallbackStorage.id,
                'update',
                toSupabaseStoragePayload(promotedFallbackStorage) as any,
                existing.workspaceId
            )
        }
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
        () => {
            if (!workspaceId) return []
            return db.users.where('workspaceId').equals(workspaceId).and(u => !u.isDeleted).toArray().then(async (users) => {
                // Fallback: merge profiles not yet in users table
                const profileRows = await db.profiles.where('workspaceId').equals(workspaceId).toArray()
                const userIds = new Set(users.map(u => u.id))
                const missing = profileRows.filter(p => !userIds.has(p.id))
                if (missing.length === 0) return users
                return [...users, ...missing.map(p => ({
                    id: p.id,
                    workspaceId: p.workspaceId,
                    name: p.name,
                    email: '',
                    role: p.role,
                    profileUrl: p.profile_url ?? undefined,
                    createdAt: p.created_at || new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    syncStatus: 'synced' as const,
                    lastSyncedAt: new Date().toISOString(),
                    version: 1,
                    isDeleted: false,
                } as User))]
            })
        },
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (isOnline && workspaceId && await canReconcileCloudWorkspaceData(workspaceId)) {
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

export function useExpenseSeries(workspaceId: string | undefined, options?: { includeDeleted?: boolean; includeVoided?: boolean }) {
    const isOnline = useNetworkStatus()
    const includeDeleted = options?.includeDeleted ?? false
    const includeVoided = options?.includeVoided ?? false
    const series = useLiveQuery(
        () => workspaceId
            ? db.expense_series.where('workspaceId').equals(workspaceId).and(s =>
                (includeDeleted || !s.isDeleted) && (includeVoided || !s.voidId)
            ).toArray()
            : [],
        [workspaceId, includeDeleted, includeVoided]
    )

    useEffect(() => {
        if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('expense_series', db.expense_series, workspaceId)
        }
    }, [isOnline, workspaceId])

    return series ?? []
}

export class DuplicateExpenseCategoryNameError extends Error {
    constructor() {
        super('Duplicate expense category name')
        this.name = 'DuplicateExpenseCategoryNameError'
    }
}

export class ExpenseCategoryInUseError extends Error {
    constructor() {
        super('Expense category is in use')
        this.name = 'ExpenseCategoryInUseError'
    }
}

function normalizeExpenseCategoryName(name: string) {
    return name.trim().replace(/\s+/g, ' ')
}

async function assertExpenseCategoryNameAvailable(workspaceId: string, name: string, categoryId?: string) {
    const normalizedName = normalizeExpenseCategoryName(name).toLocaleLowerCase()
    const duplicate = await db.expense_categories
        .where('workspaceId')
        .equals(workspaceId)
        .and((category) =>
            !category.isDeleted
            && category.id !== categoryId
            && normalizeExpenseCategoryName(category.name).toLocaleLowerCase() === normalizedName
        )
        .first()

    if (duplicate) {
        throw new DuplicateExpenseCategoryNameError()
    }
}

export function useExpenseCategories(workspaceId: string | undefined) {
    const isOnline = useNetworkStatus()
    const categories = useLiveQuery(
        () => workspaceId
            ? db.expense_categories
                .where('workspaceId')
                .equals(workspaceId)
                .and((category) => !category.isDeleted)
                .sortBy('name')
            : [],
        [workspaceId]
    )

    useEffect(() => {
        if (isOnline && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase('expense_categories', db.expense_categories, workspaceId)
        }
    }, [isOnline, workspaceId])

    return categories ?? []
}

export async function createExpenseCategory(workspaceId: string, name: string) {
    const normalizedName = normalizeExpenseCategoryName(name)
    if (!normalizedName) {
        throw new Error('Expense category name is required')
    }

    await assertExpenseCategoryNameAvailable(workspaceId, normalizedName)

    const now = new Date().toISOString()
    const online = isOnline(workspaceId)
    const usesCloudBusinessData = shouldUseCloudBusinessData(workspaceId)
    const category = {
        id: generateId(),
        workspaceId,
        name: normalizedName,
        createdAt: now,
        updatedAt: now,
        syncStatus: usesCloudBusinessData && online
            ? 'synced' as const
            : usesCloudBusinessData
                ? 'pending' as const
                : 'synced' as const,
        lastSyncedAt: usesCloudBusinessData && online ? now : null,
        version: 1,
        isDeleted: false
    }

    await saveEntity('expense_categories', db.expense_categories, category, workspaceId)
    return category
}

export async function updateExpenseCategory(id: string, name: string): Promise<void> {
    const existing = await db.expense_categories.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Expense category not found')
    }

    const normalizedName = normalizeExpenseCategoryName(name)
    if (!normalizedName) {
        throw new Error('Expense category name is required')
    }

    await assertExpenseCategoryNameAvailable(existing.workspaceId, normalizedName, id)
    await updateEntity('expense_categories', db.expense_categories, id, { name: normalizedName })
}

export async function deleteExpenseCategory(id: string): Promise<void> {
    const existing = await db.expense_categories.get(id)
    if (!existing || existing.isDeleted) {
        return
    }

    const linkedExpense = await db.expense_series
        .where('categoryId')
        .equals(id)
        .and((series) => !series.isDeleted)
        .first()

    if (linkedExpense) {
        throw new ExpenseCategoryInUseError()
    }

    await updateEntity('expense_categories', db.expense_categories, id, { isDeleted: true })
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
            ? db.expense_items.where('workspaceId').equals(workspaceId).and(i => !i.isDeleted && !i.voidId && i.month === month).toArray()
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

const expenseItemEnsuresInFlight = new Map<string, Promise<void>>()

async function ensureExpenseItemsForMonthInternal(workspaceId: string, month: string): Promise<void> {
    const series = await db.expense_series.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted && !s.voidId).toArray()
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
        const { error } = await runMutation('expense_items.bulkCreate', () =>
            client.from('expense_items').upsert(payload, {
                onConflict: 'series_id,month',
                ignoreDuplicates: true
            })
        )
        if (error) throw normalizeSupabaseActionError(error)

        // Another caller or client may have won the insert race with a
        // different generated ID. Read back the authoritative rows instead of
        // caching the IDs generated by this caller.
        const { data: remoteRows, error: fetchError } = await client
            .from('expense_items')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('month', month)

        if (fetchError) throw normalizeSupabaseActionError(fetchError)

        const syncedAt = new Date().toISOString()
        const remoteItems = (remoteRows ?? []).map((remoteRow) => {
            const item = toCamelCase(remoteRow as any) as unknown as ExpenseItem
            item.syncStatus = 'synced'
            item.lastSyncedAt = syncedAt
            return item
        })
        const remoteByKey = new Map(remoteItems.map(item => [`${item.seriesId}:${item.month}`, item]))

        await db.transaction('rw', db.expense_items, async () => {
            const localItems = await db.expense_items
                .where('workspaceId')
                .equals(workspaceId)
                .and(item => item.month === month)
                .toArray()
            const staleLocalIds = localItems
                .filter(item => {
                    const remoteItem = remoteByKey.get(`${item.seriesId}:${item.month}`)
                    return remoteItem && remoteItem.id !== item.id
                })
                .map(item => item.id)

            if (staleLocalIds.length > 0) {
                await db.expense_items.bulkDelete(staleLocalIds)
            }
            if (remoteItems.length > 0) {
                await db.expense_items.bulkPut(remoteItems)
            }
        })
    } else {
        const createdItems: ExpenseItem[] = []
        await db.transaction('rw', db.expense_items, async () => {
            const currentItems = await db.expense_items
                .where('workspaceId')
                .equals(workspaceId)
                .and(item => item.month === month)
                .toArray()
            const currentKeys = new Set(currentItems.map(item => `${item.seriesId}:${item.month}`))

            for (const item of toCreate) {
                const key = `${item.seriesId}:${item.month}`
                if (currentKeys.has(key)) continue
                await db.expense_items.add(item)
                currentKeys.add(key)
                createdItems.push(item)
            }
        })

        for (const item of createdItems) {
            await addToOfflineMutations('expense_items', item.id, 'create', item as unknown as Record<string, unknown>, workspaceId)
        }
    }
}

export function ensureExpenseItemsForMonth(workspaceId: string, month: string): Promise<void> {
    const key = `${workspaceId}:${month}`
    const existing = expenseItemEnsuresInFlight.get(key)
    if (existing) return existing

    const request = ensureExpenseItemsForMonthInternal(workspaceId, month).finally(() => {
        if (expenseItemEnsuresInFlight.get(key) === request) {
            expenseItemEnsuresInFlight.delete(key)
        }
    })
    expenseItemEnsuresInFlight.set(key, request)
    return request
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

                if (!data || error || !await canReconcileCloudWorkspaceData(workspaceId)) {
                    return
                }

                if (data && !error) {
                    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
                        return
                    }
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
        syncStatus: isOnline(workspaceId) ? 'synced' : 'pending',
        lastSyncedAt: isOnline(workspaceId) ? now : null,
        version: 1
    }

    if (isOnline(workspaceId)) {
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
        syncStatus: isOnline(existing.workspaceId) ? 'synced' : 'pending',
        lastSyncedAt: isOnline(existing.workspaceId) ? now : existing.lastSyncedAt,
        version: existing.version + 1
    } as WorkspaceContact

    if (isOnline(existing.workspaceId)) {
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

    if (isOnline(existing.workspaceId)) {
        const { error } = await runMutation('workspace_contacts.delete', () => supabase.from('workspace_contacts').delete().eq('id', id))
        if (error) throw normalizeSupabaseActionError(error)
        await db.workspace_contacts.delete(id)
    } else {
        await db.workspace_contacts.delete(id)
        await addToOfflineMutations('workspace_contacts', id, 'delete', { id }, existing.workspaceId)
    }
}

// ===================
// LOANS HOOKS
// ===================

function normalizeDueDate(value?: string | null): string | null {
    if (!value) {
        return null
    }

    const d = new Date(value)
    if (Number.isNaN(d.getTime())) {
        return null
    }
    return d.toISOString().slice(0, 10)
}

function roundLoanAmount(amount: number, _currency: CurrencyCode): number {
    return roundOrderValue(amount)
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
    const partner = await resolveLinkedBusinessPartner(input.linkedPartyType, input.linkedPartyId)
    if (!partner) {
        return
    }
    const direction = input.direction === 'borrowed' ? 'borrowed' : 'lent'
    const configuredLimit = direction === 'borrowed'
        ? partner.payableCreditLimit
        : partner.receivableCreditLimit
    const creditLimit = configuredLimit !== undefined
        ? configuredLimit
        : partner.creditLimit && partner.creditLimit > 0 ? partner.creditLimit : null
    if (creditLimit === null) {
        return
    }

    const activeLoans = await db.loans
        .where('workspaceId')
        .equals(workspaceId)
        .and((loan) =>
            !loan.isDeleted
            && loan.linkedPartyId === partner.id
            && (loan.direction === 'borrowed' ? 'borrowed' : 'lent') === direction
            && loan.status !== 'completed'
            && loan.balanceAmount > 0
        )
        .toArray()
    let currentUsage = 0
    for (const loan of activeLoans) {
        const converted = convertCurrencyAmountWithAvailableSnapshot(
            loan.balanceAmount,
            loan.settlementCurrency,
            partner.defaultCurrency,
            loan.exchangeRateSnapshot
        )
        if (converted === null) {
            throw new Error(`Missing exchange rate snapshot for ${loan.settlementCurrency.toUpperCase()} to ${partner.defaultCurrency.toUpperCase()} loan conversion`)
        }
        currentUsage += converted
    }
    const convertedPrincipal = convertCurrencyAmountWithAvailableSnapshot(
        input.principalAmount,
        input.settlementCurrency,
        partner.defaultCurrency,
        input.exchangeRateSnapshot
    )
    if (convertedPrincipal === null) {
        throw new Error(`Missing exchange rate snapshot for ${input.settlementCurrency.toUpperCase()} to ${partner.defaultCurrency.toUpperCase()} loan conversion`)
    }
    const nextExposure = roundLoanAmount(
        currentUsage + convertedPrincipal,
        partner.defaultCurrency
    )

    if (nextExposure > creditLimit) {
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

async function mirrorLoanToLinkedOrder(loan: Loan) {
    if (loan.source !== 'order' || !loan.orderId) return
    const { mirrorLinkedOrderPaymentState } = await import('./orders')
    await mirrorLinkedOrderPaymentState(loan)
}

function generateLoanNo(id: string, now = new Date(), loanCategory: LoanCategory = 'standard'): string {
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const prefix = loanCategory === 'simple' ? 'SL' : 'LN'
    return `${prefix}-${yyyy}${mm}${dd}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`
}

function addInstallmentDate(baseDate: string | null, frequency: InstallmentFrequency, index: number): string | null {
    if (!baseDate) {
        return null
    }

    const d = new Date(`${baseDate}T00:00:00.000Z`)
    if (frequency === 'daily') {
        d.setUTCDate(d.getUTCDate() + index)
    } else if (frequency === 'weekly') {
        d.setUTCDate(d.getUTCDate() + (index * 7))
    } else if (frequency === 'biweekly') {
        d.setUTCDate(d.getUTCDate() + (index * 14))
    } else {
        const targetMonth = d.getUTCMonth() + index
        const targetYear = d.getUTCFullYear() + Math.floor(targetMonth / 12)
        const normalizedMonth = ((targetMonth % 12) + 12) % 12
        const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate()
        d.setUTCFullYear(targetYear, normalizedMonth, Math.min(d.getUTCDate(), lastDay))
    }
    return d.toISOString().slice(0, 10)
}

function computeInstallmentStatus(dueDate: string | null, balanceAmount: number): InstallmentStatus {
    if (balanceAmount <= 0) return 'paid'
    const today = new Date().toISOString().slice(0, 10)
    return dueDate && dueDate < today ? 'overdue' : 'unpaid'
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

async function listLoanSettlementTransactionsByLoan(workspaceId: string, loanId: string) {
    const groups = await Promise.all(
        LOAN_SETTLEMENT_TRANSACTION_SOURCE_TYPES.map((sourceType) =>
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

    const reversedTransactionIds = new Set(
        settlementTransactions
            .filter((transaction) => !transaction.isDeleted && !!transaction.reversalOfTransactionId)
            .map((transaction) => transaction.reversalOfTransactionId as string)
    )

    return settlementTransactions.some((transaction) =>
        !transaction.isDeleted
        && !transaction.reversalOfTransactionId
        && !reversedTransactionIds.has(transaction.id)
    )
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

        installment.status = installment.dueDate && installment.dueDate < today ? 'overdue' : 'unpaid'
    }

    const totalPaidAmount = roundLoanAmount(
        updatedInstallments.length > 0
            ? updatedInstallments.reduce((sum, installment) => sum + installment.paidAmount, 0)
            : Math.min(
                loan.principalAmount,
                sortedPayments.reduce((sum, item) => sum + Math.max(0, Number(item.payment.amount || 0)), 0)
            ),
        loan.settlementCurrency
    )
    const balanceAmount = roundLoanAmount(
        updatedInstallments.length > 0
            ? updatedInstallments.reduce((sum, installment) => sum + installment.balanceAmount, 0)
            : Math.max(loan.principalAmount - totalPaidAmount, 0),
        loan.settlementCurrency
    )
    const nextDueDate = updatedInstallments.find((installment) => installment.balanceAmount > 0)?.dueDate || null
    const baseLoanNo = loan.loanNo.replace(/-\d+$/, '')
    const rebuiltLoanNo = payments.length > 0 ? `${baseLoanNo}-${payments.length}` : baseLoanNo

    const updatedLoan: Loan = {
        ...loan,
        loanNo: rebuiltLoanNo,
        totalPaidAmount,
        balanceAmount,
        nextDueDate,
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
    firstDueDate: string | null
): Array<{ installmentNo: number; dueDate: string | null; plannedAmount: number }> {
    const safeCount = Math.max(1, Math.trunc(installmentCount))
    const safePrincipal = roundLoanAmount(Math.max(0, principalAmount), settlementCurrency)
    const baseAmount = roundLoanAmount(safePrincipal / safeCount, settlementCurrency)
    const plan: Array<{ installmentNo: number; dueDate: string | null; plannedAmount: number }> = []
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
    orderId?: string | null
    orderType?: 'sales' | 'purchase' | null
    source: 'pos' | 'manual' | 'order'
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
    firstDueDate?: string | null
    createdAt?: string
    notes?: string
    createdBy?: string
    accountId?: string | null
    accountNameSnapshot?: string | null
}

export function isLoanDeletionAllowed(
    loan: Pick<Loan, 'source' | 'saleId' | 'orderId'>,
    hasLinkedActiveSource: boolean,
    hasTransactionHistory = false
): boolean {
    if (hasTransactionHistory) return false
    if (loan.source === 'manual') return true
    if (!loan.saleId && !loan.orderId) return true
    return !hasLinkedActiveSource
}

async function resolveLoanExchangeRateSnapshot(input: Pick<LoanCreateInput, 'saleId' | 'exchangeRateSnapshot'>) {
    if (Array.isArray(input.exchangeRateSnapshot) && input.exchangeRateSnapshot.length > 0) {
        return getEffectiveExchangeRatesSnapshot(input.exchangeRateSnapshot)
    }

    if (input.saleId) {
        const exchangeRows = await db.sales_exchange
            .where('saleId')
            .equals(input.saleId)
            .toArray()
        const saleSnapshot = getEffectiveExchangeRatesSnapshot(
            salesExchangeRowsToSnapshots(exchangeRows)
        )
        if (saleSnapshot && saleSnapshot.length > 0) {
            return saleSnapshot
        }
    }

    return getEffectiveExchangeRatesSnapshot(null)
}

/**
 * A manual loan is funded immediately, so its origination payment is part of
 * creating the loan rather than a background repair. In particular, an
 * account-linked loan must fail as a whole when the account cannot fund it.
 */
async function appendManualLoanOriginationTransaction(
    workspaceId: string,
    loan: Loan,
    selection: { accountId?: string | null; accountNameSnapshot?: string | null } = {}
) {
    if (loan.source !== 'manual') {
        return
    }

    const { appendLoanOriginationTransactionForLoan } = await import('./payments')
    return appendLoanOriginationTransactionForLoan(workspaceId, loan, selection)
}

async function createLoanAggregate(workspaceId: string, input: LoanCreateInput): Promise<{ loan: Loan; installments: LoanInstallment[] }> {
    const now = new Date().toISOString()
    const requestedCreatedAt = input.createdAt ? new Date(input.createdAt) : null
    if (requestedCreatedAt && Number.isNaN(requestedCreatedAt.getTime())) {
        throw new Error('Invalid creation time')
    }
    const createdAt = requestedCreatedAt?.toISOString() || now
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
    if (loanCategory === 'standard' && input.source !== 'order' && (!borrowerPhone || !borrowerAddress)) {
        throw new Error('Missing borrower information')
    }

    const exchangeRateSnapshot = await resolveLoanExchangeRateSnapshot(input)

    const linkedBusinessPartner = await resolveLinkedBusinessPartner(linkedPartyType, linkedPartyId)
    if (linkedPartyType && linkedPartyId && !linkedBusinessPartner) {
        throw new Error('Business partner not found')
    }
    if (linkedBusinessPartner) {
        linkedPartyId = linkedBusinessPartner.id
        linkedPartyName = linkedPartyName || linkedBusinessPartner.partnerName
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
            createdAt,
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
        orderId: input.orderId ?? null,
        orderType: input.orderType ?? null,
        loanNo: generateLoanNo(loanId, new Date(createdAt), loanCategory),
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
        installmentCount: plan.length,
        installmentFrequency: input.installmentFrequency,
        firstDueDate,
        nextDueDate,
        status: computeLoanStatus(nextDueDate, principalAmount),
        notes: input.notes?.trim(),
        createdBy: input.createdBy,
        createdAt,
        updatedAt: now,
        syncStatus: 'pending',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false
    }

    let originationTransaction: PaymentTransaction | null = null
    try {
        // Post first: payment_transactions is the financial source of truth and
        // performs the local/cloud no-negative availability check. It has no
        // foreign key to the source record, so this is safe and avoids creating
        // an unfunded loan when the account rejects the outgoing payment.
        if (loan.source === 'manual') {
            originationTransaction = (await appendManualLoanOriginationTransaction(workspaceId, loan, input)) ?? null
        }

        await db.transaction('rw', [db.loans, db.loan_installments], async () => {
            await db.loans.put(loan)
            for (const installment of installments) {
                await db.loan_installments.put(installment)
            }
        })
    } catch (error) {
        if (originationTransaction) {
            try {
                const { softDeletePaymentTransaction } = await import('./payments')
                await softDeletePaymentTransaction(originationTransaction)
            } catch (cleanupError) {
                console.error('[Loans] Failed to roll back the origination payment after loan creation failed:', cleanupError)
            }
        }
        throw error
    }

    if (!isOnline()) {
        await enqueueLoanCreateMutations(workspaceId, loan, installments)
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

        if (installmentPayload.length > 0) {
            const { error: installmentError } = await runMutation('loan_installments.create', () => supabase.from('loan_installments').upsert(installmentPayload))
            if (installmentError) throw installmentError
        }

        const syncedAt = new Date().toISOString()
        await db.transaction('rw', [db.loans, db.loan_installments], async () => {
            await db.loans.update(loan.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            for (const installment of installments) {
                await db.loan_installments.update(installment.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
            }
        })

        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)

        return {
            loan: { ...loan, syncStatus: 'synced', lastSyncedAt: syncedAt },
            installments: installments.map(item => ({ ...item, syncStatus: 'synced', lastSyncedAt: syncedAt }))
        }
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Online create failed, queued offline mutation:', error)
            await enqueueLoanCreateMutations(workspaceId, loan, installments)
            await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)
            return { loan, installments }
        }

        await db.transaction('rw', [db.loans, db.loan_installments], async () => {
            await db.loans.delete(loan.id)
            for (const installment of installments) {
                await db.loan_installments.delete(installment.id)
            }
        })

        if (originationTransaction) {
            try {
                const { softDeletePaymentTransaction } = await import('./payments')
                await softDeletePaymentTransaction(originationTransaction)
            } catch (cleanupError) {
                console.error('[Loans] Failed to roll back the origination payment after cloud loan creation failed:', cleanupError)
            }
        }

        await recalculateLoanLinkedBusinessPartnerSummary(workspaceId, loan.linkedPartyType, loan.linkedPartyId)

        throw normalizeSupabaseActionError(error)
    }
}

function isLoanVisibleInLocalCache(
    loan: Loan,
    loansViewOwnScope: ViewOwnRecordScope,
    installmentsViewOwnScope: ViewOwnRecordScope,
) {
    const scope = loan.loanCategory === 'simple'
        ? loansViewOwnScope
        : installmentsViewOwnScope

    return !scope.isRestricted || loan.createdBy === scope.userId
}

export function useLoans(workspaceId: string | undefined) {
    const online = useNetworkStatus()
    const loansViewOwnScope = useViewOwnRecordScope('loans.view_own')
    const installmentsViewOwnScope = useViewOwnRecordScope('installments.view_own')

    const loans = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.loans
                .where('workspaceId')
                .equals(workspaceId)
                .and((loan) => !loan.isDeleted && isLoanVisibleInLocalCache(
                    loan,
                    loansViewOwnScope,
                    installmentsViewOwnScope,
                ))
                .reverse()
                .sortBy('createdAt')
            const visibility = await Promise.all(rows.map((loan) => loan.linkedPartyType === 'business_partner'
                ? canAccessBusinessPartnerInLocalCache(workspaceId, loan.linkedPartyId, 'customer')
                : true
            ))
            return rows.filter((_, index) => visibility[index])
        },
        [
            workspaceId,
            loansViewOwnScope.isRestricted,
            loansViewOwnScope.userId,
            installmentsViewOwnScope.isRestricted,
            installmentsViewOwnScope.userId,
        ]
    )

    useEffect(() => {
            if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('loans', db.loans, workspaceId)
        }
    }, [
        online,
        workspaceId,
        loansViewOwnScope.isRestricted,
        loansViewOwnScope.userId,
        installmentsViewOwnScope.isRestricted,
        installmentsViewOwnScope.userId,
    ])

    return loans ?? []
}

export function useLoan(loanId: string | undefined) {
    const loansViewOwnScope = useViewOwnRecordScope('loans.view_own')
    const installmentsViewOwnScope = useViewOwnRecordScope('installments.view_own')

    return useLiveQuery(async () => {
        if (!loanId) return undefined
        const loan = await db.loans.get(loanId)
        if (!loan || !isLoanVisibleInLocalCache(loan, loansViewOwnScope, installmentsViewOwnScope)) {
            return undefined
        }
        if (loan.linkedPartyType === 'business_partner'
            && !await canAccessBusinessPartnerInLocalCache(loan.workspaceId, loan.linkedPartyId, 'customer')) {
            return undefined
        }
        return loan
    }, [
        loanId,
        loansViewOwnScope.isRestricted,
        loansViewOwnScope.userId,
        installmentsViewOwnScope.isRestricted,
        installmentsViewOwnScope.userId,
    ])
}

export function useLoanBySaleId(saleId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()
    const loansViewOwnScope = useViewOwnRecordScope('loans.view_own')
    const installmentsViewOwnScope = useViewOwnRecordScope('installments.view_own')

    const loan = useLiveQuery(
        async () => {
            if (!saleId) return undefined
            const rows = await db.loans
                .where('saleId')
                .equals(saleId)
                .and((loan) => !loan.isDeleted && isLoanVisibleInLocalCache(
                    loan,
                    loansViewOwnScope,
                    installmentsViewOwnScope,
                ))
                .toArray()
            if (rows.length === 0) return undefined
            return rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
        },
        [
            saleId,
            loansViewOwnScope.isRestricted,
            loansViewOwnScope.userId,
            installmentsViewOwnScope.isRestricted,
            installmentsViewOwnScope.userId,
        ]
    )

    useEffect(() => {
            if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('loans', db.loans, workspaceId)
        }
    }, [
        online,
        workspaceId,
        loansViewOwnScope.isRestricted,
        loansViewOwnScope.userId,
        installmentsViewOwnScope.isRestricted,
        installmentsViewOwnScope.userId,
    ])

    return loan
}

export function useLoanInstallments(loanId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()
    const loansViewOwnScope = useViewOwnRecordScope('loans.view_own')
    const installmentsViewOwnScope = useViewOwnRecordScope('installments.view_own')

    const installments = useLiveQuery(
        async () => {
            if (!loanId) return []
            const loan = await db.loans.get(loanId)
            if (!loan || !isLoanVisibleInLocalCache(loan, loansViewOwnScope, installmentsViewOwnScope)) {
                return []
            }
            return db.loan_installments
                .where('loanId')
                .equals(loanId)
                .and((item) => !item.isDeleted)
                .sortBy('installmentNo')
        },
        [
            loanId,
            loansViewOwnScope.isRestricted,
            loansViewOwnScope.userId,
            installmentsViewOwnScope.isRestricted,
            installmentsViewOwnScope.userId,
        ]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('loan_installments', db.loan_installments, workspaceId)
        }
    }, [
        online,
        workspaceId,
        loansViewOwnScope.isRestricted,
        loansViewOwnScope.userId,
        installmentsViewOwnScope.isRestricted,
        installmentsViewOwnScope.userId,
    ])

    return installments ?? []
}

export function useLoanPayments(loanId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()
    const loansViewOwnScope = useViewOwnRecordScope('loans.view_own')
    const installmentsViewOwnScope = useViewOwnRecordScope('installments.view_own')

    const payments = useLiveQuery(
        async () => {
            if (!loanId) return []
            const loan = await db.loans.get(loanId)
            if (!loan || !isLoanVisibleInLocalCache(loan, loansViewOwnScope, installmentsViewOwnScope)) {
                return []
            }
            const rows = await db.loan_payments.where('loanId').equals(loanId).and(item => !item.isDeleted).toArray()
            return rows.sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
        },
        [
            loanId,
            loansViewOwnScope.isRestricted,
            loansViewOwnScope.userId,
            installmentsViewOwnScope.isRestricted,
            installmentsViewOwnScope.userId,
        ]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase('loan_payments', db.loan_payments, workspaceId)
        }
    }, [
        online,
        workspaceId,
        loansViewOwnScope.isRestricted,
        loansViewOwnScope.userId,
        installmentsViewOwnScope.isRestricted,
        installmentsViewOwnScope.userId,
    ])

    return payments ?? []
}

/**
 * Repayment transactions, including their reversal entries, for one loan.
 * Detail views use these rows to offer reversals without treating a loan
 * balance as the financial source of truth.
 */
export function useLoanSettlementTransactions(loanId: string | undefined, workspaceId?: string) {
    const online = useNetworkStatus()
    const loansViewOwnScope = useViewOwnRecordScope('loans.view_own')
    const installmentsViewOwnScope = useViewOwnRecordScope('installments.view_own')

    const transactions = useLiveQuery(
        async () => {
            if (!loanId || !workspaceId) return []
            const loan = await db.loans.get(loanId)
            if (!loan || !isLoanVisibleInLocalCache(loan, loansViewOwnScope, installmentsViewOwnScope)) {
                return []
            }

            const rows = await listLoanSettlementTransactionsByLoan(workspaceId, loanId)
            return rows
                .filter((item) => !item.isDeleted)
                .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))
        },
        [
            loanId,
            workspaceId,
            loansViewOwnScope.isRestricted,
            loansViewOwnScope.userId,
            installmentsViewOwnScope.isRestricted,
            installmentsViewOwnScope.userId,
        ]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            void fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, { includeDeleted: true })
        }
    }, [online, workspaceId])

    return transactions ?? []
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
    const installmentCount = Math.max(1, Math.trunc(Number(input.installmentCount) || 1))
    return createLoanAggregate(workspaceId, {
        ...input,
        installmentCount,
        loanCategory: installmentCount > 1 ? 'standard' : 'simple',
        source: 'pos'
    })
}

export async function markPosLoanCancelledForFullSaleReturn(input: {
    workspaceId: string
    saleId: string
    returnId: string
    reason: string
    createdBy?: string | null
    pendingRemoteSync?: boolean
}): Promise<void> {
    const loan = await db.loans.where('saleId').equals(input.saleId).and((item) => !item.isDeleted).first()
    if (!loan || loan.source !== 'pos' || loan.status === 'cancelled') {
        return
    }

    const now = new Date().toISOString()
    const [installments, payments] = await Promise.all([
        db.loan_installments.where('loanId').equals(loan.id).and((item) => !item.isDeleted).toArray(),
        db.loan_payments.where('loanId').equals(loan.id).and((item) => !item.isDeleted).toArray()
    ])
    const syncStatus = input.pendingRemoteSync ? 'pending' as const : 'synced' as const
    const lastSyncedAt = input.pendingRemoteSync ? null : now
    const cancelledLoan: Loan = {
        ...loan,
        totalPaidAmount: 0,
        balanceAmount: 0,
        nextDueDate: null,
        status: 'cancelled',
        notes: [loan.notes?.trim(), `Cancelled: linked sale was fully returned (${input.reason || 'Return'}).`]
            .filter(Boolean)
            .join('\n'),
        updatedAt: now,
        version: loan.version + 1,
        syncStatus,
        lastSyncedAt
    }
    const cancelledInstallments: LoanInstallment[] = installments.map((installment) => ({
        ...installment,
        paidAmount: 0,
        balanceAmount: 0,
        status: 'cancelled',
        paidAt: null,
        updatedAt: now,
        version: installment.version + 1,
        syncStatus,
        lastSyncedAt
    }))

    await db.transaction('rw', [db.loans, db.loan_installments], async () => {
        await db.loans.put(cancelledLoan)
        if (cancelledInstallments.length > 0) {
            await db.loan_installments.bulkPut(cancelledInstallments)
        }
    })

    // Cloud workspaces receive the authoritative refund rows from the database
    // trigger that runs with process_sale_return. Local workspaces need to write
    // those audit rows themselves because they never call Supabase.
    if (isLocalWorkspaceMode(input.workspaceId)) {
        const { appendPaymentTransaction } = await import('./payments')
        const transactions = await db.payment_transactions.where('workspaceId').equals(input.workspaceId).toArray()

        for (const payment of payments) {
            if (payment.amount <= 0) {
                continue
            }

            const sourceTransaction = transactions
                .filter((transaction) => !transaction.isDeleted && !transaction.reversalOfTransactionId)
                .find((transaction) => transaction.metadata?.loanPaymentId === payment.id)

            if (sourceTransaction) {
                const hasReturnReversal = transactions.some((transaction) =>
                    !transaction.isDeleted
                    && transaction.reversalOfTransactionId === sourceTransaction.id
                    && transaction.metadata?.saleReturnId === input.returnId
                )
                if (hasReturnReversal) {
                    continue
                }

                await appendPaymentTransaction(input.workspaceId, {
                    sourceModule: sourceTransaction.sourceModule,
                    sourceType: sourceTransaction.sourceType,
                    sourceRecordId: sourceTransaction.sourceRecordId,
                    sourceSubrecordId: sourceTransaction.sourceSubrecordId ?? null,
                    direction: sourceTransaction.direction,
                    amount: -Math.abs(payment.amount),
                    currency: sourceTransaction.currency,
                    paymentMethod: sourceTransaction.paymentMethod,
                    paidAt: now,
                    counterpartyName: sourceTransaction.counterpartyName || null,
                    referenceLabel: sourceTransaction.referenceLabel || loan.loanNo,
                    note: `Full sale return ${input.returnId}: ${input.reason || 'Return'}`,
                    createdBy: input.createdBy || null,
                    reversalOfTransactionId: sourceTransaction.id,
                    metadata: {
                        ...(sourceTransaction.metadata || {}),
                        saleId: input.saleId,
                        saleReturnId: input.returnId,
                        fullSaleReturn: true,
                        returnReason: input.reason || 'Return'
                    }
                })
                continue
            }

            await appendPaymentTransaction(input.workspaceId, {
                sourceModule: 'loans',
                sourceType: loan.loanCategory === 'simple'
                    ? 'simple_loan'
                    : loan.installmentCount > 1 ? 'loan_installment' : 'loan_payment',
                sourceRecordId: loan.id,
                sourceSubrecordId: payment.id,
                direction: loan.direction === 'borrowed' ? 'outgoing' : 'incoming',
                amount: -Math.abs(payment.amount),
                currency: loan.settlementCurrency,
                paymentMethod: payment.paymentMethod,
                paidAt: now,
                counterpartyName: loan.borrowerName,
                referenceLabel: loan.loanNo,
                note: `Full sale return ${input.returnId}: ${input.reason || 'Return'}`,
                createdBy: input.createdBy || null,
                metadata: {
                    saleId: input.saleId,
                    saleReturnId: input.returnId,
                    loanPaymentId: payment.id,
                    fullSaleReturn: true,
                    returnReason: input.reason || 'Return',
                    refundWithoutOriginalTransaction: true
                }
            })
        }
    }

    await recalculateLoanLinkedBusinessPartnerSummary(input.workspaceId, loan.linkedPartyType, loan.linkedPartyId)
}

export async function createLoanFromOrder(
    workspaceId: string,
    input: Omit<LoanCreateInput, 'source' | 'saleId'> & {
        orderId: string
        orderType: 'sales' | 'purchase'
    }
): Promise<{ loan: Loan; installments: LoanInstallment[] }> {
    return createLoanAggregate(workspaceId, {
        ...input,
        saleId: null,
        source: 'order'
    })
}

export async function cancelOrderLinkedLoan(loanId: string): Promise<void> {
    const loan = await db.loans.get(loanId)
    if (!loan || loan.isDeleted) return
    if (loan.source !== 'order') throw new Error('Loan is not order-linked')
    if (await hasLoanTransactionHistory(loan.workspaceId, loan.id)) {
        throw new Error('financed_order_has_payment_history')
    }

    const now = new Date().toISOString()
    const installments = await db.loan_installments.where('loanId').equals(loan.id).and((item) => !item.isDeleted).toArray()
    const deletedLoan: Loan = {
        ...loan,
        isDeleted: true,
        updatedAt: now,
        version: loan.version + 1,
        syncStatus: 'pending',
        lastSyncedAt: null
    }
    const deletedInstallments = installments.map((item) => ({
        ...item,
        isDeleted: true,
        updatedAt: now,
        version: item.version + 1,
        syncStatus: 'pending' as const,
        lastSyncedAt: null
    }))
    await db.transaction('rw', [db.loans, db.loan_installments], async () => {
        await db.loans.put(deletedLoan)
        if (deletedInstallments.length > 0) await db.loan_installments.bulkPut(deletedInstallments)
    })

    const enqueue = async () => {
        await addToOfflineMutations('loans', loan.id, 'delete', { id: loan.id }, loan.workspaceId)
        await Promise.all(deletedInstallments.map((item) =>
            addToOfflineMutations('loan_installments', item.id, 'delete', { id: item.id }, loan.workspaceId)
        ))
    }

    if (!isOnline(loan.workspaceId)) {
        await enqueue()
    } else {
        try {
            const { error: loanError } = await runMutation('loans.cancelOrderLinked.loan', () =>
                supabase.from('loans').update({ is_deleted: true, updated_at: now, version: deletedLoan.version }).eq('id', loan.id)
            )
            if (loanError) throw loanError
            if (deletedInstallments.length > 0) {
                const { error: installmentError } = await runMutation('loans.cancelOrderLinked.installments', () =>
                    supabase.from('loan_installments').update({ is_deleted: true, updated_at: now }).eq('loan_id', loan.id)
                )
                if (installmentError) throw installmentError
            }
            const syncedAt = new Date().toISOString()
            await db.loans.update(loan.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
        } catch (error) {
            if (!shouldUseOfflineMutationFallback(error)) throw normalizeSupabaseActionError(error)
            await enqueue()
        }
    }

    await recalculateLoanLinkedBusinessPartnerSummary(loan.workspaceId, loan.linkedPartyType, loan.linkedPartyId)
}

export async function linkLoanToBusinessPartner(
    loanId: string,
    partnerId: string,
    partnerName: string
): Promise<Loan> {
    const existing = await db.loans.get(loanId)
    if (!existing || existing.isDeleted) {
        throw new Error('Loan not found')
    }

    const now = new Date().toISOString()
    const updatedLoan: Loan = {
        ...existing,
        linkedPartyType: 'business_partner',
        linkedPartyId: partnerId,
        linkedPartyName: partnerName,
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
        await recalculateLoanLinkedBusinessPartnerSummary(existing.workspaceId, 'business_partner', partnerId)
        return updatedLoan
    }

    try {
        const { error } = await runMutation('loans.linkPartner.update', () =>
            supabase
                .from('loans')
                .update(toSnakeCase({
                    linkedPartyType: updatedLoan.linkedPartyType,
                    linkedPartyId: updatedLoan.linkedPartyId,
                    linkedPartyName: updatedLoan.linkedPartyName,
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

        await recalculateLoanLinkedBusinessPartnerSummary(existing.workspaceId, 'business_partner', partnerId)

        return {
            ...updatedLoan,
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        }
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Loans] Link partner sync failed, queued offline mutation:', error)
            await enqueueMutation()
            await recalculateLoanLinkedBusinessPartnerSummary(existing.workspaceId, 'business_partner', partnerId)
            return updatedLoan
        }

        await db.loans.put(existing)
        throw normalizeSupabaseActionError(error)
    }
}

export async function updateLoanNote(loanId: string, note: string): Promise<Loan> {
    const existing = await db.loans.get(loanId)
    if (!existing || existing.isDeleted) {
        throw new Error('Loan not found')
    }

    const now = new Date().toISOString()
    const notes = note.trim()
    const updatedLoan: Loan = {
        ...existing,
        notes,
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

    if (!isOnline(existing.workspaceId)) {
        await enqueueMutation()
        return updatedLoan
    }

    try {
        const { error } = await runMutation('loans.note.update', () =>
            supabase
                .from('loans')
                .update(toSnakeCase({
                    notes,
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
            console.error('[Loans] Note sync failed, queued offline mutation:', error)
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
    const linkedOrder = loan.orderId
        ? loan.orderType === 'purchase'
            ? await db.purchase_orders.get(loan.orderId)
            : await db.sales_orders.get(loan.orderId)
        : undefined
    const hasLinkedActiveSource = Boolean(
        (linkedSale && !linkedSale.isDeleted)
        || (linkedOrder && !linkedOrder.isDeleted && linkedOrder.status !== 'cancelled')
    )
    const hasTransactionHistory = await hasLoanTransactionHistory(loan.workspaceId, loanId)
    if (!isLoanDeletionAllowed(loan, hasLinkedActiveSource, hasTransactionHistory)) {
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
    await mirrorLoanToLinkedOrder(updatedLoan)

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
                    status: updatedLoan.status,
                    updatedAt: updatedLoan.updatedAt,
                    version: updatedLoan.version
                }))
                .eq('id', updatedLoan.id)
        )
        if (loanError) throw loanError

        if (updatedInstallments.length > 0) {
            const { error: installmentsError } = await runMutation('loans.reversePayment.installments', () =>
                supabase.from('loan_installments').upsert(
                    updatedInstallments.map((installment) =>
                        toSupabaseLoanPayload(installment as unknown as Record<string, unknown>)
                    )
                )
            )
            if (installmentsError) throw installmentsError
        }

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

        await mirrorLoanToLinkedOrder(loan)

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
    accountId?: string | null
    accountNameSnapshot?: string | null
    isOrderLoanInitialRepayment?: boolean
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
        if (installment.dueDate && installment.dueDate < today && installment.status !== 'partial') {
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

    const appendLedger = async () => {
        const { appendPaymentTransaction } = await import('./payments')
        return appendPaymentTransaction(workspaceId, {
            sourceModule: 'loans',
            sourceType: (loan.loanCategory || 'standard') === 'simple'
                ? 'simple_loan'
                : (loan.installmentCount > 1 || input.installmentId ? 'loan_installment' : 'loan_payment'),
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
            accountId: input.accountId ?? null,
            accountNameSnapshot: input.accountNameSnapshot ?? null,
            metadata: {
                loanPaymentId: payment.id,
                loanCategory: loan.loanCategory || 'standard',
                loanDirection: loan.direction || 'lent',
                ...(loan.source === 'order' && loan.orderId && loan.orderType ? {
                    displaySourceLabel: 'order_loan',
                    orderId: loan.orderId,
                    orderType: loan.orderType
                } : {}),
                ...(input.isOrderLoanInitialRepayment ? { isOrderLoanInitialRepayment: true } : {}),
                touchedInstallmentIds: Array.from(touchedInstallmentIds)
            }
        })
    }

    let paymentTransaction: PaymentTransaction | null = null
    try {
        // For an account-linked repayment, verify and post the authoritative
        // payment before changing the loan balance. A rejected outgoing payment
        // must not make a borrowed loan appear paid.
        paymentTransaction = await appendLedger()
        await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
            await db.loans.put(updatedLoan)
            for (const installment of updatedInstallments) {
                await db.loan_installments.put(installment)
            }
            await db.loan_payments.put(payment)
        })
    } catch (error) {
        if (paymentTransaction) {
            try {
                const { softDeletePaymentTransaction } = await import('./payments')
                await softDeletePaymentTransaction(paymentTransaction)
            } catch (cleanupError) {
                console.error('[Loans] Failed to roll back the payment after loan payment creation failed:', cleanupError)
            }
        }
        throw error
    }
    await mirrorLoanToLinkedOrder(updatedLoan)

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
                    status: updatedLoan.status,
                    updatedAt: updatedLoan.updatedAt,
                    version: updatedLoan.version
                }))
                .eq('id', updatedLoan.id)
        )
        if (loanError) throw loanError

        if (updatedInstallments.length > 0) {
            const { error: installmentsError } = await runMutation('loans.recordPayment.installments', () =>
                supabase.from('loan_installments').upsert(
                    updatedInstallments.map(installment =>
                        toSupabaseLoanPayload(installment as unknown as Record<string, unknown>)
                    )
                )
            )
            if (installmentsError) throw installmentsError
        }

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

        if (paymentTransaction) {
            try {
                const { softDeletePaymentTransaction } = await import('./payments')
                await softDeletePaymentTransaction(paymentTransaction)
            } catch (cleanupError) {
                console.error('[Loans] Failed to roll back the payment after cloud loan payment creation failed:', cleanupError)
            }
        }

        await mirrorLoanToLinkedOrder(loan)

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
        storage_id: item.storageId || order.sourceStorageId || null,
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
        returned_quantity: Math.min(
            Math.max(0, Number(item.quantity || 0)),
            Math.max(0, Number(item.returnedQuantity || item.returned_quantity || 0))
        ),
        is_returned: Math.max(0, Number(item.returnedQuantity || item.returned_quantity || 0)) >= Math.max(0, Number(item.quantity || 0))
            && Math.max(0, Number(item.quantity || 0)) > 0,
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
        original_total_amount: order.originalTotalAmount ?? order.original_total_amount,
        returned_amount: order.returnedAmount ?? order.returned_amount,
        return_status: order.returnStatus ?? order.return_status ?? 'none',
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
        is_returned: (order.returnStatus ?? order.return_status) === 'full',
        has_partial_return: (order.returnStatus ?? order.return_status) === 'partial',
        sequenceId: order.orderNumber || order.order_number,
        notes: order.notes,
        _isOrder: true,
        _orderNumber: order.orderNumber || order.order_number,
        _sourceChannel: order.sourceChannel || order.source_channel || null
    }
}

export function toUISaleFromExchangeTransaction(tx: any): any {
    const items: any[] = [{
        id: generateId(),
        sale_id: tx.id,
        product_id: 'exchange_profit',
        product_name: `${tx.fromCurrency} → ${tx.toCurrency}`,
        product_sku: 'FX-PROFIT',
        quantity: 1,
        unit_price: tx.profitAmount || 0,
        total_price: tx.profitAmount || 0,
        cost_price: 0,
        converted_cost_price: 0,
        original_currency: tx.profitCurrency || tx.fromCurrency,
        original_unit_price: tx.profitAmount || 0,
        converted_unit_price: tx.profitAmount || 0,
        settlement_currency: tx.profitCurrency || tx.fromCurrency,
        returned_quantity: 0,
        is_returned: false,
        product: {
            name: `${tx.fromCurrency} → ${tx.toCurrency}`,
            sku: 'FX-TRADE',
            can_be_returned: false
        }
    }]

    return {
        id: tx.id,
        workspace_id: tx.workspaceId,
        cashier_id: tx.employeeUserId || '',
        total_amount: Number(tx.profitAmount || 0),
        settlement_currency: tx.profitCurrency || tx.fromCurrency || 'usd',
        exchange_source: tx.exchangeRateSource || null,
        exchange_rate: tx.exchangeRateUsed || null,
        exchange_rate_timestamp: null,
        exchange_rates: null,
        created_at: tx.transactionDate || tx.createdAt,
        updated_at: tx.updatedAt,
        origin: 'exchange',
        payment_method: tx.paymentMethod || 'cash',
        cashier_name: tx.employeeName || 'Exchange',
        items,
        is_returned: false,
        sequenceId: tx.transactionNo,
        notes: tx.notes || `${tx.customerGivesAmount} ${tx.fromCurrency} @ ${tx.exchangeRateUsed}`,
        _isExchange: true,
        _transactionNo: tx.transactionNo,
        _fromCurrency: tx.fromCurrency,
        _toCurrency: tx.toCurrency,
        _customerGivesAmount: tx.customerGivesAmount,
        _customerReceivesAmount: tx.customerReceivesAmount,
        _exchangeRateUsed: tx.exchangeRateUsed
    }
}

export function toUISaleFromRealEstateCommissionTransaction(transaction: PaymentTransaction): any {
    const amount = Number(transaction.amount || 0)
    const realEstateTransactionId = typeof transaction.metadata?.realEstateTransactionId === 'string'
        ? transaction.metadata.realEstateTransactionId
        : transaction.sourceRecordId
    const propertyLocation = typeof transaction.metadata?.propertyLocation === 'string'
        ? transaction.metadata.propertyLocation
        : transaction.referenceLabel || 'Real Estate Commission'
    const category = 'Real Estate Commission'
    const items: any[] = [{
        id: generateId(),
        sale_id: transaction.id,
        product_id: 'real_estate_commission',
        product_name: propertyLocation,
        product_sku: 'RE-COMMISSION',
        product_category: category,
        quantity: 1,
        unit_price: amount,
        total_price: amount,
        cost_price: 0,
        converted_cost_price: 0,
        original_currency: transaction.currency,
        original_unit_price: amount,
        converted_unit_price: amount,
        settlement_currency: transaction.currency,
        returned_quantity: 0,
        is_returned: false,
        product: {
            name: propertyLocation,
            sku: 'RE-COMMISSION',
            category,
            can_be_returned: false
        }
    }]

    return {
        id: transaction.id,
        workspace_id: transaction.workspaceId,
        cashier_id: transaction.createdBy || '',
        total_amount: amount,
        settlement_currency: transaction.currency,
        exchange_source: null,
        exchange_rate: null,
        exchange_rate_timestamp: null,
        exchange_rates: null,
        created_at: transaction.paidAt,
        updated_at: transaction.updatedAt,
        origin: 'real_estate',
        payment_method: transaction.paymentMethod || 'cash',
        cashier_name: 'Real Estate',
        items,
        is_returned: false,
        sequenceId: transaction.referenceLabel || realEstateTransactionId,
        notes: transaction.note || null,
        partyName: transaction.counterpartyName || null,
        _isRealEstateCommission: true,
        _realEstateTransactionId: realEstateTransactionId,
        _counterpartyName: transaction.counterpartyName || null,
        _realEstateReference: transaction.referenceLabel || null,
        _realEstatePaymentId: transaction.id
    }
}
