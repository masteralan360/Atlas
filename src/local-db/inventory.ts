import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import i18n from '@/i18n/config'
import { isOnline } from '@/lib/network'
import { QUANTITY_EPSILON, isPositiveQuantity, quantitiesEqual, roundQuantity } from '@/lib/quantity'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import {
    isRetriableWebRequestError,
    normalizeSupabaseActionError,
    runSupabaseAction
} from '@/lib/supabaseRequest'
import { generateId, toCamelCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'
import { isValidNewInventoryQuantity } from './inventoryDeficit'
import type {
    Inventory,
    InventoryTransferBatchAllocation,
    Product
} from './models'
import { createInventoryTransaction } from './inventoryTransactions'
import { syncProductBarcodeCachesForWorkspace } from './productBarcodes'
import { normalizeProductSku } from './productSku'
import type { StockBatchTransferSelection } from './stockBatches'

type InventorySyncSource = 'local' | 'remote'

export type InventoryProduct = Product & {
    inventoryId: string
    inventoryQuantity: number
    storageId: string
}

const INVENTORY_FETCH_PAGE_SIZE = 1000
const INVENTORY_PRODUCT_FETCH_CHUNK_SIZE = 500
const inventoryWorkspaceFetchesInFlight = new Map<string, Promise<void>>()

export interface InventoryWorkspaceFetchOptions {
    storageId?: string
}

export interface UseInventoryOptions extends InventoryWorkspaceFetchOptions {
    syncRemote?: boolean
    enabled?: boolean
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

export function assertInventoryMutationConnectivity(workspaceId: string) {
    if (shouldUseCloudBusinessData(workspaceId) && !isOnline(workspaceId)) {
        throw new Error(i18n.t('inventory.errors.onlineRequired'))
    }
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

export async function hydrateInventoryProductStoragesFromSupabase(
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

export async function syncInventoryRowsBestEffort(rows: Array<Inventory | null>, workspaceId: string) {
    const dedupedRows = Array.from(
        new Map(rows.filter((row): row is Inventory => !!row).map((row) => [
            buildInventoryPositionKey(row.workspaceId, row.productId, row.storageId),
            row
        ])).values()
    )

    if (dedupedRows.length === 0 || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    assertInventoryMutationConnectivity(workspaceId)

    const operationId = generateId()
    const changes = dedupedRows.map((row) => ({
        id: row.id,
        product_id: row.productId,
        storage_id: row.storageId,
        quantity: row.quantity,
        expected_version: Math.max(0, Number(row.version || 1) - 1)
    }))
    const client = getSupabaseClientForTable('inventory')
    const execute = () => runSupabaseAction('inventory.sync.authoritative', () =>
        client.rpc('apply_inventory_snapshot_changes', {
            p_operation_id: operationId,
            p_workspace_id: workspaceId,
            p_operation_kind: 'client_snapshot_cas',
            p_changes: changes
        })
    )

    let response = await execute()
    if (response.error && isRetriableWebRequestError(response.error)) {
        // The first request may have committed before its response was lost.
        // Reusing the same operation id makes this retry safe.
        response = await execute()
    }

    if (response.error) {
        throw normalizeSupabaseActionError(response.error)
    }

    const remoteRows = (response.data as { inventory?: Record<string, unknown>[] } | null)?.inventory
    if (!remoteRows) {
        throw new Error(i18n.t('inventory.errors.authoritativeResultMissing'))
    }

    const syncedAt = new Date().toISOString()
    await reconcileInventoryRowsSynced(dedupedRows, remoteRows, syncedAt)
    const productIds = Array.from(new Set(
        remoteRows
            .map((row) => row.product_id)
            .filter((productId): productId is string => typeof productId === 'string')
    ))
    await Promise.all(productIds.map((productId) =>
        syncProductStockSnapshot(productId, syncedAt, 'remote')
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

async function fetchPagedWorkspaceRows(
    tableName: 'inventory' | 'products',
    workspaceId: string,
    applyFilters?: (query: any) => any
) {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return null
    }

    const client = getSupabaseClientForTable(tableName)
    const rows: Record<string, unknown>[] = []

    for (let from = 0; ; from += INVENTORY_FETCH_PAGE_SIZE) {
        let query = client
            .from(tableName)
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('is_deleted', false)

        if (applyFilters) {
            query = applyFilters(query)
        }

        query = query
            .order('id', { ascending: true })
            .range(from, from + INVENTORY_FETCH_PAGE_SIZE - 1)

        const { data, error } = await runSupabaseAction(`${tableName}.fetch.page`, () => query)
        if (error || !data || !await canReconcileCloudWorkspaceData(workspaceId)) {
            return null
        }

        rows.push(...(data as Record<string, unknown>[]))
        if (data.length < INVENTORY_FETCH_PAGE_SIZE) {
            break
        }
    }

    return rows
}

function getRemoteInventoryProductId(row: Record<string, unknown>) {
    const productId = row.product_id ?? row.productId
    return typeof productId === 'string' ? productId : null
}

async function fetchProductsForInventoryRows(
    workspaceId: string,
    remoteInventoryRows: Record<string, unknown>[],
    options: InventoryWorkspaceFetchOptions
) {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return null
    }

    if (!options.storageId) {
        return fetchPagedWorkspaceRows('products', workspaceId)
    }

    const productIds = Array.from(new Set(
        remoteInventoryRows
            .map(getRemoteInventoryProductId)
            .filter((productId): productId is string => !!productId)
    ))

    if (productIds.length === 0) {
        return []
    }

    const client = getSupabaseClientForTable('products')
    const rows: Record<string, unknown>[] = []

    for (let index = 0; index < productIds.length; index += INVENTORY_PRODUCT_FETCH_CHUNK_SIZE) {
        const chunk = productIds.slice(index, index + INVENTORY_PRODUCT_FETCH_CHUNK_SIZE)
        const { data, error } = await runSupabaseAction('inventory.products.fetchByIds', () =>
            client
                .from('products')
                .select('*')
                .eq('workspace_id', workspaceId)
                .eq('is_deleted', false)
                .in('id', chunk)
                .order('id', { ascending: true })
        )

        if (error || !data || !await canReconcileCloudWorkspaceData(workspaceId)) {
            return null
        }

        rows.push(...(data as Record<string, unknown>[]))
    }

    return rows
}

async function fetchInventoryWorkspaceFromSupabaseInternal(
    workspaceId: string,
    options: InventoryWorkspaceFetchOptions
) {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return
    }

    const storageId = options.storageId?.trim()
    const fetchedAt = new Date().toISOString()

    const [remoteInventory, remoteProducts] = storageId
        ? await (async () => {
            const inventoryRows = await fetchPagedWorkspaceRows(
                'inventory',
                workspaceId,
                (query) => query.eq('storage_id', storageId)
            )
            if (!inventoryRows) {
                return [null, null] as const
            }

            return [
                inventoryRows,
                await fetchProductsForInventoryRows(workspaceId, inventoryRows, { storageId })
            ] as const
        })()
        : await Promise.all([
            fetchPagedWorkspaceRows('inventory', workspaceId),
            fetchProductsForInventoryRows(workspaceId, [], {})
        ])

    if (!remoteInventory) {
        return
    }

    if (!remoteProducts) {
        return
    }

    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return
    }

    const normalizedRemoteProducts = remoteProducts.map((remoteProduct) => {
        const localProduct = toCamelCase(remoteProduct) as unknown as Product
        localProduct.skuKey = normalizeProductSku(localProduct.sku)
        localProduct.syncStatus = 'synced'
        localProduct.lastSyncedAt = fetchedAt
        return localProduct
    })

    const normalizedRemoteInventory = remoteInventory.map((remoteRow) => {
        const localRow = toCamelCase(remoteRow) as unknown as Inventory
        localRow.syncStatus = 'synced'
        localRow.lastSyncedAt = fetchedAt
        return localRow
    })

    const affectedProductIds = new Set<string>()

    await db.transaction('rw', [db.inventory, db.products], async () => {
        const remoteInventoryIds = new Set(normalizedRemoteInventory.map((item) => item.id))
        const remoteProductIds = new Set(normalizedRemoteProducts.map((item) => item.id))

        const localInventoryRows = storageId
            ? await db.inventory.where('[workspaceId+storageId]').equals([workspaceId, storageId]).toArray()
            : await db.inventory.where('workspaceId').equals(workspaceId).toArray()

        const staleInventoryIds = localInventoryRows
            .filter((localRow) => !remoteInventoryIds.has(localRow.id) && localRow.syncStatus === 'synced')
            .map((localRow) => {
                affectedProductIds.add(localRow.productId)
                return localRow.id
            })

        if (staleInventoryIds.length > 0) {
            await db.inventory.bulkDelete(staleInventoryIds)
        }

        if (!storageId) {
            const localProducts = await db.products.where('workspaceId').equals(workspaceId).toArray()
            const staleProductIds = localProducts
                .filter((localProduct) => !remoteProductIds.has(localProduct.id) && localProduct.syncStatus === 'synced')
                .map((localProduct) => localProduct.id)

            if (staleProductIds.length > 0) {
                await db.products.bulkDelete(staleProductIds)
            }
        }

        if (normalizedRemoteProducts.length > 0) {
            await db.products.bulkPut(normalizedRemoteProducts)
        }

        if (normalizedRemoteInventory.length > 0) {
            for (const row of normalizedRemoteInventory) {
                affectedProductIds.add(row.productId)
            }
            await db.inventory.bulkPut(normalizedRemoteInventory)
        }
    })

    // A scoped storage fetch only contains a partial inventory view. Avoid updating
    // product.quantity snapshots from partial data.
    if (storageId) {
        return
    }

    const affectedIds = Array.from(affectedProductIds)
    for (let index = 0; index < affectedIds.length; index += 100) {
        const chunk = affectedIds.slice(index, index + 100)
        await Promise.all(chunk.map((productId) =>
            syncProductStockSnapshot(productId, fetchedAt, 'remote')
        ))
    }

    await syncProductBarcodeCachesForWorkspace(workspaceId)

    if (affectedIds.length > 0) {
        const { evaluateReorderTransferRulesForProduct } = await import('./reorderTransferRules')
        for (let index = 0; index < affectedIds.length; index += 100) {
            const chunk = affectedIds.slice(index, index + 100)
            await Promise.all(chunk.map((productId) =>
                evaluateReorderTransferRulesForProduct(workspaceId, productId)
            ))
        }
    }
}

export async function fetchInventoryWorkspaceFromSupabase(
    workspaceId: string,
    options: InventoryWorkspaceFetchOptions = {}
) {
    if (!workspaceId) {
        return
    }

    const storageId = options.storageId?.trim()
    const key = `${workspaceId}:${storageId || 'all'}`
    const existing = inventoryWorkspaceFetchesInFlight.get(key)
    if (existing) {
        return existing
    }

    const request = (async () => {
        if (!await canReconcileCloudWorkspaceData(workspaceId)) {
            return
        }
        await fetchInventoryWorkspaceFromSupabaseInternal(workspaceId, { storageId })
    })()
        .finally(() => {
            if (inventoryWorkspaceFetchesInFlight.get(key) === request) {
                inventoryWorkspaceFetchesInFlight.delete(key)
            }
        })

    inventoryWorkspaceFetchesInFlight.set(key, request)
    return request
}

function useInventoryCloudSync(workspaceId: string | undefined, options: UseInventoryOptions = {}) {
    const online = useNetworkStatus()
    const enabled = options.enabled ?? true
    const syncRemote = options.syncRemote ?? true
    const storageId = options.storageId?.trim()

    useEffect(() => {
        async function syncFromSupabase() {
            if (enabled && syncRemote && online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
                await fetchInventoryWorkspaceFromSupabase(workspaceId, { storageId })
            }
        }

        void syncFromSupabase()
    }, [enabled, online, storageId, syncRemote, workspaceId])
}

async function getInventoryRowsForProductStorage(productId: string, storageId: string) {
    return db.inventory.where('[productId+storageId]').equals([productId, storageId]).toArray()
}

export async function putInventoryQuantity(
    workspaceId: string,
    productId: string,
    storageId: string,
    quantity: number,
    timestamp: string,
    syncSource: InventorySyncSource = 'local'
) {
    if (syncSource === 'local') {
        assertInventoryMutationConnectivity(workspaceId)
    }
    if (!isValidNewInventoryQuantity(quantity)) {
        throw new Error(i18n.t('inventory.errors.negativeQuantity'))
    }

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
            quantity: roundQuantity(quantity),
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
            quantity: roundQuantity(quantity),
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
        quantity: roundQuantity(quantity),
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
    const totalQuantity = roundQuantity(inventoryRows.reduce((sum, row) => sum + row.quantity, 0))
    const resolvedStorageId = inventoryRows.length === 1 ? inventoryRows[0].storageId : null
    const resolvedStorage = resolvedStorageId ? await db.storages.get(resolvedStorageId) : undefined
    const resolvedStorageName = resolvedStorageId ? resolvedStorage?.name : undefined

    const matchesInventorySnapshot =
        quantitiesEqual(product.quantity, totalQuantity)
        && (product.storageId ?? null) === resolvedStorageId
        && (product.storageName ?? undefined) === resolvedStorageName

    if (matchesInventorySnapshot) {
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
    if (!isValidNewInventoryQuantity(input.quantity)) {
        throw new Error(i18n.t('inventory.errors.negativeQuantity'))
    }
    if (syncSource === 'local') {
        assertInventoryMutationConnectivity(input.workspaceId)
    }
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
            quantity: roundQuantity(Math.max(0, input.quantity)),
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
    skipRemoteHydration?: boolean
    skipRemoteSync?: boolean
    skipReorderCheck?: boolean
}) {
    const timestamp = input.timestamp || new Date().toISOString()
    const syncSource = input.syncSource || 'local'
    if (!Number.isFinite(input.quantityDelta)) {
        throw new Error(i18n.t('inventory.errors.invalidQuantity'))
    }
    if (syncSource === 'local') {
        assertInventoryMutationConnectivity(input.workspaceId)
    }
    let changedRow: Inventory | null = null

    if (syncSource === 'local' && !input.skipRemoteHydration) {
        await hydrateInventoryProductStoragesFromSupabase(input.workspaceId, input.productId, [input.storageId])
    }

    const updatedProduct = await db.transaction('rw', [db.inventory, db.products, db.storages], async () => {
        const currentQuantity = await getInventoryQuantityForProductStorage(input.productId, input.storageId)
        const nextQuantity = roundQuantity(currentQuantity + input.quantityDelta)

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

export interface TransferInventoryQuantityInput {
    workspaceId: string
    productId: string
    sourceStorageId: string
    targetStorageId: string
    quantity: number
    batchSelections?: StockBatchTransferSelection[]
    referenceId?: string | null
    referenceType?: string | null
    notes?: string | null
    createdBy?: string | null
    timestamp?: string
    syncSource?: InventorySyncSource
    skipRemoteSync?: boolean
    skipBatchRefresh?: boolean
    skipReorderCheck?: boolean
    skipTransactionLog?: boolean
}

async function transferInventoryQuantityCore(
    input: Omit<
        TransferInventoryQuantityInput,
        'batchSelections' | 'skipBatchRefresh' | 'skipReorderCheck' | 'skipTransactionLog'
    >
) {
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
        if (input.quantity - sourceQuantity > QUANTITY_EPSILON) {
            throw new Error('Insufficient inventory in source storage')
        }

        const targetQuantity = await getInventoryQuantityForProductStorage(input.productId, input.targetStorageId)
        sourcePreviousQuantity = sourceQuantity
        targetPreviousQuantity = targetQuantity

        sourceRow = await putInventoryQuantity(
            input.workspaceId,
            input.productId,
            input.sourceStorageId,
            roundQuantity(sourceQuantity - input.quantity),
            timestamp,
            syncSource
        )
        targetRow = await putInventoryQuantity(
            input.workspaceId,
            input.productId,
            input.targetStorageId,
            roundQuantity(targetQuantity + input.quantity),
            timestamp,
            syncSource
        )

        return syncProductStockSnapshot(input.productId, timestamp, syncSource)
    })

    if (!input.skipRemoteSync && syncSource !== 'remote') {
        await syncInventoryRowsBestEffort([sourceRow, targetRow], input.workspaceId)
    }

    return {
        updatedProduct,
        timestamp,
        syncSource,
        sourcePreviousQuantity,
        targetPreviousQuantity
    }
}

function toReverseBatchSelections(
    allocations: InventoryTransferBatchAllocation[]
): StockBatchTransferSelection[] {
    return allocations.map((allocation) => ({
        batchId: allocation.destinationBatchId,
        quantity: allocation.quantity
    }))
}

export async function transferInventoryQuantityWithBatches(
    input: TransferInventoryQuantityInput
) {
    const {
        getStockBatchTransferPlan,
        refreshStockBatchesFromSupabase,
        transferStockBatchAllocations
    } = await import('./stockBatches')

    if (!input.skipBatchRefresh && (input.syncSource || 'local') === 'local') {
        await refreshStockBatchesFromSupabase(input.workspaceId)
    }

    const batchPlan = await getStockBatchTransferPlan(
        input.productId,
        input.sourceStorageId,
        input.quantity,
        input.batchSelections
    )
    const coreResult = await transferInventoryQuantityCore(input)
    let batchAllocations: InventoryTransferBatchAllocation[] = []

    try {
        batchAllocations = await transferStockBatchAllocations({
            workspaceId: input.workspaceId,
            productId: input.productId,
            sourceStorageId: input.sourceStorageId,
            targetStorageId: input.targetStorageId,
            allocations: batchPlan.batchAllocations,
            timestamp: coreResult.timestamp
        })
    } catch (error) {
        try {
            await transferInventoryQuantityCore({
                ...input,
                sourceStorageId: input.targetStorageId,
                targetStorageId: input.sourceStorageId,
                timestamp: new Date().toISOString(),
                referenceId: null,
                referenceType: null,
                notes: null
            })
        } catch (rollbackError) {
            console.error('[InventoryTransfer] Failed to rollback inventory quantity:', rollbackError)
        }
        throw error
    }

    try {
        if (!input.skipTransactionLog) {
            const referenceType = input.referenceType || 'transfer'
            await Promise.all([
                createInventoryTransaction(input.workspaceId, {
                    productId: input.productId,
                    storageId: input.sourceStorageId,
                    transactionType: 'transfer_out',
                    quantityDelta: -input.quantity,
                    previousQuantity: coreResult.sourcePreviousQuantity,
                    newQuantity: roundQuantity(Math.max(coreResult.sourcePreviousQuantity - input.quantity, 0)),
                    referenceId: input.referenceId ?? null,
                    referenceType,
                    notes: input.notes ?? null,
                    createdBy: input.createdBy ?? null
                }, { timestamp: coreResult.timestamp }),
                createInventoryTransaction(input.workspaceId, {
                    productId: input.productId,
                    storageId: input.targetStorageId,
                    transactionType: 'transfer_in',
                    quantityDelta: input.quantity,
                    previousQuantity: coreResult.targetPreviousQuantity,
                    newQuantity: roundQuantity(coreResult.targetPreviousQuantity + input.quantity),
                    referenceId: input.referenceId ?? null,
                    referenceType,
                    notes: input.notes ?? null,
                    createdBy: input.createdBy ?? null
                }, { timestamp: coreResult.timestamp })
            ])
        }
    } catch (error) {
        try {
            if (batchAllocations.length > 0) {
                await transferStockBatchAllocations({
                    workspaceId: input.workspaceId,
                    productId: input.productId,
                    sourceStorageId: input.targetStorageId,
                    targetStorageId: input.sourceStorageId,
                    allocations: batchAllocations.map((allocation) => ({
                        batchId: allocation.destinationBatchId,
                        batchNumber: allocation.batchNumber,
                        quantity: allocation.quantity,
                        price: allocation.price,
                        costPrice: allocation.costPrice,
                        currency: allocation.currency,
                        expiryDate: allocation.expiryDate,
                        manufacturingDate: allocation.manufacturingDate
                    })),
                    timestamp: new Date().toISOString()
                })
            }

            await transferInventoryQuantityCore({
                ...input,
                sourceStorageId: input.targetStorageId,
                targetStorageId: input.sourceStorageId,
                timestamp: new Date().toISOString(),
                referenceId: null,
                referenceType: null,
                notes: null
            })
        } catch (rollbackError) {
            console.error('[InventoryTransfer] Failed to rollback transfer after logging error:', rollbackError)
        }
        throw error
    }

    await evaluateReorderRulesIfNeeded({
        workspaceId: input.workspaceId,
        productId: input.productId,
        syncSource: coreResult.syncSource,
        skipReorderCheck: input.skipReorderCheck
    })

    return {
        updatedProduct: coreResult.updatedProduct,
        batchAllocations,
        reverseBatchSelections: toReverseBatchSelections(batchAllocations)
    }
}

export async function transferInventoryQuantity(input: TransferInventoryQuantityInput) {
    const result = await transferInventoryQuantityWithBatches(input)
    return result.updatedProduct
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

export function useInventory(workspaceId: string | undefined, options: UseInventoryOptions = {}) {
    const enabled = options.enabled ?? true
    const storageId = options.storageId?.trim()
    useInventoryCloudSync(workspaceId, { ...options, storageId })

    const inventory = useLiveQuery(
        () => {
            if (!enabled || !workspaceId) {
                return []
            }

            return storageId
                ? db.inventory.where('[workspaceId+storageId]').equals([workspaceId, storageId]).and((item) => !item.isDeleted).toArray()
                : db.inventory.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
        },
        [enabled, storageId, workspaceId]
    )

    return inventory ?? []
}

export function useInventoryProducts(workspaceId: string | undefined, options: UseInventoryOptions = {}) {
    const enabled = options.enabled ?? true
    const storageId = options.storageId?.trim()
    useInventoryCloudSync(workspaceId, { ...options, storageId })

    const products = useLiveQuery(async () => {
        if (!enabled || !workspaceId) {
            return []
        }

        const inventoryRows = storageId
            ? await db.inventory.where('[workspaceId+storageId]').equals([workspaceId, storageId]).and((item) => !item.isDeleted).toArray()
            : await db.inventory.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()

        const productIds = Array.from(new Set(inventoryRows.map((row) => row.productId)))
        const productRows = storageId
            ? (await db.products.bulkGet(productIds)).filter((product): product is Product =>
                !!product && product.workspaceId === workspaceId && !product.isDeleted
            )
            : await db.products.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()

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
    }, [enabled, storageId, workspaceId])

    return products ?? []
}
