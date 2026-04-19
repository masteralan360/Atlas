import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { adjustInventoryQuantity, getInventoryQuantityForProductStorage } from './inventory'
import { createInventoryTransaction } from './inventoryTransactions'
import { addToOfflineMutations } from './offlineMutations'
import type {
    StockAdjustment,
    StockAdjustmentReason,
    StockAdjustmentType
} from './models'

const TABLE_NAME = 'stock_adjustments'

export interface StockAdjustmentInput {
    productId: string
    storageId: string
    adjustmentType: StockAdjustmentType
    quantity: number
    reason: StockAdjustmentReason
    notes?: string | null
    createdBy?: string | null
}

export interface StockAdjustmentFilterOptions {
    productId?: string | null
    storageId?: string | null
    adjustmentType?: StockAdjustmentType | null
    reason?: StockAdjustmentReason | null
    startDate?: Date | string | null
    endDate?: Date | string | null
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

function sanitizeAdjustmentPayload(adjustment: Record<string, unknown>) {
    return toSnakeCase({
        ...adjustment,
        syncStatus: undefined,
        lastSyncedAt: undefined
    })
}

function normalizeOptionalString(value?: string | null) {
    const normalized = value?.trim()
    return normalized ? normalized : null
}

function normalizeAdjustmentInput(input: StockAdjustmentInput) {
    const productId = input.productId.trim()
    const storageId = input.storageId.trim()
    const adjustmentType = input.adjustmentType
    const quantity = Number(input.quantity)
    const reason = input.reason
    const allowedTypes: StockAdjustmentType[] = ['increase', 'decrease']
    const allowedReasons: StockAdjustmentReason[] = [
        'purchase',
        'return',
        'correction',
        'damage',
        'theft',
        'expired',
        'production',
        'other'
    ]

    if (!productId) {
        throw new Error('Product is required')
    }

    if (!storageId) {
        throw new Error('Storage is required')
    }

    if (!allowedTypes.includes(adjustmentType)) {
        throw new Error('Adjustment type is invalid')
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Quantity must be a whole number greater than zero')
    }

    if (!allowedReasons.includes(reason)) {
        throw new Error('Adjustment reason is invalid')
    }

    return {
        productId,
        storageId,
        adjustmentType,
        quantity,
        reason,
        notes: normalizeOptionalString(input.notes),
        createdBy: normalizeOptionalString(input.createdBy)
    }
}

async function markAdjustmentsSynced(ids: string[]) {
    if (ids.length === 0) {
        return
    }

    const syncedAt = new Date().toISOString()
    await Promise.all(ids.map((id) =>
        db.stock_adjustments.update(id, {
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        })
    ))
}

async function queueOfflineUpserts(
    adjustments: StockAdjustment[],
    workspaceId: string
) {
    await Promise.all(adjustments.map((adjustment) =>
        addToOfflineMutations(
            TABLE_NAME,
            adjustment.id,
            adjustment.version > 1 ? 'update' : 'create',
            adjustment as unknown as Record<string, unknown>,
            workspaceId
        )
    ))
}

async function syncUpsertAdjustments(
    adjustments: StockAdjustment[],
    workspaceId: string
) {
    if (!adjustments.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline()) {
        await queueOfflineUpserts(adjustments, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(TABLE_NAME)
        const payload = adjustments.map((adjustment) =>
            sanitizeAdjustmentPayload(adjustment as unknown as Record<string, unknown>)
        )

        const { error } = await runSupabaseAction(`${TABLE_NAME}.sync`, () =>
            client.from(TABLE_NAME).upsert(payload)
        )

        if (error) {
            throw error
        }

        await markAdjustmentsSynced(adjustments.map((adjustment) => adjustment.id))
    } catch (error) {
        console.error('[StockAdjustments] Failed to sync adjustments:', error)
        await queueOfflineUpserts(adjustments, workspaceId)
    }
}

export async function createStockAdjustment(
    workspaceId: string,
    input: StockAdjustmentInput,
    options?: {
        timestamp?: string
        id?: string
    }
) {
    const timestamp = options?.timestamp || new Date().toISOString()
    const normalized = normalizeAdjustmentInput(input)
    const previousQuantity = await getInventoryQuantityForProductStorage(normalized.productId, normalized.storageId)
    const quantityDelta = normalized.adjustmentType === 'increase'
        ? normalized.quantity
        : -normalized.quantity
    const newQuantity = previousQuantity + quantityDelta

    if (newQuantity < 0) {
        throw new Error('Insufficient inventory')
    }

    const adjustment: StockAdjustment = {
        id: options?.id || generateId(),
        workspaceId,
        ...normalized,
        previousQuantity,
        newQuantity,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, timestamp)
    }

    await db.stock_adjustments.put(adjustment)

    let inventoryAdjusted = false
    try {
        await adjustInventoryQuantity({
            workspaceId,
            productId: normalized.productId,
            storageId: normalized.storageId,
            quantityDelta,
            timestamp
        })
        inventoryAdjusted = true

        await createInventoryTransaction(workspaceId, {
            productId: normalized.productId,
            storageId: normalized.storageId,
            transactionType: 'stock_adjustment',
            quantityDelta,
            previousQuantity,
            newQuantity,
            referenceId: adjustment.id,
            referenceType: 'stock_adjustment',
            notes: normalized.notes,
            createdBy: normalized.createdBy
        }, { timestamp })

        await syncUpsertAdjustments([adjustment], workspaceId)
        return adjustment
    } catch (error) {
        if (!inventoryAdjusted) {
            await db.stock_adjustments.delete(adjustment.id)
        }

        throw error
    }
}

export function filterStockAdjustments(
    adjustments: StockAdjustment[],
    filters: StockAdjustmentFilterOptions
) {
    const startTime = filters.startDate ? new Date(filters.startDate).setHours(0, 0, 0, 0) : null
    const endTime = filters.endDate ? new Date(filters.endDate).setHours(23, 59, 59, 999) : null

    return adjustments.filter((adjustment) => {
        if (filters.productId && adjustment.productId !== filters.productId) {
            return false
        }

        if (filters.storageId && adjustment.storageId !== filters.storageId) {
            return false
        }

        if (filters.adjustmentType && adjustment.adjustmentType !== filters.adjustmentType) {
            return false
        }

        if (filters.reason && adjustment.reason !== filters.reason) {
            return false
        }

        const createdAt = new Date(adjustment.createdAt).getTime()
        if (startTime !== null && createdAt < startTime) {
            return false
        }

        if (endTime !== null && createdAt > endTime) {
            return false
        }

        return true
    })
}

export function useStockAdjustments(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const adjustments = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const rows = await db.stock_adjustments
                .where('workspaceId')
                .equals(workspaceId)
                .and((row) => !row.isDeleted)
                .toArray()

            return rows.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
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
            await db.transaction('rw', db.stock_adjustments, async () => {
                for (const remoteItem of data) {
                    const localItem = toCamelCase(remoteItem as Record<string, unknown>) as unknown as StockAdjustment
                    localItem.syncStatus = 'synced'
                    localItem.lastSyncedAt = syncedAt
                    await db.stock_adjustments.put(localItem)
                }
            })
        }

        void fetchFromSupabase()
    }, [online, workspaceId])

    return adjustments ?? []
}
