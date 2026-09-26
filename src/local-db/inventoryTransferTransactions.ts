import { useLiveQuery } from 'dexie-react-hooks'

import { QUANTITY_EPSILON, isPositiveQuantity, roundQuantity } from '@/lib/quantity'
import { generateId } from '@/lib/utils'

import { db } from './database'
import { assertCurrentUserCanAccessStorage, canAccessStorage, useStorageAccess } from './storagePermissions'
import type {
    InventoryTransferBatchAllocation,
    InventoryTransferTransaction,
    InventoryTransferTransactionType
} from './models'

// Transfer activity is intentionally device-local in every workspace mode.
export interface InventoryTransferTransactionInput {
    id?: string
    productId: string
    sourceStorageId: string
    destinationStorageId: string
    quantity: number
    batchAllocations?: InventoryTransferBatchAllocation[] | null
    transferType: InventoryTransferTransactionType
    reorderRuleId?: string | null
    sourceWorkspaceId?: string | null
    destinationWorkspaceId?: string | null
    sourceWorkspaceName?: string | null
    destinationWorkspaceName?: string | null
    sourceStorageName?: string | null
    destinationStorageName?: string | null
}

function normalizeTransactionInput(input: InventoryTransferTransactionInput) {
    const productId = input.productId.trim()
    const sourceStorageId = input.sourceStorageId.trim()
    const destinationStorageId = input.destinationStorageId.trim()
    const quantity = Number(input.quantity)
    const batchAllocations = input.batchAllocations?.map((allocation) => ({
        ...allocation,
        sourceBatchId: allocation.sourceBatchId.trim(),
        destinationBatchId: allocation.destinationBatchId.trim(),
        batchNumber: allocation.batchNumber.trim(),
        quantity: roundQuantity(Number(allocation.quantity))
    })) ?? null
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

    if (!isPositiveQuantity(quantity)) {
        throw new Error('Transfer quantity must be greater than zero')
    }

    if (transferType !== 'manual' && transferType !== 'automation') {
        throw new Error('Transfer type is invalid')
    }

    for (const allocation of batchAllocations ?? []) {
        if (!allocation.sourceBatchId || !allocation.destinationBatchId || !allocation.batchNumber) {
            throw new Error('Batch allocation is incomplete')
        }

        if (!isPositiveQuantity(allocation.quantity)) {
            throw new Error('Batch allocation quantity must be greater than zero')
        }
    }

    const allocatedQuantity = (batchAllocations ?? []).reduce(
        (sum, allocation) => sum + allocation.quantity,
        0
    )
    if (allocatedQuantity - quantity > QUANTITY_EPSILON) {
        throw new Error('Batch allocation quantity exceeds transfer quantity')
    }

    return {
        productId,
        sourceStorageId,
        destinationStorageId,
        quantity: roundQuantity(quantity),
        batchAllocations,
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

    await Promise.all(inputs.flatMap((input) => [
        assertCurrentUserCanAccessStorage(workspaceId, input.sourceStorageId),
        assertCurrentUserCanAccessStorage(workspaceId, input.destinationStorageId)
    ]))

    const timestamp = options?.timestamp || new Date().toISOString()
    const transactions = inputs.map((input) => {
        const normalized = normalizeTransactionInput(input)

        return {
            id: input.id || generateId(),
            workspaceId,
            ...normalized,
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
            isDeleted: false,
            syncStatus: 'synced',
            lastSyncedAt: timestamp
        } satisfies InventoryTransferTransaction
    })

    await db.inventory_transfer_transactions.bulkPut(transactions)
    return transactions
}

export function useInventoryTransferTransactions(workspaceId: string | undefined) {
    const storageAccess = useStorageAccess(workspaceId)
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

            return rows
                .filter((row) => (
                    canAccessStorage(row.sourceStorageId, storageAccess)
                    && canAccessStorage(row.destinationStorageId, storageAccess)
                ))
                .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        },
        [storageAccess.signature, workspaceId]
    )

    return transactions ?? []
}
