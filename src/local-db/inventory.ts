import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import type { Inventory, Product } from './models'
import { createInventoryTransaction } from './inventoryTransactions'
import { syncProductBarcodeCachesForWorkspace } from './productBarcodes'

type InventorySyncSource = 'local' | 'remote'

export type InventoryProduct = Product & {
    inventoryId: string
    inventoryQuantity: number
    storageId: string
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(
    workspaceId: string,
    timestamp: string,
    syncSource: InventorySyncSource = 'local'
) {
    if (syncSource === 'remote') {
        return {
            syncStatus: 'synced' as const,
            lastSyncedAt: timestamp
        }
    }

    if (shouldUseCloudBusinessData(workspaceId)) {
        return {
            syncStatus: 'pending' as const,
            lastSyncedAt: null
        }
    }

    return {
        syncStatus: 'synced' as const,
        lastSyncedAt: timestamp
    }
}

function isPositiveQuantity(value: number) {
    return Number.isFinite(value) && value > 0
}

function buildInventoryPositionKey(workspaceId: string, productId: string, storageId: string) {
    return `${workspaceId}:${productId}:${storageId}`
}

async function reconcileInventoryRowsSynced(
    localRows: Inventory[],
    remoteRows: Record<string, unknown>[],
    syncedAt: string
) {
    const normalizedRemoteRows = remoteRows.map((remoteRow) => {
        const localRow = toCamelCase(remoteRow) as unknown as Inventory
        localRow.syncStatus = 'synced'
        localRow.lastSyncedAt = syncedAt
        return localRow
    })

    await db.transaction('rw', db.inventory, async () => {
        for (const remoteRow of normalizedRemoteRows) {
            const duplicateRows = await getInventoryRowsForProductStorage(remoteRow.productId, remoteRow.storageId)
            for (const duplicateRow of duplicateRows) {
                if (duplicateRow.id !== remoteRow.id && duplicateRow.syncStatus === 'synced') {
                    await db.inventory.delete(duplicateRow.id)
                }
            }

            await db.inventory.put(remoteRow)
        }

        for (const localRow of localRows) {
            const matchedRemoteRow = normalizedRemoteRows.find((remoteRow) =>
                buildInventoryPositionKey(remoteRow.workspaceId, remoteRow.productId, remoteRow.storageId)
                === buildInventoryPositionKey(localRow.workspaceId, localRow.productId, localRow.storageId)
            )

            if (matchedRemoteRow && matchedRemoteRow.id !== localRow.id) {
                await db.inventory.delete(localRow.id)
            }
        }
    })
}

async function hydrateInventoryProductStoragesFromSupabase(
    workspaceId: string,
    productId: string,
    storageIds: string[]
) {
    if (!shouldUseCloudBusinessData(workspaceId) || !isOnline()) {
        return
    }

    const normalizedStorageIds = Array.from(new Set(storageIds.filter(Boolean)))
    if (normalizedStorageIds.length === 0) {
        return
    }

    const client = getSupabaseClientForTable('inventory')
    const fetchedAt = new Date().toISOString()

    const query = normalizedStorageIds.length === 1
        ? client
            .from('inventory')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('product_id', productId)
            .eq('storage_id', normalizedStorageIds[0])
            .eq('is_deleted', false)
        : client
            .from('inventory')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('product_id', productId)
            .in('storage_id', normalizedStorageIds)
            .eq('is_deleted', false)

    const { data: remoteRows, error } = await runSupabaseAction('inventory.position.fetch', () => query)
    if (error || !remoteRows) {
        return
    }

    const normalizedRemoteRows = remoteRows.map((remoteRow) => {
        const localRow = toCamelCase(remoteRow as Record<string, unknown>) as unknown as Inventory
        localRow.syncStatus = 'synced'
        localRow.lastSyncedAt = fetchedAt
        return localRow
    })

    const remoteKeys = new Set(normalizedRemoteRows.map((row) =>
        buildInventoryPositionKey(row.workspaceId, row.productId, row.storageId)
    ))

    await db.transaction('rw', db.inventory, async () => {
        const localRows = await db.inventory
            .where('productId')
            .equals(productId)
            .and((row) => normalizedStorageIds.includes(row.storageId))
            .toArray()

        for (const localRow of localRows) {
            const localKey = buildInventoryPositionKey(localRow.workspaceId, localRow.productId, localRow.storageId)
            if (!remoteKeys.has(localKey) && localRow.syncStatus === 'synced') {
                await db.inventory.delete(localRow.id)
            }
        }

        for (const remoteRow of normalizedRemoteRows) {
            for (const localRow of localRows) {
                const localKey = buildInventoryPositionKey(localRow.workspaceId, localRow.productId, localRow.storageId)
                const remoteKey = buildInventoryPositionKey(remoteRow.workspaceId, remoteRow.productId, remoteRow.storageId)
                if (localKey === remoteKey && localRow.id !== remoteRow.id && localRow.syncStatus === 'synced') {
                    await db.inventory.delete(localRow.id)
                }
            }

            await db.inventory.put(remoteRow)
        }
    })
}

async function syncInventoryRowsBestEffort(rows: Array<Inventory | null>, workspaceId: string) {
    const dedupedRows = Array.from(
        new Map(rows.filter((row): row is Inventory => !!row).map((row) => [row.id, row])).values()
    )

    if (dedupedRows.length === 0 || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (isOnline()) {
        try {
            const payload = dedupedRows.map((row) => toSnakeCase({
                ...row,
                syncStatus: undefined,
                lastSyncedAt: undefined
            }))

            const client = getSupabaseClientForTable('inventory')
            const { data: remoteRows, error } = await runSupabaseAction('inventory.sync', () =>
                client
                    .from('inventory')
                    .upsert(payload, { onConflict: 'workspace_id,product_id,storage_id' })
                    .select('*')
            )

            if (!error && remoteRows) {
                const syncedAt = new Date().toISOString()
                await reconcileInventoryRowsSynced(dedupedRows, remoteRows as Record<string, unknown>[], syncedAt)
                return
            }
        } catch (error) {
            console.error('[Inventory] Remote sync failed, queueing for retry:', error)
        }
    }

    await Promise.all(dedupedRows.map((row) =>
        addToOfflineMutations(
            'inventory',
            row.id,
            row.version > 1 || row.isDeleted ? 'update' : 'create',
            row as unknown as Record<string, unknown>,
            workspaceId
        )
    ))
}

async function evaluateReorderRulesIfNeeded(input: {
    workspaceId: string
    productId: string
    syncSource: InventorySyncSource
    skipReorderCheck?: boolean
}) {
    if (input.syncSource !== 'local' || input.skipReorderCheck) {
        return
    }

    const { evaluateReorderTransferRulesForProduct } = await import('./reorderTransferRules')
    await evaluateReorderTransferRulesForProduct(input.workspaceId, input.productId)
}

async function fetchInventoryWorkspaceFromSupabase(workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    const inventoryClient = getSupabaseClientForTable('inventory')
    const fetchedAt = new Date().toISOString()

    const [{ data: remoteInventory, error: inventoryError }, { data: remoteProducts, error: productError }] = await Promise.all([
        runSupabaseAction('inventory.fetch', () =>
            inventoryClient
                .from('inventory')
                .select('*')
                .eq('workspace_id', workspaceId)
                .eq('is_deleted', false)
        ),
        runSupabaseAction('inventory.products.fetch', () =>
            getSupabaseClientForTable('products')
                .from('products')
                .select('*')
                .eq('workspace_id', workspaceId)
                .eq('is_deleted', false)
        )
    ])

    if (inventoryError || productError || !remoteInventory || !remoteProducts || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    const affectedProductIds = new Set<string>()

    await db.transaction('rw', [db.inventory, db.products], async () => {
        const remoteInventoryIds = new Set(remoteInventory.map((item) => item.id))
        const remoteProductIds = new Set(remoteProducts.map((item) => item.id))

        const [localInventoryRows, localProducts] = await Promise.all([
            db.inventory.where('workspaceId').equals(workspaceId).toArray(),
            db.products.where('workspaceId').equals(workspaceId).toArray()
        ])

        for (const localRow of localInventoryRows) {
            if (!remoteInventoryIds.has(localRow.id) && localRow.syncStatus === 'synced') {
                affectedProductIds.add(localRow.productId)
                await db.inventory.delete(localRow.id)
            }
        }

        for (const localProduct of localProducts) {
            if (!remoteProductIds.has(localProduct.id) && localProduct.syncStatus === 'synced') {
                await db.products.delete(localProduct.id)
            }
        }

        for (const remoteProduct of remoteProducts) {
            const localProduct = toCamelCase(remoteProduct as Record<string, unknown>) as unknown as Product
            localProduct.syncStatus = 'synced'
            localProduct.lastSyncedAt = fetchedAt
            await db.products.put(localProduct)
        }

        for (const remoteRow of remoteInventory) {
            const localRow = toCamelCase(remoteRow as Record<string, unknown>) as unknown as Inventory
            localRow.syncStatus = 'synced'
            localRow.lastSyncedAt = fetchedAt
            affectedProductIds.add(localRow.productId)
            await db.inventory.put(localRow)
        }
    })

    await Promise.all(Array.from(affectedProductIds).map((productId) =>
        syncProductStockSnapshot(productId, fetchedAt, 'remote')
    ))

    await syncProductBarcodeCachesForWorkspace(workspaceId)

    if (affectedProductIds.size > 0) {
        const { evaluateReorderTransferRulesForProduct } = await import('./reorderTransferRules')
        await Promise.all(Array.from(affectedProductIds).map((productId) =>
            evaluateReorderTransferRulesForProduct(workspaceId, productId)
        ))
    }
}

function useInventoryCloudSync(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    useEffect(() => {
        async function syncFromSupabase() {
            if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
                await fetchInventoryWorkspaceFromSupabase(workspaceId)
            }
        }

        void syncFromSupabase()
    }, [online, workspaceId])
}

async function getInventoryRowsForProductStorage(productId: string, storageId: string) {
    return db.inventory.where('[productId+storageId]').equals([productId, storageId]).toArray()
}

async function putInventoryQuantity(
    workspaceId: string,
    productId: string,
    storageId: string,
    quantity: number,
    timestamp: string,
    syncSource: InventorySyncSource = 'local'
) {
    const rows = await getInventoryRowsForProductStorage(productId, storageId)
    const activeRow = rows.find((row) => !row.isDeleted)
    const restorableRow = rows.find((row) => row.isDeleted)
    const syncMetadata = getSyncMetadata(workspaceId, timestamp, syncSource)

    if (!isPositiveQuantity(quantity)) {
        if (!activeRow) {
            return null
        }

        const deletedRow: Inventory = {
            ...activeRow,
            quantity: 0,
            isDeleted: true,
            updatedAt: timestamp,
            version: syncSource === 'remote' ? activeRow.version : activeRow.version + 1,
            ...syncMetadata
        }

        await db.inventory.put(deletedRow)
        return deletedRow
    }

    if (activeRow) {
        const updatedRow: Inventory = {
            ...activeRow,
            quantity,
            isDeleted: false,
            updatedAt: timestamp,
            version: syncSource === 'remote' ? activeRow.version : activeRow.version + 1,
            ...syncMetadata
        }

        await db.inventory.put(updatedRow)
        return updatedRow
    }

    if (restorableRow) {
        const restoredRow: Inventory = {
            ...restorableRow,
            quantity,
            isDeleted: false,
            updatedAt: timestamp,
            version: syncSource === 'remote' ? restorableRow.version : restorableRow.version + 1,
            ...syncMetadata
        }

        await db.inventory.put(restoredRow)
        return restoredRow
    }

    const inventoryRow: Inventory = {
        id: generateId(),
        workspaceId,
        productId,
        storageId,
        quantity,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        isDeleted: false,
        ...syncMetadata
    }

    await db.inventory.put(inventoryRow)
    return inventoryRow
}

export async function syncProductStockSnapshot(
    productId: string,
    timestamp: string = new Date().toISOString(),
    syncSource: InventorySyncSource = 'local'
) {
    const product = await db.products.get(productId)
    if (!product || product.isDeleted) {
        return null
    }

    const inventoryRows = await db.inventory.where('productId').equals(productId).and((row) => !row.isDeleted).toArray()
    const totalQuantity = inventoryRows.reduce((sum, row) => sum + row.quantity, 0)
    const resolvedStorageId = inventoryRows.length === 1 ? inventoryRows[0].storageId : null
    const resolvedStorage = resolvedStorageId ? await db.storages.get(resolvedStorageId) : undefined
    const resolvedStorageName = resolvedStorageId ? resolvedStorage?.name : undefined

    if (
        product.quantity === totalQuantity
        && (product.storageId ?? null) === resolvedStorageId
        && (product.storageName ?? undefined) === resolvedStorageName
    ) {
        return product
    }

    const updatedProduct: Product = {
        ...product,
        quantity: totalQuantity,
        storageId: resolvedStorageId,
        storageName: resolvedStorageName,
        updatedAt: timestamp,
        version: syncSource === 'remote' ? product.version : product.version + 1,
        ...getSyncMetadata(product.workspaceId, timestamp, syncSource)
    }

    await db.products.put(updatedProduct)
    return updatedProduct
}

export async function getInventoryQuantityForProductStorage(productId: string, storageId: string) {
    const row = await db.inventory
        .where('[productId+storageId]')
        .equals([productId, storageId])
        .and((item) => !item.isDeleted)
        .first()

    return row?.quantity ?? 0
}

export async function getInventoryRowsForProduct(productId: string) {
    return db.inventory.where('productId').equals(productId).and((row) => !row.isDeleted).toArray()
}

export async function setProductInventoryFromLegacyInput(input: {
    workspaceId: string
    productId: string
    storageId?: string | null
    quantity: number
    timestamp?: string
    syncSource?: InventorySyncSource
    skipRemoteSync?: boolean
    skipReorderCheck?: boolean
}) {
    const timestamp = input.timestamp || new Date().toISOString()
    const syncSource = input.syncSource || 'local'
    const changedRows: Array<Inventory | null> = []

    const updatedProduct = await db.transaction('rw', [db.inventory, db.products, db.storages], async () => {
        const activeRows = await getInventoryRowsForProduct(input.productId)

        if (activeRows.length > 1) {
            return syncProductStockSnapshot(input.productId, timestamp, syncSource)
        }

        if (!input.storageId) {
            if (activeRows.length === 1) {
                changedRows.push(await putInventoryQuantity(
                    input.workspaceId,
                    input.productId,
                    activeRows[0].storageId,
                    input.quantity,
                    timestamp,
                    syncSource
                ))
            }

            return syncProductStockSnapshot(input.productId, timestamp, syncSource)
        }

        if (activeRows.length === 0) {
            changedRows.push(await putInventoryQuantity(
                input.workspaceId,
                input.productId,
                input.storageId,
                input.quantity,
                timestamp,
                syncSource
            ))
            return syncProductStockSnapshot(input.productId, timestamp, syncSource)
        }

        const currentRow = activeRows[0]
        if (currentRow.storageId === input.storageId) {
            changedRows.push(await putInventoryQuantity(
                input.workspaceId,
                input.productId,
                input.storageId,
                input.quantity,
                timestamp,
                syncSource
            ))
            return syncProductStockSnapshot(input.productId, timestamp, syncSource)
        }

        const movedRow: Inventory = {
            ...currentRow,
            storageId: input.storageId,
            quantity: Math.max(0, input.quantity),
            updatedAt: timestamp,
            version: syncSource === 'remote' ? currentRow.version : currentRow.version + 1,
            ...getSyncMetadata(input.workspaceId, timestamp, syncSource)
        }

        if (!isPositiveQuantity(input.quantity)) {
            movedRow.quantity = 0
            movedRow.isDeleted = true
        }

        await db.inventory.put(movedRow)
        changedRows.push(movedRow)
        return syncProductStockSnapshot(input.productId, timestamp, syncSource)
    })

    if (!input.skipRemoteSync && syncSource !== 'remote') {
        await syncInventoryRowsBestEffort(changedRows, input.workspaceId)
    }

    await evaluateReorderRulesIfNeeded({
        workspaceId: input.workspaceId,
        productId: input.productId,
        syncSource,
        skipReorderCheck: input.skipReorderCheck
    })

    return updatedProduct
}

export async function adjustInventoryQuantity(input: {
    workspaceId: string
    productId: string
    storageId: string
    quantityDelta: number
    timestamp?: string
    syncSource?: InventorySyncSource
    skipRemoteSync?: boolean
    skipReorderCheck?: boolean
}) {
    const timestamp = input.timestamp || new Date().toISOString()
    const syncSource = input.syncSource || 'local'
    let changedRow: Inventory | null = null

    if (syncSource === 'local') {
        await hydrateInventoryProductStoragesFromSupabase(input.workspaceId, input.productId, [input.storageId])
    }

    const updatedProduct = await db.transaction('rw', [db.inventory, db.products, db.storages], async () => {
        const currentQuantity = await getInventoryQuantityForProductStorage(input.productId, input.storageId)
        const nextQuantity = currentQuantity + input.quantityDelta

        if (nextQuantity < 0) {
            throw new Error('Insufficient inventory')
        }

        changedRow = await putInventoryQuantity(
            input.workspaceId,
            input.productId,
            input.storageId,
            nextQuantity,
            timestamp,
            syncSource
        )

        return syncProductStockSnapshot(input.productId, timestamp, syncSource)
    })

    if (!input.skipRemoteSync && syncSource !== 'remote') {
        await syncInventoryRowsBestEffort([changedRow], input.workspaceId)
    }

    await evaluateReorderRulesIfNeeded({
        workspaceId: input.workspaceId,
        productId: input.productId,
        syncSource,
        skipReorderCheck: input.skipReorderCheck
    })

    return updatedProduct
}

export async function transferInventoryQuantity(input: {
    workspaceId: string
    productId: string
    sourceStorageId: string
    targetStorageId: string
    quantity: number
    referenceId?: string | null
    referenceType?: string | null
    notes?: string | null
    createdBy?: string | null
    timestamp?: string
    syncSource?: InventorySyncSource
    skipRemoteSync?: boolean
    skipReorderCheck?: boolean
    skipTransactionLog?: boolean
}) {
    if (input.sourceStorageId === input.targetStorageId) {
        throw new Error('Source and target storages must be different')
    }

    if (!isPositiveQuantity(input.quantity)) {
        throw new Error('Transfer quantity must be greater than zero')
    }

    const timestamp = input.timestamp || new Date().toISOString()
    const syncSource = input.syncSource || 'local'
    let sourceRow: Inventory | null = null
    let targetRow: Inventory | null = null
    let sourcePreviousQuantity = 0
    let targetPreviousQuantity = 0

    if (syncSource === 'local') {
        await hydrateInventoryProductStoragesFromSupabase(
            input.workspaceId,
            input.productId,
            [input.sourceStorageId, input.targetStorageId]
        )
    }

    const updatedProduct = await db.transaction('rw', [db.inventory, db.products, db.storages], async () => {
        const sourceQuantity = await getInventoryQuantityForProductStorage(input.productId, input.sourceStorageId)
        if (sourceQuantity < input.quantity) {
            throw new Error('Insufficient inventory in source storage')
        }

        const targetQuantity = await getInventoryQuantityForProductStorage(input.productId, input.targetStorageId)
        sourcePreviousQuantity = sourceQuantity
        targetPreviousQuantity = targetQuantity

        sourceRow = await putInventoryQuantity(
            input.workspaceId,
            input.productId,
            input.sourceStorageId,
            sourceQuantity - input.quantity,
            timestamp,
            syncSource
        )
        targetRow = await putInventoryQuantity(
            input.workspaceId,
            input.productId,
            input.targetStorageId,
            targetQuantity + input.quantity,
            timestamp,
            syncSource
        )

        return syncProductStockSnapshot(input.productId, timestamp, syncSource)
    })

    if (!input.skipRemoteSync && syncSource !== 'remote') {
        await syncInventoryRowsBestEffort([sourceRow, targetRow], input.workspaceId)
    }

    if (!input.skipTransactionLog) {
        const referenceType = input.referenceType || 'transfer'
        await Promise.all([
            createInventoryTransaction(input.workspaceId, {
                productId: input.productId,
                storageId: input.sourceStorageId,
                transactionType: 'transfer_out',
                quantityDelta: -input.quantity,
                previousQuantity: sourcePreviousQuantity,
                newQuantity: Math.max(sourcePreviousQuantity - input.quantity, 0),
                referenceId: input.referenceId ?? null,
                referenceType,
                notes: input.notes ?? null,
                createdBy: input.createdBy ?? null
            }, { timestamp }),
            createInventoryTransaction(input.workspaceId, {
                productId: input.productId,
                storageId: input.targetStorageId,
                transactionType: 'transfer_in',
                quantityDelta: input.quantity,
                previousQuantity: targetPreviousQuantity,
                newQuantity: targetPreviousQuantity + input.quantity,
                referenceId: input.referenceId ?? null,
                referenceType,
                notes: input.notes ?? null,
                createdBy: input.createdBy ?? null
            }, { timestamp })
        ])
    }

    await evaluateReorderRulesIfNeeded({
        workspaceId: input.workspaceId,
        productId: input.productId,
        syncSource,
        skipReorderCheck: input.skipReorderCheck
    })

    return updatedProduct
}

export async function deleteInventoryForProduct(
    productId: string,
    timestamp: string = new Date().toISOString(),
    options?: {
        syncSource?: InventorySyncSource
        skipRemoteSync?: boolean
    }
) {
    const product = await db.products.get(productId)
    if (!product) {
        return
    }

    const syncSource = options?.syncSource || 'local'
    const syncMetadata = getSyncMetadata(product.workspaceId, timestamp, syncSource)
    const rows = await db.inventory.where('productId').equals(productId).and((row) => !row.isDeleted).toArray()
    const deletedRows = rows.map((row) => ({
        ...row,
        quantity: 0,
        isDeleted: true,
        updatedAt: timestamp,
        version: syncSource === 'remote' ? row.version : row.version + 1,
        ...syncMetadata
    }))

    await Promise.all(deletedRows.map((row) => db.inventory.put(row)))

    if (!options?.skipRemoteSync && syncSource !== 'remote') {
        await syncInventoryRowsBestEffort(deletedRows, product.workspaceId)
    }
}

export function useInventory(workspaceId: string | undefined) {
    useInventoryCloudSync(workspaceId)

    const inventory = useLiveQuery(
        () => workspaceId ? db.inventory.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray() : [],
        [workspaceId]
    )

    return inventory ?? []
}

export function useInventoryProducts(workspaceId: string | undefined) {
    useInventoryCloudSync(workspaceId)

    const products = useLiveQuery(async () => {
        if (!workspaceId) {
            return []
        }

        const [inventoryRows, productRows] = await Promise.all([
            db.inventory.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray(),
            db.products.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
        ])

        const productMap = new Map(productRows.map((product) => [product.id, product]))

        return inventoryRows
            .map((row) => {
                const product = productMap.get(row.productId)
                if (!product) {
                    return null
                }

                return {
                    ...product,
                    inventoryId: row.id,
                    inventoryQuantity: row.quantity,
                    quantity: row.quantity,
                    storageId: row.storageId
                } satisfies InventoryProduct
            })
            .filter((item): item is InventoryProduct => !!item)
    }, [workspaceId])

    return products ?? []
}
