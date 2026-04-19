import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { getInventoryQuantityForProductStorage } from './inventory'
import { addToOfflineMutations } from './offlineMutations'
import type { StockBatch } from './models'

const TABLE_NAME = 'stock_batches'

export interface StockBatchInput {
    productId: string
    storageId: string
    batchNumber: string
    quantity: number
    expiryDate?: string | null
    manufacturingDate?: string | null
    notes?: string | null
}

export interface StockBatchCoverage {
    inventoryQuantity: number
    batchQuantity: number
    isBalanced: boolean
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
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

function normalizeBatchInput(input: StockBatchInput) {
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

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Batch quantity must be a whole number greater than zero')
    }

    return {
        productId,
        storageId,
        batchNumber,
        quantity,
        expiryDate: normalizeDateString(input.expiryDate),
        manufacturingDate: normalizeDateString(input.manufacturingDate),
        notes: normalizeOptionalString(input.notes)
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

async function syncUpsertBatches(
    batches: StockBatch[],
    workspaceId: string
) {
    if (!batches.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline()) {
        await queueOfflineUpserts(batches, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(TABLE_NAME)
        const payload = batches.map((batch) =>
            sanitizeBatchPayload(batch as unknown as Record<string, unknown>)
        )

        const { error } = await runSupabaseAction(`${TABLE_NAME}.sync`, () =>
            client.from(TABLE_NAME).upsert(payload)
        )

        if (error) {
            throw error
        }

        await markBatchesSynced(batches.map((batch) => batch.id))
    } catch (error) {
        console.error('[StockBatches] Failed to sync batches:', error)
        await queueOfflineUpserts(batches, workspaceId)
    }
}

async function getActiveBatchesForProductStorage(productId: string, storageId: string) {
    return db.stock_batches
        .where('[productId+storageId]')
        .equals([productId, storageId])
        .and((row) => !row.isDeleted)
        .toArray()
}

async function validateBatchTotals(
    workspaceId: string,
    batch: ReturnType<typeof normalizeBatchInput>,
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

    const nextBatchQuantity = otherBatchQuantity + batch.quantity
    if (nextBatchQuantity > inventoryQuantity) {
        throw new Error('Batch quantities cannot exceed inventory quantity')
    }

    return {
        workspaceId,
        inventoryQuantity,
        batchQuantity: nextBatchQuantity,
        isBalanced: inventoryQuantity === nextBatchQuantity
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
        isBalanced: inventoryQuantity === batchQuantity
    }
}

export async function createStockBatch(
    workspaceId: string,
    input: StockBatchInput,
    options?: {
        timestamp?: string
        id?: string
    }
) {
    const timestamp = options?.timestamp || new Date().toISOString()
    const normalized = normalizeBatchInput(input)
    await validateBatchTotals(workspaceId, normalized)

    const batch: StockBatch = {
        id: options?.id || generateId(),
        workspaceId,
        ...normalized,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, timestamp)
    }

    await db.stock_batches.put(batch)
    await syncUpsertBatches([batch], workspaceId)
    return batch
}

export async function updateStockBatch(id: string, data: Partial<StockBatchInput>) {
    const existing = await db.stock_batches.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Batch not found')
    }

    const timestamp = new Date().toISOString()
    const normalized = normalizeBatchInput({
        productId: data.productId ?? existing.productId,
        storageId: data.storageId ?? existing.storageId,
        batchNumber: data.batchNumber ?? existing.batchNumber,
        quantity: data.quantity ?? existing.quantity,
        expiryDate: data.expiryDate ?? existing.expiryDate,
        manufacturingDate: data.manufacturingDate ?? existing.manufacturingDate,
        notes: data.notes ?? existing.notes
    })
    await validateBatchTotals(existing.workspaceId, normalized, existing.id)

    const updated: StockBatch = {
        ...existing,
        ...normalized,
        updatedAt: timestamp,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, timestamp)
    }

    await db.stock_batches.put(updated)
    await syncUpsertBatches([updated], existing.workspaceId)
    return updated
}

export async function deleteStockBatch(id: string) {
    const existing = await db.stock_batches.get(id)
    if (!existing || existing.isDeleted) {
        return
    }

    const timestamp = new Date().toISOString()
    const deleted: StockBatch = {
        ...existing,
        isDeleted: true,
        updatedAt: timestamp,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, timestamp)
    }

    await db.stock_batches.put(deleted)
    await syncUpsertBatches([deleted], existing.workspaceId)
}

export function useStockBatches(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const batches = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const rows = await db.stock_batches
                .where('workspaceId')
                .equals(workspaceId)
                .and((row) => !row.isDeleted)
                .toArray()

            return rows.sort((left, right) => {
                if (left.productId !== right.productId) {
                    return left.productId.localeCompare(right.productId)
                }

                if (left.storageId !== right.storageId) {
                    return left.storageId.localeCompare(right.storageId)
                }

                return left.batchNumber.localeCompare(right.batchNumber)
            })
        },
        [workspaceId]
    )

    useEffect(() => {
        async function fetchFromSupabase() {
            if (!online || !workspaceId || !shouldUseCloudBusinessData(workspaceId)) {
                return
            }

            const client = getSupabaseClientForTable(TABLE_NAME)
            const { data, error } = await runSupabaseAction(`${TABLE_NAME}.fetch`, () =>
                client
                    .from(TABLE_NAME)
                    .select('*')
                    .eq('workspace_id', workspaceId)
                    .eq('is_deleted', false)
            )

            if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
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

        void fetchFromSupabase()
    }, [online, workspaceId])

    return batches ?? []
}

export function useStockBatchesForProduct(productId: string | undefined) {
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

            return rows.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
        },
        [productId]
    )

    return batches ?? []
}
