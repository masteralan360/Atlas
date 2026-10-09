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
import { isAllowedInventoryQuantityTransition, isValidNewInventoryQuantity } from './inventoryDeficit'
import type {
  Inventory,
  InventoryTransaction,
  Product
} from './models'
import {
  buildInventoryMovementTransactionId,
  createInventoryTransaction,
  type InventoryTransactionInput
} from './inventoryTransactions'
import { syncProductBarcodeCachesForWorkspace } from './productBarcodes'
import { normalizeProductSku } from './productSku'
import {
    assertCurrentUserCanAccessStorage,
    assertRecentCurrentUserCanAccessStorage,
    canAccessStorage,
    useStorageAccess
} from './storagePermissions'
import type { StockBatchTransferSelection } from './stockBatches'

type InventorySyncSource = 'local' | 'remote'

export type InventoryMovementContext = Omit<
  InventoryTransactionInput,
  'quantityDelta' | 'previousQuantity' | 'newQuantity'
>

async function persistLocalInventoryMovement(input: {
  workspaceId: string
  productId: string
  storageId: string
  previousQuantity: number
  newQuantity: number
  inventoryVersion: number
  transactionId?: string
  movement: InventoryMovementContext
  timestamp: string
}) {
  const previousQuantity = roundQuantity(Math.max(0, input.previousQuantity))
  const newQuantity = roundQuantity(Math.max(0, input.newQuantity))
  const quantityDelta = roundQuantity(newQuantity - previousQuantity)
  if (Math.abs(quantityDelta) <= QUANTITY_EPSILON) return null

  return createInventoryTransaction(
    input.workspaceId,
    {
      ...input.movement,
      productId: input.productId,
      storageId: input.storageId,
      quantityDelta,
      previousQuantity,
      newQuantity,
    },
    {
      id: input.transactionId ?? buildInventoryMovementTransactionId(
          input.workspaceId,
          input.productId,
          input.storageId,
          input.inventoryVersion,
        ),
      timestamp: input.timestamp,
      skipRemoteSync: true,
    },
  )
}

export type InventoryProduct = Product & {
    inventoryId: string
    inventoryQuantity: number
    storageId: string
}

const INVENTORY_FETCH_PAGE_SIZE = 1000
const INVENTORY_PRODUCT_FETCH_CHUNK_SIZE = 500
const INVENTORY_CONFLICT_COOLDOWN_MS = 5000
const inventoryWorkspaceFetchesInFlight = new Map<string, Promise<boolean>>()
type InventorySnapshotConflictReason = 'inventory_version' | 'sales_order_version'
type InventorySnapshotConflictCooldown = {
    until: number
    reason: InventorySnapshotConflictReason
}
const inventorySnapshotConflictCooldowns = new Map<string, InventorySnapshotConflictCooldown>()

export interface InventoryWorkspaceFetchOptions {
    storageId?: string
    includeProducts?: boolean
}

export interface UseInventoryOptions extends InventoryWorkspaceFetchOptions {
    syncRemote?: boolean
    enabled?: boolean
}

export interface InventorySnapshotExpectedVersion {
    productId: string
    storageId: string
    version: number
}

export interface InventorySnapshotSyncOptions {
  operationId?: string
  operationKind?: string
  expectedVersions?: ReadonlyArray<InventorySnapshotExpectedVersion>
  inventoryTransactions?: ReadonlyArray<InventoryTransaction>
  salesOrderCompletion?: {
        orderId: string
        expectedOrderVersion: number
        items: unknown[]
        actualDeliveryDate: string | null
    }
}

export interface InventoryPositionHydrationOptions {
    /**
     * Critical write paths in Cloud and Hybrid workspaces must not proceed
     * from a potentially stale local snapshot when the server read fails.
     */
    requireAuthoritative?: boolean
}

export class InventorySnapshotConflictError extends Error {
    readonly retryAfterMs: number
    readonly conflictReason: InventorySnapshotConflictReason

    constructor(
        retryAfterMs = INVENTORY_CONFLICT_COOLDOWN_MS,
        conflictReason: InventorySnapshotConflictReason = 'inventory_version'
    ) {
        super(i18n.t(
            conflictReason === 'sales_order_version'
                ? 'inventory.errors.orderChanged'
                : 'inventory.errors.stockChanged'
        ))
        this.name = 'InventorySnapshotConflictError'
        this.retryAfterMs = Math.max(0, Math.trunc(Number(retryAfterMs) || 0))
        this.conflictReason = conflictReason
    }
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
    storageIds: string[],
    options: InventoryPositionHydrationOptions = {}
) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return [] as Inventory[]
    }

    if (!isOnline(workspaceId)) {
        if (options.requireAuthoritative) {
            throw new Error(i18n.t('inventory.errors.onlineRequired'))
        }
        return [] as Inventory[]
    }

    const normalizedStorageIds = Array.from(new Set(storageIds.filter(Boolean)))
    if (normalizedStorageIds.length === 0) {
        return [] as Inventory[]
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
        : client
            .from('inventory')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('product_id', productId)
            .in('storage_id', normalizedStorageIds)

    const { data: remoteRows, error } = await runSupabaseAction('inventory.position.fetch', () => query)
    if (error || !remoteRows) {
        if (options.requireAuthoritative) {
            throw new Error(i18n.t('inventory.errors.authoritativeReadFailed'))
        }
        return [] as Inventory[]
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

    return normalizedRemoteRows
}

export async function syncInventoryRowsBestEffort(
    rows: Array<Inventory | null>,
    workspaceId: string,
    options: InventorySnapshotSyncOptions = {}
) {
    const dedupedRows = Array.from(
        new Map(rows.filter((row): row is Inventory => !!row).map((row) => [
            buildInventoryPositionKey(row.workspaceId, row.productId, row.storageId),
            row
        ])).values()
    )

    if ((dedupedRows.length === 0 && !options.salesOrderCompletion) || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    assertInventoryMutationConnectivity(workspaceId)

    const expectedVersions = new Map(
        (options.expectedVersions ?? []).map(({ productId, storageId, version }) => [
            buildInventoryPositionKey(workspaceId, productId, storageId),
            Math.max(0, Math.trunc(Number(version) || 0))
        ])
    )
    const operationId = options.operationId ?? generateId()
    const operationKind = options.operationKind ?? 'client_snapshot_cas'
    const conflictKey = `${workspaceId}:${operationKind}:${operationId}`
    const conflictCooldown = inventorySnapshotConflictCooldowns.get(conflictKey)
    if (conflictCooldown && conflictCooldown.until > Date.now()) {
        throw new InventorySnapshotConflictError(
            conflictCooldown.until - Date.now(),
            conflictCooldown.reason
        )
    }
    inventorySnapshotConflictCooldowns.delete(conflictKey)
    const movementsByPosition = new Map(
        (options.inventoryTransactions ?? []).map((transaction) => [
            buildInventoryPositionKey(workspaceId, transaction.productId, transaction.storageId),
            transaction
        ])
    )
    const changes = dedupedRows.map((row) => {
        const movement = movementsByPosition.get(
            buildInventoryPositionKey(workspaceId, row.productId, row.storageId)
        )
        return {
            id: row.id,
            product_id: row.productId,
            storage_id: row.storageId,
            quantity: row.quantity,
            expected_version: expectedVersions.get(
                buildInventoryPositionKey(workspaceId, row.productId, row.storageId)
            ) ?? Math.max(0, Number(row.version || 1) - 1),
            audit_transaction_type: movement?.transactionType ?? null,
            audit_reference_id: movement?.referenceId ?? null,
            audit_reference_type: movement?.referenceType ?? null,
            audit_notes: movement?.notes ?? null,
            audit_created_by: movement?.createdBy ?? null,
        }
    })
    const client = getSupabaseClientForTable('inventory')
    const execute = () => runSupabaseAction(
        options.salesOrderCompletion
            ? 'orders.complete.inventory.authoritative'
            : 'inventory.sync.authoritative',
        () => options.salesOrderCompletion
            ? client.rpc('complete_sales_order_with_inventory', {
                p_order_id: options.salesOrderCompletion.orderId,
                p_workspace_id: workspaceId,
                p_expected_order_version: options.salesOrderCompletion.expectedOrderVersion,
                p_operation_id: operationId,
                p_items: options.salesOrderCompletion.items,
                p_actual_delivery_date: options.salesOrderCompletion.actualDeliveryDate,
                p_changes: changes
            })
            : client.rpc('apply_inventory_snapshot_changes', {
                p_operation_id: operationId,
                p_workspace_id: workspaceId,
                p_operation_kind: operationKind,
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
        if ((response.error as { code?: string }).code === '40001') {
            const conflictReason: InventorySnapshotConflictReason = (
                (response.error as { message?: string }).message ?? ''
            ).includes('Sales order changed on another device')
                ? 'sales_order_version'
                : 'inventory_version'
            inventorySnapshotConflictCooldowns.set(conflictKey, {
                until: Date.now() + INVENTORY_CONFLICT_COOLDOWN_MS,
                reason: conflictReason
            })
            throw new InventorySnapshotConflictError(INVENTORY_CONFLICT_COOLDOWN_MS, conflictReason)
        }
        throw normalizeSupabaseActionError(response.error)
    }

    const result = response.data as {
        inventory?: Record<string, unknown>[] | null
        inventory_transactions?: Record<string, unknown>[] | null
        order?: Record<string, unknown> | null
        conflict?: boolean
        conflict_reason?: string
        retry_after_ms?: number
    } | null
    if (result?.conflict) {
        const parsedRetryAfterMs = Number(result.retry_after_ms)
        const retryAfterMs = Number.isFinite(parsedRetryAfterMs)
            ? Math.max(0, Math.trunc(parsedRetryAfterMs))
            : INVENTORY_CONFLICT_COOLDOWN_MS
        const conflictReason: InventorySnapshotConflictReason = result.conflict_reason === 'sales_order_version'
            ? 'sales_order_version'
            : 'inventory_version'
        inventorySnapshotConflictCooldowns.set(conflictKey, {
            until: Date.now() + retryAfterMs,
            reason: conflictReason
        })
        throw new InventorySnapshotConflictError(retryAfterMs, conflictReason)
    }

    const remoteRows = result?.inventory
    if (!remoteRows) {
        throw new Error(i18n.t('inventory.errors.authoritativeResultMissing'))
    }
    inventorySnapshotConflictCooldowns.delete(conflictKey)

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

    const remoteTransactions = result?.inventory_transactions ?? []
    if (remoteTransactions.length > 0) {
        await db.inventory_transactions.bulkPut(remoteTransactions.map((row) => ({
            ...(toCamelCase(row) as unknown as InventoryTransaction),
            syncStatus: 'synced' as const,
            lastSyncedAt: syncedAt,
        })))
    }

    if (options.salesOrderCompletion) {
        if (!result?.order || !remoteTransactions) {
            throw new Error(i18n.t('inventory.errors.authoritativeResultMissing'))
        }

        return { order: result.order }
    }

    return { inventoryTransactions: remoteTransactions }
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

function isLocalRowNewerThanSnapshot(
    localRow: Record<string, unknown> | undefined,
    remoteRow: Record<string, unknown> | undefined,
    fetchedAt: string,
) {
    if (!localRow) return false
    if (localRow.syncStatus && localRow.syncStatus !== 'synced') return true

    const localVersion = Number(localRow.version)
    const remoteVersion = Number(remoteRow?.version)
    if (Number.isFinite(localVersion) && Number.isFinite(remoteVersion)) {
        if (localVersion > remoteVersion) return true
        if (localVersion < remoteVersion) return false
    }

    const localTimestamp = Date.parse(String(localRow.lastSyncedAt ?? localRow.updatedAt ?? ''))
    return Number.isFinite(localTimestamp) && localTimestamp > Date.parse(fetchedAt)
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
): Promise<boolean> {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return true
    }

    const storageId = options.storageId?.trim()
    const includeProducts = options.includeProducts !== false
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
                includeProducts
                    ? await fetchProductsForInventoryRows(workspaceId, inventoryRows, { storageId })
                    : []
            ] as const
        })()
        : await Promise.all([
            fetchPagedWorkspaceRows('inventory', workspaceId),
            includeProducts
                ? fetchProductsForInventoryRows(workspaceId, [], {})
                : Promise.resolve([] as Record<string, unknown>[])
        ])

    if (!remoteInventory) {
        return false
    }

    if (!remoteProducts) {
        return false
    }

    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return true
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
    let productsChanged = false

    const differsFromRemote = (localRow: Record<string, unknown> | undefined, remoteRow: Record<string, unknown>) => {
        if (!localRow) return true
        return Object.entries(remoteRow).some(([key, value]) => {
            if (key === 'syncStatus' || key === 'lastSyncedAt') return false
            return JSON.stringify(localRow[key]) !== JSON.stringify(value)
        })
    }

    const reconcileLocalRows = async () => {
        const remoteInventoryIds = new Set(normalizedRemoteInventory.map((item) => item.id))
        const remoteProductIds = new Set(normalizedRemoteProducts.map((item) => item.id))

        const localInventoryRows = storageId
            ? await db.inventory.where('[workspaceId+storageId]').equals([workspaceId, storageId]).toArray()
            : await db.inventory.where('workspaceId').equals(workspaceId).toArray()

        const staleInventoryIds = localInventoryRows
            .filter((localRow) => (
                !remoteInventoryIds.has(localRow.id)
                && localRow.syncStatus === 'synced'
                && !isLocalRowNewerThanSnapshot(
                    localRow as unknown as Record<string, unknown>,
                    undefined,
                    fetchedAt,
                )
            ))
            .map((localRow) => {
                affectedProductIds.add(localRow.productId)
                return localRow.id
            })

        if (staleInventoryIds.length > 0) {
            await db.inventory.bulkDelete(staleInventoryIds)
        }

        if (!storageId && includeProducts) {
            const localProducts = await db.products.where('workspaceId').equals(workspaceId).toArray()
            const staleProductIds = localProducts
                .filter((localProduct) => (
                    !remoteProductIds.has(localProduct.id)
                    && localProduct.syncStatus === 'synced'
                    && !isLocalRowNewerThanSnapshot(
                        localProduct as unknown as Record<string, unknown>,
                        undefined,
                        fetchedAt,
                    )
                ))
                .map((localProduct) => localProduct.id)

            if (staleProductIds.length > 0) {
                await db.products.bulkDelete(staleProductIds)
                productsChanged = true
            }
        }

        if (includeProducts && normalizedRemoteProducts.length > 0) {
            const localProducts = await db.products.bulkGet(normalizedRemoteProducts.map((item) => item.id))
            const changedProducts = normalizedRemoteProducts.filter((remoteProduct, index) =>
                !isLocalRowNewerThanSnapshot(
                    localProducts[index] as unknown as Record<string, unknown> | undefined,
                    remoteProduct as unknown as Record<string, unknown>,
                    fetchedAt,
                )
                && differsFromRemote(
                    localProducts[index] as unknown as Record<string, unknown> | undefined,
                    remoteProduct as unknown as Record<string, unknown>,
                )
            )
            productsChanged = changedProducts.length > 0
            if (productsChanged) {
                await db.products.bulkPut(changedProducts)
            }
        }

        if (normalizedRemoteInventory.length > 0) {
            const localInventory = await db.inventory.bulkGet(normalizedRemoteInventory.map((item) => item.id))
            const changedInventory = normalizedRemoteInventory.filter((remoteRow, index) => {
                const localRow = localInventory[index] as unknown as Record<string, unknown> | undefined
                if (isLocalRowNewerThanSnapshot(
                    localRow,
                    remoteRow as unknown as Record<string, unknown>,
                    fetchedAt,
                )) return false

                const changed = differsFromRemote(
                    localRow,
                    remoteRow as unknown as Record<string, unknown>,
                )
                if (changed) affectedProductIds.add(remoteRow.productId)
                return changed
            })
            if (changedInventory.length > 0) {
                await db.inventory.bulkPut(changedInventory)
            }
        }
    }

    if (includeProducts) {
        await db.transaction('rw', [db.inventory, db.products], reconcileLocalRows)
    } else {
        await db.transaction('rw', db.inventory, reconcileLocalRows)
    }

    // A scoped storage fetch only contains a partial inventory view. Avoid updating
    // product.quantity snapshots from partial data.
    if (storageId) {
        return true
    }

    const affectedIds = Array.from(affectedProductIds)
    for (let index = 0; index < affectedIds.length; index += 100) {
        const chunk = affectedIds.slice(index, index + 100)
        await Promise.all(chunk.map((productId) =>
            syncProductStockSnapshot(productId, fetchedAt, 'remote')
        ))
    }

    if (productsChanged) {
        await syncProductBarcodeCachesForWorkspace(workspaceId)
    }

    if (affectedIds.length > 0) {
        const { evaluateReorderTransferRulesForProduct } = await import('./reorderTransferRules')
        for (let index = 0; index < affectedIds.length; index += 100) {
            const chunk = affectedIds.slice(index, index + 100)
            await Promise.all(chunk.map((productId) =>
                evaluateReorderTransferRulesForProduct(workspaceId, productId)
            ))
        }
    }

    return true
}

export async function fetchInventoryWorkspaceFromSupabase(
    workspaceId: string,
    options: InventoryWorkspaceFetchOptions = {}
): Promise<boolean> {
    if (!workspaceId) {
        return true
    }

    const storageId = options.storageId?.trim()
    const includeProducts = options.includeProducts !== false
    const key = `${workspaceId}:${storageId || 'all'}:products=${includeProducts}`
    const existing = inventoryWorkspaceFetchesInFlight.get(key)
    if (existing) {
        return existing
    }

    const request = (async () => {
        if (!await canReconcileCloudWorkspaceData(workspaceId)) {
            return true
        }
        return fetchInventoryWorkspaceFromSupabaseInternal(workspaceId, { storageId, includeProducts })
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
                await fetchInventoryWorkspaceFromSupabase(workspaceId, { storageId, includeProducts: options.includeProducts })
            }
        }

        void syncFromSupabase()
    }, [enabled, online, storageId, syncRemote, workspaceId])
}

async function getInventoryRowsForProductStorage(productId: string, storageId: string) {
    return db.inventory.where('[productId+storageId]').equals([productId, storageId]).toArray()
}

export async function getInventoryVersionForProductStorage(productId: string, storageId: string) {
    const rows = await getInventoryRowsForProductStorage(productId, storageId)
    const existingRow = rows.find((row) => !row.isDeleted) ?? rows.find((row) => row.isDeleted)
    return Math.max(0, Math.trunc(Number(existingRow?.version) || 0))
}

export async function putInventoryQuantity(
    workspaceId: string,
    productId: string,
    storageId: string,
    quantity: number,
    timestamp: string,
    syncSource: InventorySyncSource = 'local',
    options: { storageAccessPrevalidated?: boolean } = {}
) {
    if (syncSource === 'local') {
        assertInventoryMutationConnectivity(workspaceId)
        if (!options.storageAccessPrevalidated && !assertRecentCurrentUserCanAccessStorage(workspaceId, storageId)) {
            await assertCurrentUserCanAccessStorage(workspaceId, storageId)
        }
    }
    const rows = await getInventoryRowsForProductStorage(productId, storageId)
    const activeRow = rows.find((row) => !row.isDeleted)
    const restorableRow = rows.find((row) => row.isDeleted)
    const previousQuantity = activeRow?.quantity ?? restorableRow?.quantity ?? null
    if (!isAllowedInventoryQuantityTransition(previousQuantity, quantity)) {
        throw new Error(i18n.t('inventory.errors.negativeQuantity'))
    }
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
        if (input.storageId) {
            await assertCurrentUserCanAccessStorage(input.workspaceId, input.storageId)
        }
    }
    const changedRows: Array<Inventory | null> = []
    const movements: InventoryTransaction[] = []

    const updatedProduct = await db.transaction('rw', [db.inventory, db.inventory_transactions, db.products, db.storages], async () => {
        const activeRows = await getInventoryRowsForProduct(input.productId)

        const recordOpeningStock = async (
            storageId: string,
            previousQuantity: number,
            newQuantity: number,
            row: Inventory | null,
        ) => {
            if (
                syncSource === 'remote'
                || !row
                || Math.abs(newQuantity - previousQuantity) <= QUANTITY_EPSILON
            ) return
            const movement = await persistLocalInventoryMovement({
                workspaceId: input.workspaceId,
                productId: input.productId,
                storageId,
                previousQuantity,
                newQuantity,
                inventoryVersion: row.version,
                movement: {
                    productId: input.productId,
                    storageId,
                    transactionType: 'initial_stock',
                    referenceId: input.productId,
                    referenceType: 'product_initial_stock',
                },
                timestamp,
            })
            if (movement) movements.push(movement)
        }

        if (activeRows.length > 1) {
            return syncProductStockSnapshot(input.productId, timestamp, syncSource)
        }

        if (!input.storageId) {
            if (activeRows.length === 1) {
                const current = activeRows[0]
                const changedRow = await putInventoryQuantity(
                    input.workspaceId,
                    input.productId,
                    current.storageId,
                    input.quantity,
                    timestamp,
                    syncSource
                )
                changedRows.push(changedRow)
                await recordOpeningStock(current.storageId, current.quantity, input.quantity, changedRow)
            }

            return syncProductStockSnapshot(input.productId, timestamp, syncSource)
        }

        if (activeRows.length === 0) {
            const changedRow = await putInventoryQuantity(
                input.workspaceId,
                input.productId,
                input.storageId,
                input.quantity,
                timestamp,
                syncSource
            )
            changedRows.push(changedRow)
            await recordOpeningStock(input.storageId, 0, input.quantity, changedRow)
            return syncProductStockSnapshot(input.productId, timestamp, syncSource)
        }

        const currentRow = activeRows[0]
        if (currentRow.storageId === input.storageId) {
            const changedRow = await putInventoryQuantity(
                input.workspaceId,
                input.productId,
                input.storageId,
                input.quantity,
                timestamp,
                syncSource
            )
            changedRows.push(changedRow)
            await recordOpeningStock(input.storageId, currentRow.quantity, input.quantity, changedRow)
            return syncProductStockSnapshot(input.productId, timestamp, syncSource)
        }

        const sourceRow = await putInventoryQuantity(
            input.workspaceId,
            input.productId,
            currentRow.storageId,
            0,
            timestamp,
            syncSource,
        )
        const targetRow = await putInventoryQuantity(
            input.workspaceId,
            input.productId,
            input.storageId,
            input.quantity,
            timestamp,
            syncSource,
        )
        changedRows.push(sourceRow, targetRow)
        if (syncSource !== 'remote') {
            const transferReferenceId = generateId()
            const sourceMovement = sourceRow && isPositiveQuantity(currentRow.quantity)
                ? await persistLocalInventoryMovement({
                    workspaceId: input.workspaceId,
                    productId: input.productId,
                    storageId: currentRow.storageId,
                    previousQuantity: currentRow.quantity,
                    newQuantity: 0,
                    inventoryVersion: sourceRow.version,
                    movement: {
                        productId: input.productId,
                        storageId: currentRow.storageId,
                        transactionType: 'transfer_out',
                        referenceId: transferReferenceId,
                        referenceType: 'product_storage_reassignment',
                    },
                    timestamp,
                })
                : null
            const targetMovement = targetRow && isPositiveQuantity(input.quantity)
                ? await persistLocalInventoryMovement({
                    workspaceId: input.workspaceId,
                    productId: input.productId,
                    storageId: input.storageId,
                    previousQuantity: 0,
                    newQuantity: input.quantity,
                    inventoryVersion: targetRow.version,
                    movement: {
                        productId: input.productId,
                        storageId: input.storageId,
                        transactionType: isPositiveQuantity(currentRow.quantity) ? 'transfer_in' : 'initial_stock',
                        referenceId: transferReferenceId,
                        referenceType: isPositiveQuantity(currentRow.quantity)
                            ? 'product_storage_reassignment'
                            : 'product_initial_stock',
                    },
                    timestamp,
                })
                : null
            if (sourceMovement) movements.push(sourceMovement)
            if (targetMovement) movements.push(targetMovement)
        }
        return syncProductStockSnapshot(input.productId, timestamp, syncSource)
    })

    if (!input.skipRemoteSync && syncSource !== 'remote') {
        await syncInventoryRowsBestEffort(changedRows, input.workspaceId, {
            ...(movements.length > 0 ? {
                operationId: movements[0].id,
                operationKind: 'inventory_movement',
                inventoryTransactions: movements,
            } : {}),
        })
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
    storageAccessPrevalidated?: boolean
    movementTransactionId?: string
    movement: InventoryMovementContext | null
}) {
    const timestamp = input.timestamp || new Date().toISOString()
    const syncSource = input.syncSource || 'local'
    if (!Number.isFinite(input.quantityDelta)) {
        throw new Error(i18n.t('inventory.errors.invalidQuantity'))
    }
    if (syncSource === 'local') {
        assertInventoryMutationConnectivity(input.workspaceId)
    }
    if (syncSource === 'local' && !input.skipRemoteHydration) {
        await hydrateInventoryProductStoragesFromSupabase(input.workspaceId, input.productId, [input.storageId])
    }

    // Local staff permission checks in putInventoryQuantity read these mirrors
    // within this transaction; all of their stores must be in its scope.
    const {
        updatedProduct,
        changedRow,
        localMovement,
        previousQuantity,
        nextQuantity,
    } = await db.transaction('rw', [
        db.inventory, db.products, db.storages, db.inventory_transactions,
        ...(isLocalWorkspaceMode(input.workspaceId)
            ? [db.users, db.profiles, db.storage_member_exclusions]
            : [])
    ], async () => {
        const currentQuantity = await getInventoryQuantityForProductStorage(input.productId, input.storageId)
        const computedNextQuantity = roundQuantity(currentQuantity + input.quantityDelta)

        if (computedNextQuantity < 0) {
            throw new Error('Insufficient inventory')
        }

        const changedRow = await putInventoryQuantity(
            input.workspaceId,
            input.productId,
            input.storageId,
            computedNextQuantity,
            timestamp,
            syncSource,
            { storageAccessPrevalidated: input.storageAccessPrevalidated }
        )

        let localMovement: InventoryTransaction | null = null
        if (
            input.movement
            && changedRow
            && syncSource !== 'remote'
            && isLocalWorkspaceMode(input.workspaceId)
        ) {
            localMovement = await persistLocalInventoryMovement({
                workspaceId: input.workspaceId,
                productId: input.productId,
                storageId: input.storageId,
                previousQuantity: currentQuantity,
                newQuantity: computedNextQuantity,
                inventoryVersion: changedRow.version,
                transactionId: input.movementTransactionId,
                movement: input.movement,
                timestamp,
            })
        }

        const updatedProduct = await syncProductStockSnapshot(input.productId, timestamp, syncSource)
        return {
            updatedProduct,
            changedRow,
            localMovement,
            previousQuantity: currentQuantity,
            nextQuantity: computedNextQuantity,
        }
    })

    if (!input.skipRemoteSync && syncSource !== 'remote') {
        try {
            const movementTransaction = input.movement && changedRow
                ? localMovement ?? {
                    id: buildInventoryMovementTransactionId(
                        input.workspaceId,
                        input.productId,
                        input.storageId,
                        changedRow.version,
                    ),
                    workspaceId: input.workspaceId,
                    ...input.movement,
                    productId: input.productId,
                    storageId: input.storageId,
                    quantityDelta: roundQuantity(nextQuantity - previousQuantity),
                    previousQuantity,
                    newQuantity: nextQuantity,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    version: 1,
                    isDeleted: false,
                    syncStatus: 'pending' as const,
                    lastSyncedAt: null,
                }
                : null

            await syncInventoryRowsBestEffort([changedRow], input.workspaceId, {
                ...(movementTransaction ? {
                    operationId: movementTransaction.id,
                    operationKind: 'inventory_movement',
                    inventoryTransactions: [movementTransaction],
                } : {}),
            })
        } catch (error) {
            if (localMovement) {
                await db.inventory_transactions.delete(localMovement.id)
            }
            throw error
        }
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
    transferType?: 'manual' | 'automation'
    reorderRuleId?: string | null
    operationId?: string | null
    timestamp?: string
    syncSource?: InventorySyncSource
    skipRemoteSync?: boolean
    skipBatchRefresh?: boolean
    skipReorderCheck?: boolean
    skipTransactionLog?: boolean
}

export async function transferInventoryQuantityWithBatches(
    input: TransferInventoryQuantityInput
) {
    const { createInventoryTransferBatch } = await import('./inventoryTransferBatches')
    const result = await createInventoryTransferBatch({
        workspaceId: input.workspaceId,
        sourceStorageId: input.sourceStorageId,
        destinationStorageId: input.targetStorageId,
        items: [{
            productId: input.productId,
            quantity: input.quantity,
            batchSelections: input.batchSelections
        }],
        transferType: input.transferType ?? 'manual',
        reorderRuleId: input.reorderRuleId ?? null,
        referenceType: input.referenceType || 'inventory_transfer',
        notes: input.notes ?? null,
        createdBy: input.createdBy ?? null,
        transferredAt: input.timestamp
    })

    const item = result.items[0]
    try {
        await evaluateReorderRulesIfNeeded({
            workspaceId: input.workspaceId,
            productId: input.productId,
            syncSource: 'local',
            skipReorderCheck: input.skipReorderCheck
        })
    } catch (error) {
        console.error('[InventoryTransfer] Failed to evaluate reorder rules after transfer:', error)
    }

    return {
        updatedProduct: await db.products.get(input.productId) ?? null,
        referenceId: result.batch.id,
        transferBatchId: result.batch.id,
        transferNumber: result.batch.transferNumber,
        batchAllocations: item?.batchAllocations ?? [],
        reverseBatchSelections: item?.reverseBatchSelections ?? []
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

    const localMovements: InventoryTransaction[] = []
    await db.transaction('rw', [db.inventory, db.inventory_transactions], async () => {
        for (const row of deletedRows) {
            await db.inventory.put(row)
            if (syncSource !== 'remote' && isLocalWorkspaceMode(product.workspaceId)) {
                const movement = await persistLocalInventoryMovement({
                    workspaceId: product.workspaceId,
                    productId: row.productId,
                    storageId: row.storageId,
                    previousQuantity: Math.max(0, rows.find((previous) => previous.id === row.id)?.quantity ?? 0),
                    newQuantity: 0,
                    inventoryVersion: row.version,
                    movement: {
                        productId: row.productId,
                        storageId: row.storageId,
                        transactionType: 'inventory_change',
                        referenceId: productId,
                        referenceType: 'product_archive',
                        notes: null,
                        createdBy: null
                    },
                    timestamp
                })
                if (movement) localMovements.push(movement)
            }
        }
    })

    if (!options?.skipRemoteSync && syncSource !== 'remote') {
        const movements = deletedRows.map((row) => {
            const previousQuantity = Math.max(0, rows.find((previous) => previous.id === row.id)?.quantity ?? 0)
            return {
                id: buildInventoryMovementTransactionId(
                    product.workspaceId,
                    row.productId,
                    row.storageId,
                    row.version,
                ),
                workspaceId: product.workspaceId,
                productId: row.productId,
                storageId: row.storageId,
                transactionType: 'inventory_change' as const,
                quantityDelta: roundQuantity(-previousQuantity),
                previousQuantity,
                newQuantity: 0,
                adjustmentReason: null,
                referenceId: productId,
                referenceType: 'product_archive',
                notes: null,
                createdBy: null,
                createdAt: timestamp,
                updatedAt: timestamp,
                version: 1,
                isDeleted: false,
                syncStatus: 'pending' as const,
                lastSyncedAt: null,
            }
        }).filter((movement) => Math.abs(movement.quantityDelta) > QUANTITY_EPSILON)
        await syncInventoryRowsBestEffort(deletedRows, product.workspaceId, {
            ...(movements.length > 0 ? {
                operationId: generateId(),
                operationKind: 'product_archive',
                inventoryTransactions: localMovements.length > 0 ? localMovements : movements,
            } : {}),
        })
    }
}

export function useInventory(workspaceId: string | undefined, options: UseInventoryOptions = {}) {
    const enabled = options.enabled ?? true
    const storageId = options.storageId?.trim()
    const storageAccess = useStorageAccess(workspaceId)
    useInventoryCloudSync(workspaceId, { ...options, storageId })

    const inventory = useLiveQuery(
        async () => {
            if (!enabled || !workspaceId) {
                return []
            }

            const rows = await (storageId
                ? db.inventory.where('[workspaceId+storageId]').equals([workspaceId, storageId]).and((item) => !item.isDeleted).toArray()
                : db.inventory.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray())
            return rows.filter((row) => canAccessStorage(row.storageId, storageAccess))
        },
        [enabled, storageAccess.signature, storageId, workspaceId]
    )

    return inventory ?? []
}

export function useInventoryProducts(workspaceId: string | undefined, options: UseInventoryOptions = {}) {
    const enabled = options.enabled ?? true
    const storageId = options.storageId?.trim()
    const storageAccess = useStorageAccess(workspaceId)
    useInventoryCloudSync(workspaceId, { ...options, storageId })

    const products = useLiveQuery(async () => {
        if (!enabled || !workspaceId) {
            return []
        }

        const inventoryRows = (storageId
            ? await db.inventory.where('[workspaceId+storageId]').equals([workspaceId, storageId]).and((item) => !item.isDeleted).toArray()
            : await db.inventory.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray())
            .filter((row) => canAccessStorage(row.storageId, storageAccess))

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
    }, [enabled, storageAccess.signature, storageId, workspaceId])

    return products ?? []
}
