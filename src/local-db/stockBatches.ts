import { useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import {
    QUANTITY_EPSILON,
    isNonNegativeQuantity,
    isPositiveQuantity,
    quantitiesEqual,
    roundQuantity
} from '@/lib/quantity'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'
import { getInventoryQuantityForProductStorage, useInventoryProducts, type InventoryProduct } from './inventory'
import { addToOfflineMutations } from './offlineMutations'
import {
    assertCurrentUserCanAccessStorage,
    assertRecentCurrentUserCanAccessStorage,
    canAccessStorage,
    useStorageAccess
} from './storagePermissions'
import type {
    CurrencyCode,
    InventoryTransferBatchAllocation,
    StockBatch,
    StockBatchAllocation
} from './models'

const TABLE_NAME = 'stock_batches'
const STOCK_BATCH_FETCH_PAGE_SIZE = 1000
const stockBatchFetchesInFlight = new Map<string, Promise<boolean>>()

export interface StockBatchFetchOptions {
    storageId?: string
}

export interface UseStockBatchesOptions extends StockBatchFetchOptions {
    syncRemote?: boolean
    enabled?: boolean
}

export interface StockBatchInput {
    productId: string
    storageId: string
    batchNumber: string
    quantity: number
    price?: number
    costPrice?: number
    currency?: CurrencyCode
    expiryDate?: string | null
    manufacturingDate?: string | null
    notes?: string | null
    sourcePurchaseOrderId?: string | null
    sourcePurchaseOrderItemId?: string | null
}

export interface StockBatchCoverage {
    inventoryQuantity: number
    batchQuantity: number
    isBalanced: boolean
}

export interface StockBatchSalePlan {
    productId: string
    storageId: string
    requestedQuantity: number
    inventoryQuantity: number
    batchQuantity: number
    sellableQuantity: number
    allocations: StockBatchAllocation[]
}

export interface StockBatchSaleRequest {
    productId: string
    storageId: string
    quantity: number
    /**
     * `undefined` keeps the legacy automatic FEFO allocation. An empty array
     * explicitly uses regular (non-batch) stock; otherwise only these batches
     * are used for the line.
     */
    selectedBatchAllocations?: StockBatchTransferSelection[]
}

export interface StockBatchTransferSelection {
    batchId: string
    quantity: number
}

export interface StockBatchTransferPlan {
    requestedQuantity: number
    batchAllocations: StockBatchAllocation[]
    unbatchedQuantity: number
}

export type BatchAwareInventoryProduct = InventoryProduct & {
    hasBatches: boolean
    batchCount: number
    nextBatchNumber: string | null
    nextBatchExpiryDate: string | null
    nextBatchQuantity: number | null
    nextBatchPrice?: number | null
    nextBatchCostPrice?: number | null
    nextBatchCurrency?: CurrencyCode | null
}

const SUPPORTED_CURRENCIES = new Set<CurrencyCode>(['usd', 'eur', 'iqd', 'try'])

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(
    workspaceId: string,
    timestamp: string,
    syncSource: 'local' | 'remote' = 'local'
) {
    if (syncSource === 'remote' || !shouldUseCloudBusinessData(workspaceId)) {
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

function sanitizeBatchPayload(batch: Record<string, unknown>) {
    return toSnakeCase({
        ...batch,
        syncStatus: undefined,
        lastSyncedAt: undefined
    })
}

function normalizeOptionalString(value?: string | null) {
    const normalized = value?.trim()
    return normalized ? normalized : null
}

function normalizeDateString(value?: string | null) {
    const normalized = normalizeOptionalString(value)
    if (!normalized) {
        return null
    }

    const parsed = new Date(`${normalized}T00:00:00`)
    if (Number.isNaN(parsed.getTime())) {
        throw new Error('Invalid batch date')
    }

    return normalized
}

function normalizeCurrencyCode(
    value: unknown,
    fallback: CurrencyCode = 'usd'
): CurrencyCode {
    if (typeof value !== 'string') {
        return fallback
    }

    const normalized = value.trim().toLowerCase()
    return SUPPORTED_CURRENCIES.has(normalized as CurrencyCode)
        ? (normalized as CurrencyCode)
        : fallback
}

function normalizeMoneyValue(value: unknown, fieldLabel: string) {
    const amount = Number(value)
    if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`${fieldLabel} must be zero or greater`)
    }

    return amount
}

export function calculateStockBatchUnitCost(
    allocations: StockBatchAllocation[],
    fallbackCost: number,
    targetCurrency: CurrencyCode,
    convertCurrency: (
        amount: number,
        from: CurrencyCode,
        to: CurrencyCode
    ) => number = (amount) => amount,
    requestedQuantity?: number
) {
    const normalizedFallback = normalizeMoneyValue(fallbackCost, 'Fallback cost')
    const validAllocations = allocations.filter((allocation) =>
        isPositiveQuantity(allocation.quantity)
    )
    const allocatedQuantity = validAllocations.reduce((sum, allocation) => sum + allocation.quantity, 0)
    const totalQuantity = requestedQuantity == null
        ? allocatedQuantity
        : Math.max(Number(requestedQuantity), allocatedQuantity)
    if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) {
        return normalizedFallback
    }
    const totalCost = validAllocations.reduce((sum, allocation) => {
        const hasBatchCost = allocation.costPrice != null
        const unitCost = hasBatchCost
            ? normalizeMoneyValue(allocation.costPrice, 'Batch allocation cost')
            : normalizedFallback
        const sourceCurrency = hasBatchCost
            ? normalizeCurrencyCode(allocation.currency, targetCurrency)
            : targetCurrency

        return sum + (convertCurrency(unitCost, sourceCurrency, targetCurrency) * allocation.quantity)
    }, normalizedFallback * (totalQuantity - allocatedQuantity))

    return totalCost / totalQuantity
}

export function shouldCreatePurchaseCostBatch(
    purchaseUnitCost: number,
    productUnitCost: number,
    currency: CurrencyCode
) {
    const precision = currency === 'iqd' ? 1 : 100
    const normalize = (value: number) =>
        Math.round(normalizeMoneyValue(value, 'Purchase cost') * precision) / precision
    return normalize(purchaseUnitCost) !== normalize(productUnitCost)
}

function compareOptionalDate(left?: string | null, right?: string | null) {
    if (!left && !right) {
        return 0
    }

    if (!left) {
        return 1
    }

    if (!right) {
        return -1
    }

    return left.localeCompare(right)
}

function sortBatchesForConsumption(batches: StockBatch[]) {
    return [...batches].sort((left, right) => {
        const expiryComparison = compareOptionalDate(left.expiryDate, right.expiryDate)
        if (expiryComparison !== 0) {
            return expiryComparison
        }

        const manufacturingComparison = compareOptionalDate(left.manufacturingDate, right.manufacturingDate)
        if (manufacturingComparison !== 0) {
            return manufacturingComparison
        }

        const createdAtComparison = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
        if (createdAtComparison !== 0) {
            return createdAtComparison
        }

        return left.batchNumber.localeCompare(right.batchNumber)
    })
}

function toBatchAllocation(batch: StockBatch, quantity: number): StockBatchAllocation {
    return {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        quantity,
        price: batch.price,
        costPrice: batch.costPrice,
        currency: batch.currency,
        expiryDate: batch.expiryDate ?? null,
        manufacturingDate: batch.manufacturingDate ?? null
    }
}

export function planStockBatchTransfer(input: {
    inventoryQuantity: number
    batches: StockBatch[]
    requestedQuantity: number
    selectedBatchAllocations?: StockBatchTransferSelection[]
}): StockBatchTransferPlan {
    const inventoryQuantity = Number(input.inventoryQuantity)
    const requestedQuantity = Number(input.requestedQuantity)

    if (!isNonNegativeQuantity(inventoryQuantity)) {
        throw new Error('Inventory quantity must be greater than or equal to zero')
    }

    if (!isPositiveQuantity(requestedQuantity)) {
        throw new Error('Transfer quantity must be greater than zero')
    }

    if (requestedQuantity - inventoryQuantity > QUANTITY_EPSILON) {
        throw new Error('Insufficient inventory in source storage')
    }

    const activeBatches = sortBatchesForConsumption(
        input.batches.filter((batch) => !batch.isDeleted && batch.quantity > QUANTITY_EPSILON)
    )
    const batchQuantity = activeBatches.reduce((sum, batch) => sum + batch.quantity, 0)
    const unbatchedAvailable = Math.max(inventoryQuantity - batchQuantity, 0)

    if (input.selectedBatchAllocations === undefined) {
        const batchAllocations: StockBatchAllocation[] = []
        let remaining = requestedQuantity

        for (const batch of activeBatches) {
            if (remaining <= QUANTITY_EPSILON) {
                break
            }

            const quantity = Math.min(batch.quantity, remaining)
            if (quantity > QUANTITY_EPSILON) {
                batchAllocations.push(toBatchAllocation(batch, quantity))
                remaining = roundQuantity(remaining - quantity)
            }
        }

        if (remaining - unbatchedAvailable > QUANTITY_EPSILON) {
            throw new Error('Insufficient regular stock in source storage')
        }

        return {
            requestedQuantity,
            batchAllocations,
            unbatchedQuantity: roundQuantity(remaining)
        }
    }

    const requestedByBatchId = new Map<string, number>()
    for (const selection of input.selectedBatchAllocations) {
        const batchId = selection.batchId?.trim()
        const quantity = Number(selection.quantity)

        if (!batchId) {
            throw new Error('Batch selection is missing a batch ID')
        }

        if (!isPositiveQuantity(quantity)) {
            throw new Error('Batch transfer quantity must be greater than zero')
        }

        requestedByBatchId.set(batchId, roundQuantity((requestedByBatchId.get(batchId) || 0) + quantity))
    }

    const batchesById = new Map(activeBatches.map((batch) => [batch.id, batch] as const))
    const batchAllocations = Array.from(requestedByBatchId.entries()).map(([batchId, quantity]) => {
        const batch = batchesById.get(batchId)
        if (!batch) {
            throw new Error('One or more selected batches are no longer available')
        }

        if (quantity - batch.quantity > QUANTITY_EPSILON) {
            throw new Error(`Batch ${batch.batchNumber} does not have enough stock`)
        }

        return toBatchAllocation(batch, quantity)
    })
    const selectedBatchQuantity = batchAllocations.reduce(
        (sum, allocation) => sum + allocation.quantity,
        0
    )

    if (selectedBatchQuantity - requestedQuantity > QUANTITY_EPSILON) {
        throw new Error('Selected batch quantity exceeds the transfer quantity')
    }

    const unbatchedQuantity = roundQuantity(requestedQuantity - selectedBatchQuantity)
    if (unbatchedQuantity - unbatchedAvailable > QUANTITY_EPSILON) {
        throw new Error('Insufficient regular stock in source storage')
    }

    return {
        requestedQuantity,
        batchAllocations,
        unbatchedQuantity
    }
}

function normalizeAllocationList(allocations: StockBatchAllocation[]) {
    const merged = new Map<string, StockBatchAllocation>()

    for (const allocation of allocations) {
        const batchId = allocation.batchId?.trim()
        const batchNumber = allocation.batchNumber?.trim()
        const quantity = Number(allocation.quantity)

        if (!batchId) {
            throw new Error('Batch allocation is missing batch ID')
        }

        if (!batchNumber) {
            throw new Error('Batch allocation is missing batch number')
        }

        if (!isPositiveQuantity(quantity)) {
            throw new Error('Batch allocation quantity must be greater than zero')
        }

        const existing = merged.get(batchId)
        merged.set(batchId, {
            batchId,
            batchNumber,
            quantity: roundQuantity((existing?.quantity || 0) + quantity),
            price: allocation.price == null
                ? (existing?.price ?? null)
                : normalizeMoneyValue(allocation.price, 'Batch allocation price'),
            costPrice: allocation.costPrice == null
                ? (existing?.costPrice ?? null)
                : normalizeMoneyValue(allocation.costPrice, 'Batch allocation cost'),
            currency: allocation.currency == null
                ? (existing?.currency ?? null)
                : normalizeCurrencyCode(allocation.currency, existing?.currency ?? 'usd'),
            expiryDate: allocation.expiryDate ?? existing?.expiryDate ?? null,
            manufacturingDate: allocation.manufacturingDate ?? existing?.manufacturingDate ?? null
        })
    }

    return Array.from(merged.values())
}

function getSellableQuantity(inventoryQuantity: number, batches: StockBatch[]) {
    void batches
    return inventoryQuantity
}

async function getProductBatchDefaults(
    productId: string,
    options?: {
        allowMissing?: boolean
    }
) {
    const product = await db.products.get(productId)
    if (!product || product.isDeleted) {
        if (options?.allowMissing) {
            return {
                price: 0,
                costPrice: 0,
                currency: 'usd' as CurrencyCode
            }
        }

        throw new Error('Product not found')
    }

    return {
        price: normalizeMoneyValue(product.price, 'Batch price'),
        costPrice: normalizeMoneyValue(product.costPrice, 'Batch cost'),
        currency: normalizeCurrencyCode(product.currency, 'usd')
    }
}

async function normalizeBatchInput(
    input: StockBatchInput,
    existing?: Partial<StockBatch>
) {
    const productId = input.productId.trim()
    const storageId = input.storageId.trim()
    const batchNumber = input.batchNumber.trim()
    const quantity = Number(input.quantity)

    if (!productId) {
        throw new Error('Product is required')
    }

    if (!storageId) {
        throw new Error('Storage is required')
    }

    if (!batchNumber) {
        throw new Error('Batch number is required')
    }

    if (!isPositiveQuantity(quantity)) {
        throw new Error('Batch quantity must be greater than zero')
    }

    const productDefaults = await getProductBatchDefaults(productId)

    return {
        productId,
        storageId,
        batchNumber,
        quantity: roundQuantity(quantity),
        price: normalizeMoneyValue(
            input.price ?? existing?.price ?? productDefaults.price,
            'Batch price'
        ),
        costPrice: normalizeMoneyValue(
            input.costPrice ?? existing?.costPrice ?? productDefaults.costPrice,
            'Batch cost'
        ),
        currency: normalizeCurrencyCode(
            input.currency ?? existing?.currency ?? productDefaults.currency,
            productDefaults.currency
        ),
        expiryDate: normalizeDateString(input.expiryDate),
        manufacturingDate: normalizeDateString(input.manufacturingDate),
        notes: normalizeOptionalString(input.notes),
        sourcePurchaseOrderId: normalizeOptionalString(
            input.sourcePurchaseOrderId ?? existing?.sourcePurchaseOrderId
        ),
        sourcePurchaseOrderItemId: normalizeOptionalString(
            input.sourcePurchaseOrderItemId ?? existing?.sourcePurchaseOrderItemId
        )
    }
}

async function markBatchesSynced(ids: string[]) {
    if (ids.length === 0) {
        return
    }

    const syncedAt = new Date().toISOString()
    await Promise.all(ids.map((id) =>
        db.stock_batches.update(id, {
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        })
    ))
}

async function queueOfflineUpserts(
    batches: StockBatch[],
    workspaceId: string
) {
    await Promise.all(batches.map((batch) =>
        addToOfflineMutations(
            TABLE_NAME,
            batch.id,
            batch.version > 1 ? 'update' : 'create',
            batch as unknown as Record<string, unknown>,
            workspaceId
        )
    ))
}

export async function syncStockBatchesBestEffort(
    batches: StockBatch[],
    workspaceId: string
) {
    const dedupedBatches = Array.from(
        new Map(batches.map((batch) => [batch.id, batch])).values()
    )
    if (!dedupedBatches.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline()) {
        await queueOfflineUpserts(dedupedBatches, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(TABLE_NAME)
        const payload = dedupedBatches.map((batch) =>
            sanitizeBatchPayload(batch as unknown as Record<string, unknown>)
        )

        const { error } = await runSupabaseAction(`${TABLE_NAME}.sync`, () =>
            client.from(TABLE_NAME).upsert(payload)
        )

        if (error) {
            throw error
        }

        await markBatchesSynced(dedupedBatches.map((batch) => batch.id))
    } catch (error) {
        console.error('[StockBatches] Failed to sync batches:', error)
        await queueOfflineUpserts(dedupedBatches, workspaceId)
    }
}

async function getActiveBatchesForProductStorage(productId: string, storageId: string) {
    return db.stock_batches
        .where('[productId+storageId]')
        .equals([productId, storageId])
        .and((row) => !row.isDeleted)
        .toArray()
}

type NormalizedStockBatchInput = Awaited<ReturnType<typeof normalizeBatchInput>>

async function validateBatchTotals(
    workspaceId: string,
    batch: NormalizedStockBatchInput,
    currentBatchId?: string
) {
    const inventoryQuantity = await getInventoryQuantityForProductStorage(batch.productId, batch.storageId)
    const activeBatches = await getActiveBatchesForProductStorage(batch.productId, batch.storageId)

    const duplicateBatch = activeBatches.find((row) =>
        row.id !== currentBatchId
        && row.batchNumber.trim().toLowerCase() === batch.batchNumber.toLowerCase()
    )

    if (duplicateBatch) {
        throw new Error('Batch number already exists for this product and storage')
    }

    const otherBatchQuantity = activeBatches
        .filter((row) => row.id !== currentBatchId)
        .reduce((sum, row) => sum + row.quantity, 0)

    const nextBatchQuantity = roundQuantity(otherBatchQuantity + batch.quantity)
    if (nextBatchQuantity - inventoryQuantity > QUANTITY_EPSILON) {
        throw new Error('Batch quantities cannot exceed inventory quantity')
    }

    return {
        workspaceId,
        inventoryQuantity,
        batchQuantity: nextBatchQuantity,
        isBalanced: quantitiesEqual(inventoryQuantity, nextBatchQuantity)
    } satisfies StockBatchCoverage & { workspaceId: string }
}

export async function getStockBatchCoverage(
    productId: string,
    storageId: string
): Promise<StockBatchCoverage> {
    const [inventoryQuantity, activeBatches] = await Promise.all([
        getInventoryQuantityForProductStorage(productId, storageId),
        getActiveBatchesForProductStorage(productId, storageId)
    ])

    const batchQuantity = activeBatches.reduce((sum, row) => sum + row.quantity, 0)
    return {
        inventoryQuantity,
        batchQuantity,
        isBalanced: quantitiesEqual(inventoryQuantity, batchQuantity)
    }
}

export async function getStockBatchSalePlan(
    productId: string,
    storageId: string,
    requestedQuantity: number
): Promise<StockBatchSalePlan> {
    const [plan] = await getStockBatchSalePlans([{
        productId,
        storageId,
        quantity: requestedQuantity
    }])
    return plan
}

export async function getStockBatchTransferPlan(
    productId: string,
    storageId: string,
    requestedQuantity: number,
    selectedBatchAllocations?: StockBatchTransferSelection[]
) {
    const [inventoryQuantity, batches] = await Promise.all([
        getInventoryQuantityForProductStorage(productId, storageId),
        getActiveBatchesForProductStorage(productId, storageId)
    ])

    return planStockBatchTransfer({
        inventoryQuantity,
        batches,
        requestedQuantity,
        selectedBatchAllocations
    })
}

export async function getStockBatchSalePlans(
    requests: StockBatchSaleRequest[]
): Promise<StockBatchSalePlan[]> {
    const normalizedRequests = requests.map((request) => {
        const quantity = Number(request.quantity)
        if (!isPositiveQuantity(quantity)) {
            throw new Error('Sale quantity must be greater than zero')
        }
        return {
            productId: request.productId,
            storageId: request.storageId,
            quantity: roundQuantity(quantity),
            selectedBatchAllocations: request.selectedBatchAllocations === undefined
                ? undefined
                : request.selectedBatchAllocations.map((selection) => ({
                    batchId: selection.batchId,
                    quantity: roundQuantity(Number(selection.quantity))
                }))
        }
    })
    const positionKeys = Array.from(new Set(normalizedRequests.map((request) =>
        `${request.productId}:${request.storageId}`
    )))
    const positionState = new Map<string, {
        inventoryQuantity: number
        remainingInventory: number
        batchQuantity: number
        sellableQuantity: number
        batches: Array<StockBatch & { remainingQuantity: number }>
    }>()

    await Promise.all(positionKeys.map(async (positionKey) => {
        const request = normalizedRequests.find((entry) =>
            `${entry.productId}:${entry.storageId}` === positionKey
        )
        if (!request) {
            return
        }

        const [inventoryQuantity, activeBatches] = await Promise.all([
            getInventoryQuantityForProductStorage(request.productId, request.storageId),
            getActiveBatchesForProductStorage(request.productId, request.storageId)
        ])
        const sortedBatches = sortBatchesForConsumption(activeBatches)
        const batchQuantity = sortedBatches.reduce((sum, row) => sum + row.quantity, 0)

        positionState.set(positionKey, {
            inventoryQuantity,
            remainingInventory: inventoryQuantity,
            batchQuantity,
            sellableQuantity: getSellableQuantity(inventoryQuantity, sortedBatches),
            batches: sortedBatches.map((batch) => ({
                ...batch,
                remainingQuantity: batch.quantity
            }))
        })
    }))

    return normalizedRequests.map((request) => {
        const positionKey = `${request.productId}:${request.storageId}`
        const state = positionState.get(positionKey)
        if (!state || request.quantity - state.remainingInventory > QUANTITY_EPSILON) {
            throw new Error('Insufficient inventory for this product')
        }

        const allocations: StockBatchAllocation[] = []
        if (request.selectedBatchAllocations === undefined) {
            let remaining = request.quantity
            for (const batch of state.batches) {
                if (remaining <= QUANTITY_EPSILON) {
                    break
                }

                const allocatedQuantity = Math.min(remaining, batch.remainingQuantity)
                if (allocatedQuantity <= QUANTITY_EPSILON) {
                    continue
                }

                allocations.push(toBatchAllocation(batch, allocatedQuantity))
                batch.remainingQuantity = roundQuantity(batch.remainingQuantity - allocatedQuantity)
                remaining = roundQuantity(remaining - allocatedQuantity)
            }
        } else {
            const requestedByBatchId = new Map<string, number>()
            for (const selection of request.selectedBatchAllocations) {
                const batchId = selection.batchId?.trim()
                if (!batchId || !isPositiveQuantity(selection.quantity)) {
                    throw new Error('Invalid batch selection')
                }
                requestedByBatchId.set(
                    batchId,
                    roundQuantity((requestedByBatchId.get(batchId) || 0) + selection.quantity)
                )
            }

            const selectedQuantity = Array.from(requestedByBatchId.values())
                .reduce((sum, quantity) => roundQuantity(sum + quantity), 0)
            if (selectedQuantity - request.quantity > QUANTITY_EPSILON) {
                throw new Error('Selected batch quantity exceeds the sale quantity')
            }

            for (const [batchId, quantity] of requestedByBatchId) {
                const batch = state.batches.find((entry) => entry.id === batchId)
                if (!batch) {
                    throw new Error('One or more selected batches are no longer available')
                }
                if (quantity - batch.remainingQuantity > QUANTITY_EPSILON) {
                    throw new Error(`Batch ${batch.batchNumber} does not have enough stock`)
                }

                allocations.push(toBatchAllocation(batch, quantity))
                batch.remainingQuantity = roundQuantity(batch.remainingQuantity - quantity)
            }

            const regularQuantity = roundQuantity(request.quantity - selectedQuantity)
            const regularAvailable = roundQuantity(Math.max(
                state.remainingInventory - state.batches.reduce((sum, batch) => sum + batch.remainingQuantity, 0),
                0
            ))
            if (regularQuantity - regularAvailable > QUANTITY_EPSILON) {
                throw new Error('Insufficient regular stock in source storage')
            }
        }

        state.remainingInventory = roundQuantity(state.remainingInventory - request.quantity)
        return {
            productId: request.productId,
            storageId: request.storageId,
            requestedQuantity: request.quantity,
            inventoryQuantity: state.inventoryQuantity,
            batchQuantity: state.batchQuantity,
            sellableQuantity: state.sellableQuantity,
            allocations
        }
    })
}

export async function commitStockBatchAllocations(
    workspaceId: string,
    productId: string,
    storageId: string,
    allocations: StockBatchAllocation[],
    options?: {
        timestamp?: string
        syncSource?: 'local' | 'remote'
        skipRemoteSync?: boolean
    }
) {
    const normalizedAllocations = normalizeAllocationList(allocations)
    if (normalizedAllocations.length === 0) {
        return []
    }

    const timestamp = options?.timestamp || new Date().toISOString()
    const syncSource = options?.syncSource || 'local'
    if (syncSource === 'local') {
        if (!assertRecentCurrentUserCanAccessStorage(workspaceId, storageId)) {
            await assertCurrentUserCanAccessStorage(workspaceId, storageId)
        }
    }
    const updatedBatches = await db.transaction('rw', db.stock_batches, async () => {
        const rowsToSync: StockBatch[] = []

        for (const allocation of normalizedAllocations) {
            const existing = await db.stock_batches.get(allocation.batchId)
            if (!existing || existing.isDeleted) {
                throw new Error(`Batch ${allocation.batchNumber} is not available`)
            }

            if (existing.productId !== productId || existing.storageId !== storageId) {
                throw new Error(`Batch ${allocation.batchNumber} does not belong to the selected product/storage`)
            }

            if (allocation.quantity - existing.quantity > QUANTITY_EPSILON) {
                throw new Error(`Batch ${allocation.batchNumber} does not have enough stock`)
            }

            const nextQuantity = roundQuantity(existing.quantity - allocation.quantity)
            const updated: StockBatch = {
                ...existing,
                quantity: nextQuantity,
                isDeleted: nextQuantity <= QUANTITY_EPSILON,
                updatedAt: timestamp,
                version: existing.version + 1,
                ...getSyncMetadata(workspaceId, timestamp, syncSource)
            }

            await db.stock_batches.put(updated)
            rowsToSync.push(updated)
        }

        return rowsToSync
    })

    if (!options?.skipRemoteSync && syncSource !== 'remote') {
        await syncStockBatchesBestEffort(updatedBatches, workspaceId)
    }
    return updatedBatches
}

export function splitStockBatchAllocationsForReturn(
    allocations: StockBatchAllocation[] | undefined,
    returnQuantity: number
) {
    const normalizedQuantity = Number(returnQuantity)
    if (!isNonNegativeQuantity(normalizedQuantity)) {
        throw new Error('Return quantity must be greater than or equal to zero')
    }

    const normalizedAllocations = normalizeAllocationList(allocations ?? [])
    if (normalizedQuantity <= QUANTITY_EPSILON || normalizedAllocations.length === 0) {
        return {
            restoredAllocations: [] as StockBatchAllocation[],
            remainingAllocations: normalizedAllocations
        }
    }

    const allocatedQuantity = normalizedAllocations.reduce((sum, allocation) => sum + allocation.quantity, 0)
    if (normalizedQuantity - allocatedQuantity > QUANTITY_EPSILON) {
        throw new Error('Return quantity exceeds stored batch allocations')
    }

    let remainingToRestore = roundQuantity(normalizedQuantity)
    const restoredAllocations: StockBatchAllocation[] = []
    const remainingAllocations: StockBatchAllocation[] = []

    for (const allocation of normalizedAllocations) {
        if (remainingToRestore <= QUANTITY_EPSILON) {
            remainingAllocations.push(allocation)
            continue
        }

        const restoredQuantity = Math.min(remainingToRestore, allocation.quantity)
        if (restoredQuantity > QUANTITY_EPSILON) {
            restoredAllocations.push({
                ...allocation,
                quantity: restoredQuantity
            })
        }

        const leftoverQuantity = roundQuantity(allocation.quantity - restoredQuantity)
        if (leftoverQuantity > QUANTITY_EPSILON) {
            remainingAllocations.push({
                ...allocation,
                quantity: leftoverQuantity
            })
        }

        remainingToRestore = roundQuantity(remainingToRestore - restoredQuantity)
    }

    return {
        restoredAllocations,
        remainingAllocations
    }
}

export async function restoreStockBatchAllocations(
    workspaceId: string,
    productId: string,
    storageId: string,
    allocations: StockBatchAllocation[],
    options?: {
        timestamp?: string
        syncSource?: 'local' | 'remote'
        skipRemoteSync?: boolean
    }
) {
    const normalizedAllocations = normalizeAllocationList(allocations)
    if (normalizedAllocations.length === 0) {
        return []
    }

    const timestamp = options?.timestamp || new Date().toISOString()
    const syncSource = options?.syncSource || 'local'
    const productDefaults = await getProductBatchDefaults(productId, {
        allowMissing: true
    })
    const restorationResult = await db.transaction('rw', db.stock_batches, async () => {
        const rowsToSync: StockBatch[] = []
        const appliedAllocations: StockBatchAllocation[] = []

        for (const allocation of normalizedAllocations) {
            const existing = await db.stock_batches.get(allocation.batchId)

            if (existing && existing.productId === productId && existing.storageId === storageId) {
                const updated: StockBatch = {
                    ...existing,
                    quantity: roundQuantity(existing.quantity + allocation.quantity),
                    batchNumber: existing.batchNumber || allocation.batchNumber,
                    price: Number.isFinite(existing.price)
                        ? existing.price
                        : normalizeMoneyValue(
                            allocation.price ?? productDefaults.price,
                            'Batch price'
                        ),
                    costPrice: Number.isFinite(existing.costPrice)
                        ? existing.costPrice
                        : normalizeMoneyValue(
                            allocation.costPrice ?? productDefaults.costPrice,
                            'Batch cost'
                        ),
                    currency: normalizeCurrencyCode(
                        existing.currency ?? allocation.currency ?? productDefaults.currency,
                        productDefaults.currency
                    ),
                    expiryDate: existing.expiryDate ?? allocation.expiryDate ?? null,
                    manufacturingDate: existing.manufacturingDate ?? allocation.manufacturingDate ?? null,
                    isDeleted: false,
                    updatedAt: timestamp,
                    version: existing.version + 1,
                    ...getSyncMetadata(workspaceId, timestamp, syncSource)
                }

                await db.stock_batches.put(updated)
                rowsToSync.push(updated)
                appliedAllocations.push({
                    batchId: updated.id,
                    batchNumber: updated.batchNumber,
                    quantity: allocation.quantity,
                    price: updated.price,
                    costPrice: updated.costPrice,
                    currency: updated.currency,
                    expiryDate: updated.expiryDate ?? null,
                    manufacturingDate: updated.manufacturingDate ?? null
                })
                continue
            }

            const matchingBatchNumbers = await db.stock_batches
                .where('[productId+storageId]')
                .equals([productId, storageId])
                .filter((row) => row.batchNumber.trim().toLowerCase() === allocation.batchNumber.toLowerCase())
                .toArray()
            const matchingBatchNumber = matchingBatchNumbers.find((batch) => !batch.isDeleted)
                ?? matchingBatchNumbers[0]

            if (matchingBatchNumber) {
                const updated: StockBatch = {
                    ...matchingBatchNumber,
                    quantity: roundQuantity(matchingBatchNumber.quantity + allocation.quantity),
                    batchNumber: matchingBatchNumber.batchNumber || allocation.batchNumber,
                    price: Number.isFinite(matchingBatchNumber.price)
                        ? matchingBatchNumber.price
                        : normalizeMoneyValue(
                            allocation.price ?? productDefaults.price,
                            'Batch price'
                        ),
                    costPrice: Number.isFinite(matchingBatchNumber.costPrice)
                        ? matchingBatchNumber.costPrice
                        : normalizeMoneyValue(
                            allocation.costPrice ?? productDefaults.costPrice,
                            'Batch cost'
                        ),
                    currency: normalizeCurrencyCode(
                        matchingBatchNumber.currency ?? allocation.currency ?? productDefaults.currency,
                        productDefaults.currency
                    ),
                    expiryDate: matchingBatchNumber.expiryDate ?? allocation.expiryDate ?? null,
                    manufacturingDate: matchingBatchNumber.manufacturingDate ?? allocation.manufacturingDate ?? null,
                    isDeleted: false,
                    updatedAt: timestamp,
                    version: matchingBatchNumber.version + 1,
                    ...getSyncMetadata(workspaceId, timestamp, syncSource)
                }

                await db.stock_batches.put(updated)
                rowsToSync.push(updated)
                appliedAllocations.push({
                    batchId: updated.id,
                    batchNumber: updated.batchNumber,
                    quantity: allocation.quantity,
                    price: updated.price,
                    costPrice: updated.costPrice,
                    currency: updated.currency,
                    expiryDate: updated.expiryDate ?? null,
                    manufacturingDate: updated.manufacturingDate ?? null
                })
                continue
            }

            const restored: StockBatch = {
                id: existing ? generateId() : allocation.batchId,
                workspaceId,
                productId,
                storageId,
                batchNumber: allocation.batchNumber,
                quantity: allocation.quantity,
                price: normalizeMoneyValue(
                    allocation.price ?? productDefaults.price,
                    'Batch price'
                ),
                costPrice: normalizeMoneyValue(
                    allocation.costPrice ?? productDefaults.costPrice,
                    'Batch cost'
                ),
                currency: normalizeCurrencyCode(
                    allocation.currency ?? productDefaults.currency,
                    productDefaults.currency
                ),
                expiryDate: allocation.expiryDate ?? null,
                manufacturingDate: allocation.manufacturingDate ?? null,
                notes: null,
                createdAt: timestamp,
                updatedAt: timestamp,
                version: 1,
                isDeleted: false,
                ...getSyncMetadata(workspaceId, timestamp, syncSource)
            }

            await db.stock_batches.put(restored)
            rowsToSync.push(restored)
            appliedAllocations.push({
                batchId: restored.id,
                batchNumber: restored.batchNumber,
                quantity: allocation.quantity,
                price: restored.price,
                costPrice: restored.costPrice,
                currency: restored.currency,
                expiryDate: restored.expiryDate ?? null,
                manufacturingDate: restored.manufacturingDate ?? null
            })
        }

        return {
            rowsToSync,
            appliedAllocations
        }
    })

    if (!options?.skipRemoteSync && syncSource !== 'remote') {
        await syncStockBatchesBestEffort(restorationResult.rowsToSync, workspaceId)
    }
    return restorationResult.appliedAllocations
}

function batchSnapshotsAreCompatible(
    batch: StockBatch,
    allocation: StockBatchAllocation
) {
    return batch.price === Number(allocation.price ?? batch.price)
        && batch.costPrice === Number(allocation.costPrice ?? batch.costPrice)
        && batch.currency === normalizeCurrencyCode(allocation.currency, batch.currency)
        && (batch.expiryDate ?? null) === (allocation.expiryDate ?? null)
        && (batch.manufacturingDate ?? null) === (allocation.manufacturingDate ?? null)
}

export async function transferStockBatchAllocations(input: {
    workspaceId: string
    productId: string
    sourceStorageId: string
    targetStorageId: string
    allocations: StockBatchAllocation[]
    timestamp?: string
}): Promise<InventoryTransferBatchAllocation[]> {
    const allocations = normalizeAllocationList(input.allocations)
    if (allocations.length === 0) {
        return []
    }

    for (const allocation of allocations) {
        const matchingTargetBatches = await db.stock_batches
            .where('[productId+storageId]')
            .equals([input.productId, input.targetStorageId])
            .filter((batch) =>
                batch.batchNumber.trim().toLowerCase()
                === allocation.batchNumber.trim().toLowerCase()
            )
            .toArray()
        const matchingTargetBatch = matchingTargetBatches.find((batch) => !batch.isDeleted)
            ?? matchingTargetBatches[0]

        if (matchingTargetBatch && !batchSnapshotsAreCompatible(matchingTargetBatch, allocation)) {
            throw new Error(
                `Destination batch ${allocation.batchNumber} has different pricing or dates`
            )
        }
    }

    const timestamp = input.timestamp || new Date().toISOString()
    await commitStockBatchAllocations(
        input.workspaceId,
        input.productId,
        input.sourceStorageId,
        allocations,
        { timestamp }
    )

    let destinationAllocations: StockBatchAllocation[]
    try {
        destinationAllocations = await restoreStockBatchAllocations(
            input.workspaceId,
            input.productId,
            input.targetStorageId,
            allocations,
            { timestamp }
        )
    } catch (error) {
        await restoreStockBatchAllocations(
            input.workspaceId,
            input.productId,
            input.sourceStorageId,
            allocations,
            { timestamp: new Date().toISOString() }
        )
        throw error
    }

    const destinationByBatchNumber = new Map(
        destinationAllocations.map((allocation) => [
            allocation.batchNumber.trim().toLowerCase(),
            allocation
        ] as const)
    )

    return allocations.map((allocation) => {
        const destination = destinationByBatchNumber.get(
            allocation.batchNumber.trim().toLowerCase()
        )
        if (!destination) {
            throw new Error(`Destination batch ${allocation.batchNumber} was not created`)
        }

        return {
            sourceBatchId: allocation.batchId,
            destinationBatchId: destination.batchId,
            batchNumber: allocation.batchNumber,
            quantity: allocation.quantity,
            price: allocation.price ?? null,
            costPrice: allocation.costPrice ?? null,
            currency: allocation.currency ?? null,
            expiryDate: allocation.expiryDate ?? null,
            manufacturingDate: allocation.manufacturingDate ?? null
        }
    })
}

export async function createStockBatch(
    workspaceId: string,
    input: StockBatchInput,
    options?: {
        timestamp?: string
        id?: string
        syncSource?: 'local' | 'remote'
        skipRemoteSync?: boolean
    }
) {
    const timestamp = options?.timestamp || new Date().toISOString()
    const syncSource = options?.syncSource || 'local'
    const normalized = await normalizeBatchInput(input)
    if (syncSource === 'local') {
        await assertCurrentUserCanAccessStorage(workspaceId, normalized.storageId)
    }
    await validateBatchTotals(workspaceId, normalized)

    const batch: StockBatch = {
        id: options?.id || generateId(),
        workspaceId,
        ...normalized,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, timestamp, syncSource)
    }

    await db.stock_batches.put(batch)
    if (!options?.skipRemoteSync && syncSource !== 'remote') {
        await syncStockBatchesBestEffort([batch], workspaceId)
    }
    return batch
}

export async function updateStockBatch(id: string, data: Partial<StockBatchInput>) {
    const existing = await db.stock_batches.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Batch not found')
    }

    const timestamp = new Date().toISOString()
    const normalized = await normalizeBatchInput({
        productId: data.productId ?? existing.productId,
        storageId: data.storageId ?? existing.storageId,
        batchNumber: data.batchNumber ?? existing.batchNumber,
        quantity: data.quantity ?? existing.quantity,
        price: data.price ?? existing.price,
        costPrice: data.costPrice ?? existing.costPrice,
        currency: data.currency ?? existing.currency,
        expiryDate: data.expiryDate ?? existing.expiryDate,
        manufacturingDate: data.manufacturingDate ?? existing.manufacturingDate,
        notes: data.notes ?? existing.notes,
        sourcePurchaseOrderId: data.sourcePurchaseOrderId ?? existing.sourcePurchaseOrderId,
        sourcePurchaseOrderItemId: data.sourcePurchaseOrderItemId ?? existing.sourcePurchaseOrderItemId
    }, existing)
    await assertCurrentUserCanAccessStorage(existing.workspaceId, normalized.storageId)
    await validateBatchTotals(existing.workspaceId, normalized, existing.id)

    const updated: StockBatch = {
        ...existing,
        ...normalized,
        updatedAt: timestamp,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, timestamp)
    }

    await db.stock_batches.put(updated)
    await syncStockBatchesBestEffort([updated], existing.workspaceId)
    return updated
}

export async function deleteStockBatch(id: string) {
    const existing = await db.stock_batches.get(id)
    if (!existing || existing.isDeleted) {
        return
    }

    const timestamp = new Date().toISOString()
    await assertCurrentUserCanAccessStorage(existing.workspaceId, existing.storageId)
    const deleted: StockBatch = {
        ...existing,
        isDeleted: true,
        updatedAt: timestamp,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, timestamp)
    }

    await db.stock_batches.put(deleted)
    await syncStockBatchesBestEffort([deleted], existing.workspaceId)
}

async function refreshStockBatchesFromSupabaseInternal(
    workspaceId: string,
    options: StockBatchFetchOptions
): Promise<boolean> {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return true
    }

    const storageId = options.storageId?.trim()
    const client = getSupabaseClientForTable(TABLE_NAME)
    const remoteRows: Record<string, unknown>[] = []

    for (let from = 0; ; from += STOCK_BATCH_FETCH_PAGE_SIZE) {
        let query = client
            .from(TABLE_NAME)
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('is_deleted', false)

        if (storageId) {
            query = query.eq('storage_id', storageId)
        }

        query = query
            .order('id', { ascending: true })
            .range(from, from + STOCK_BATCH_FETCH_PAGE_SIZE - 1)

        const { data, error } = await runSupabaseAction(`${TABLE_NAME}.fetch.page`, () => query)
        if (!data || error) return false
        if (!await canReconcileCloudWorkspaceData(workspaceId)) return true

        remoteRows.push(...(data as Record<string, unknown>[]))
        if (data.length < STOCK_BATCH_FETCH_PAGE_SIZE) {
            break
        }
    }

    const syncedAt = new Date().toISOString()
    const remoteIds = new Set(remoteRows.map((row) => row.id as string))
    const remoteProductIds = Array.from(new Set(
        remoteRows
            .map((row) => row.product_id ?? row.productId)
            .filter((productId): productId is string => typeof productId === 'string')
    ))
    const productRows = storageId
        ? (await db.products.bulkGet(remoteProductIds)).filter((product): product is NonNullable<typeof product> =>
            !!product && product.workspaceId === workspaceId && !product.isDeleted
        )
        : await db.products.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
    const productDefaultsById = new Map(productRows.map((product) => [product.id, {
        price: normalizeMoneyValue(product.price, 'Batch price'),
        costPrice: normalizeMoneyValue(product.costPrice, 'Batch cost'),
        currency: normalizeCurrencyCode(product.currency, 'usd')
    }] as const))

    const localItems = remoteRows.map((remoteItem) => {
        const localItem = toCamelCase(remoteItem) as unknown as StockBatch
        const productDefaults = productDefaultsById.get(localItem.productId)
        localItem.price = Number.isFinite(localItem.price)
            ? localItem.price
            : productDefaults?.price ?? 0
        localItem.costPrice = Number.isFinite(localItem.costPrice)
            ? localItem.costPrice
            : productDefaults?.costPrice ?? 0
        localItem.currency = normalizeCurrencyCode(
            localItem.currency,
            productDefaults?.currency ?? 'usd'
        )
        localItem.syncStatus = 'synced'
        localItem.lastSyncedAt = syncedAt
        return localItem
    })

    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return true
    }

    await db.transaction('rw', db.stock_batches, async () => {
        const localRows = storageId
            ? await db.stock_batches.where('[workspaceId+storageId]').equals([workspaceId, storageId]).toArray()
            : await db.stock_batches.where('workspaceId').equals(workspaceId).toArray()
        const staleIds = localRows
            .filter((row) => row.syncStatus === 'synced' && !remoteIds.has(row.id))
            .map((row) => row.id)

        if (staleIds.length > 0) {
            await db.stock_batches.bulkDelete(staleIds)
        }

        if (localItems.length > 0) {
            await db.stock_batches.bulkPut(localItems)
        }
    })

    return true
}

export async function refreshStockBatchesFromSupabase(
    workspaceId: string,
    options: StockBatchFetchOptions = {}
): Promise<boolean> {
    if (!workspaceId || !isOnline()) {
        return true
    }

    const storageId = options.storageId?.trim()
    const key = `${workspaceId}:${storageId || 'all'}`
    const existing = stockBatchFetchesInFlight.get(key)
    if (existing) {
        return existing
    }

    const request = (async () => {
        if (!await canReconcileCloudWorkspaceData(workspaceId)) {
            return true
        }
        return refreshStockBatchesFromSupabaseInternal(workspaceId, { storageId })
    })()
        .finally(() => {
            if (stockBatchFetchesInFlight.get(key) === request) {
                stockBatchFetchesInFlight.delete(key)
            }
        })

    stockBatchFetchesInFlight.set(key, request)
    return request
}

export async function hydrateStockBatchesForPurchaseOrder(
    workspaceId: string,
    purchaseOrderId: string
) {
    if (!workspaceId || !purchaseOrderId || !shouldUseCloudBusinessData(workspaceId) || !isOnline()) {
        return
    }

    const client = getSupabaseClientForTable(TABLE_NAME)
    const { data, error } = await runSupabaseAction(`${TABLE_NAME}.purchaseReceipt.fetch`, () =>
        client
            .from(TABLE_NAME)
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('source_purchase_order_id', purchaseOrderId)
    )
    if (error || !data) {
        return
    }

    const syncedAt = new Date().toISOString()
    await db.transaction('rw', db.stock_batches, async () => {
        for (const remoteItem of data) {
            const localItem = toCamelCase(remoteItem as Record<string, unknown>) as unknown as StockBatch
            localItem.syncStatus = 'synced'
            localItem.lastSyncedAt = syncedAt
            await db.stock_batches.put(localItem)
        }
    })
}

export function useStockBatches(workspaceId: string | undefined, options: UseStockBatchesOptions = {}) {
    const online = useNetworkStatus()
    const enabled = options.enabled ?? true
    const syncRemote = options.syncRemote ?? true
    const storageId = options.storageId?.trim()
    const storageAccess = useStorageAccess(workspaceId)

    const batches = useLiveQuery(
        async () => {
            if (!enabled || !workspaceId) {
                return []
            }

            const rows = storageId
                ? await db.stock_batches
                    .where('[workspaceId+storageId]')
                    .equals([workspaceId, storageId])
                    .and((row) => !row.isDeleted)
                    .toArray()
                : await db.stock_batches
                    .where('workspaceId')
                    .equals(workspaceId)
                    .and((row) => !row.isDeleted)
                    .toArray()

            return rows.filter((row) => canAccessStorage(row.storageId, storageAccess)).sort((left, right) => {
                if (left.productId !== right.productId) {
                    return left.productId.localeCompare(right.productId)
                }

                if (left.storageId !== right.storageId) {
                    return left.storageId.localeCompare(right.storageId)
                }

                return left.batchNumber.localeCompare(right.batchNumber)
            })
        },
        [enabled, storageAccess.signature, storageId, workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (!enabled || !syncRemote || !online || !workspaceId) {
                return
            }

            await refreshStockBatchesFromSupabase(workspaceId, { storageId })
        }

        void fetchFromSupabase()
    }, [enabled, online, storageId, syncRemote, workspaceId])

    return batches ?? []
}

export function useBatchAwareInventoryProducts(workspaceId: string | undefined, options: UseStockBatchesOptions = {}) {
    const inventoryProducts = useInventoryProducts(workspaceId, options)
    const stockBatches = useStockBatches(workspaceId, options)

    return useMemo(() => {
        const batchRowsByPosition = new Map<string, StockBatch[]>()

        for (const batch of stockBatches) {
            const positionKey = `${batch.productId}:${batch.storageId}`
            const existing = batchRowsByPosition.get(positionKey) ?? []
            existing.push(batch)
            batchRowsByPosition.set(positionKey, existing)
        }

        return inventoryProducts.map((product) => {
            const positionKey = `${product.id}:${product.storageId}`
            const batchRows = batchRowsByPosition.get(positionKey) ?? []
            const sortedBatchRows = sortBatchesForConsumption(batchRows)

            if (sortedBatchRows.length === 0) {
                return {
                    ...product,
                    hasBatches: false,
                    batchCount: 0,
                    nextBatchNumber: null,
                    nextBatchExpiryDate: null,
                    nextBatchQuantity: null
                } satisfies BatchAwareInventoryProduct
            }

            const nextBatch = sortedBatchRows[0]
            const sellableQuantity = getSellableQuantity(product.inventoryQuantity, sortedBatchRows)
            
            const effectivePrice = nextBatch?.price ?? product.price
            const effectiveCostPrice = nextBatch?.costPrice ?? product.costPrice
            const effectiveCurrency = nextBatch?.currency ?? product.currency

            return {
                ...product,
                price: effectivePrice,
                costPrice: effectiveCostPrice,
                currency: effectiveCurrency,
                inventoryQuantity: sellableQuantity,
                quantity: sellableQuantity,
                hasBatches: true,
                batchCount: sortedBatchRows.length,
                nextBatchNumber: nextBatch?.batchNumber ?? null,
                nextBatchExpiryDate: nextBatch?.expiryDate ?? null,
                nextBatchQuantity: nextBatch?.quantity ?? null,
                nextBatchPrice: effectivePrice,
                nextBatchCostPrice: effectiveCostPrice,
                nextBatchCurrency: effectiveCurrency
            } satisfies BatchAwareInventoryProduct
        })
    }, [inventoryProducts, stockBatches])
}

export function useStockBatchesForProduct(productId: string | undefined) {
    const storageAccess = useStorageAccess(undefined)
    const batches = useLiveQuery(
        async () => {
            if (!productId) {
                return []
            }

            const rows = await db.stock_batches
                .where('productId')
                .equals(productId)
                .and((row) => !row.isDeleted)
                .toArray()

            return rows
                .filter((row) => canAccessStorage(row.storageId, storageAccess))
                .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
        },
        [productId, storageAccess.signature]
    )

    return batches ?? []
}
