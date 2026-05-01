import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import type {
    InventoryTransferTransaction,
    InventoryTransferTransactionType
} from './models'

export interface InventoryTransferTransactionInput {
    productId: string
    sourceStorageId: string
    destinationStorageId: string
    quantity: number
    transferType: InventoryTransferTransactionType
    reorderRuleId?: string | null
    sourceWorkspaceId?: string | null
    destinationWorkspaceId?: string | null
    sourceWorkspaceName?: string | null
    destinationWorkspaceName?: string | null
    sourceStorageName?: string | null
    destinationStorageName?: string | null
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

function sanitizeTransactionPayload(transaction: Record<string, unknown>) {
    return toSnakeCase({
        ...transaction,
        syncStatus: undefined,
        lastSyncedAt: undefined
    })
}

function normalizeTransactionInput(input: InventoryTransferTransactionInput) {
    const productId = input.productId.trim()
    const sourceStorageId = input.sourceStorageId.trim()
    const destinationStorageId = input.destinationStorageId.trim()
    const quantity = Number(input.quantity)
    const transferType = input.transferType
    const reorderRuleId = input.reorderRuleId?.trim() || null
    const sourceWorkspaceId = input.sourceWorkspaceId?.trim() || null
    const destinationWorkspaceId = input.destinationWorkspaceId?.trim() || null
    const sourceWorkspaceName = input.sourceWorkspaceName?.trim() || null
    const destinationWorkspaceName = input.destinationWorkspaceName?.trim() || null
    const sourceStorageName = input.sourceStorageName?.trim() || null
    const destinationStorageName = input.destinationStorageName?.trim() || null

    if (!productId) {
        throw new Error('Product is required')
    }

    if (!sourceStorageId) {
        throw new Error('Source storage is required')
    }

    if (!destinationStorageId) {
        throw new Error('Destination storage is required')
    }

    if (sourceStorageId === destinationStorageId) {
        throw new Error('Source and destination storages must be different')
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Transfer quantity must be a whole number greater than zero')
    }

    if (transferType !== 'manual' && transferType !== 'automation') {
        throw new Error('Transfer type is invalid')
    }

    return {
        productId,
        sourceStorageId,
        destinationStorageId,
        quantity,
        transferType,
        reorderRuleId,
        sourceWorkspaceId,
        destinationWorkspaceId,
        sourceWorkspaceName,
        destinationWorkspaceName,
        sourceStorageName,
        destinationStorageName
    }
}

export async function refreshInventoryTransferTransactionsFromSupabase(
    workspaceId: string
) {
    if (!workspaceId || !shouldUseCloudBusinessData(workspaceId) || !isOnline()) {
        return
    }

    const { data, error } = await supabase
        .from('inventory_transfer_transactions')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('is_deleted', false)

    if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    const syncedAt = new Date().toISOString()
    const remoteIds = new Set(data.map((row: Record<string, unknown>) => row.id as string))

    await db.transaction('rw', db.inventory_transfer_transactions, async () => {
        for (const remoteItem of data) {
            const localItem = toCamelCase(remoteItem as Record<string, unknown>) as unknown as InventoryTransferTransaction
            localItem.syncStatus = 'synced'
            localItem.lastSyncedAt = syncedAt
            await db.inventory_transfer_transactions.put(localItem)
        }

        const localRows = await db.inventory_transfer_transactions
            .where('workspaceId')
            .equals(workspaceId)
            .toArray()

        const staleIds = localRows
            .filter((row) => row.syncStatus === 'synced' && !remoteIds.has(row.id))
            .map((row) => row.id)

        if (staleIds.length > 0) {
            await db.inventory_transfer_transactions.bulkDelete(staleIds)
        }
    })
}

async function runMutation<T>(label: string, promiseFactory: () => PromiseLike<T>) {
    return runSupabaseAction(label, promiseFactory)
}

async function markTransactionsSynced(ids: string[]) {
    if (ids.length === 0) {
        return
    }

    const syncedAt = new Date().toISOString()
    await Promise.all(ids.map((id) =>
        db.inventory_transfer_transactions.update(id, {
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        })
    ))
}

async function queueOfflineUpserts(
    transactions: InventoryTransferTransaction[],
    workspaceId: string
) {
    await Promise.all(transactions.map((transaction) =>
        addToOfflineMutations(
            'inventory_transfer_transactions',
            transaction.id,
            transaction.version > 1 ? 'update' : 'create',
            transaction as unknown as Record<string, unknown>,
            workspaceId
        )
    ))
}

async function syncUpsertTransactions(
    transactions: InventoryTransferTransaction[],
    workspaceId: string
) {
    if (!transactions.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline()) {
        await queueOfflineUpserts(transactions, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable('inventory_transfer_transactions')
        const payload = transactions.map((transaction) =>
            sanitizeTransactionPayload(transaction as unknown as Record<string, unknown>)
        )

        const { error } = await runMutation('inventory_transfer_transactions.sync', () =>
            client.from('inventory_transfer_transactions').upsert(payload)
        )

        if (error) {
            throw error
        }

        await markTransactionsSynced(transactions.map((transaction) => transaction.id))
    } catch (error) {
        console.error('[InventoryTransferTransactions] Failed to sync transactions:', error)
        await queueOfflineUpserts(transactions, workspaceId)
    }
}

export async function createInventoryTransferTransactions(
    workspaceId: string,
    inputs: InventoryTransferTransactionInput[],
    options?: {
        timestamp?: string
    }
) {
    if (inputs.length === 0) {
        return [] as InventoryTransferTransaction[]
    }

    const timestamp = options?.timestamp || new Date().toISOString()
    const transactions = inputs.map((input) => {
        const normalized = normalizeTransactionInput(input)

        return {
            id: generateId(),
            workspaceId,
            ...normalized,
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
            isDeleted: false,
            ...getSyncMetadata(workspaceId, timestamp)
        } satisfies InventoryTransferTransaction
    })

    await db.inventory_transfer_transactions.bulkPut(transactions)
    await syncUpsertTransactions(transactions, workspaceId)
    return transactions
}

export function useInventoryTransferTransactions(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const transactions = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const rows = await db.inventory_transfer_transactions
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
            if (!online || !workspaceId) {
                return
            }

            await refreshInventoryTransferTransactionsFromSupabase(workspaceId)
        }

        void fetchFromSupabase()
    }, [online, workspaceId])

    return transactions ?? []
}
