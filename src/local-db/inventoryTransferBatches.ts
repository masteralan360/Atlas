import { getActiveBusinessUserId } from '@/lib/network'
import { QUANTITY_EPSILON, isPositiveQuantity, roundQuantity } from '@/lib/quantity'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isRetriableWebRequestError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isDemoWorkspaceMode, isHybridWorkspaceMode, isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { getLocalModeSqliteConnection } from './localModeSqlite'

import { db } from './database'
import {
  assertCurrentUserCanAccessStorage,
} from './storagePermissions'
import {
  assertInventoryMutationConnectivity,
  hydrateInventoryProductStoragesFromSupabase,
  syncProductStockSnapshot,
} from './inventory'
import { buildInventoryMovementTransactionId } from './inventoryTransactions'
import {
  planStockBatchTransfer,
  refreshStockBatchesFromSupabase,
  type StockBatchTransferSelection,
} from './stockBatches'
import type {
  Inventory,
  InventoryTransaction,
  InventoryTransferBatch,
  InventoryTransferBatchAllocation,
  InventoryTransferTransaction,
  InventoryTransferTransactionType,
  Product,
  StockBatchAllocation,
  StockBatch,
} from './models'

export interface InventoryTransferBatchItemInput {
  productId: string
  quantity: number
  batchSelections?: StockBatchTransferSelection[]
}

export interface CreateInventoryTransferBatchInput {
  workspaceId: string
  batchId?: string
  sourceStorageId: string
  destinationStorageId: string
  items: InventoryTransferBatchItemInput[]
  sourceWorkspaceId?: string
  destinationWorkspaceId?: string
  sourceWorkspaceName?: string | null
  destinationWorkspaceName?: string | null
  transferType?: InventoryTransferTransactionType
  reorderRuleId?: string | null
  referenceType?: string | null
  notes?: string | null
  createdBy?: string | null
  transferredAt?: string
}

export interface InventoryTransferBatchItemResult {
  productId: string
  quantity: number
  batchAllocations: InventoryTransferBatchAllocation[]
  reverseBatchSelections: StockBatchTransferSelection[]
}

export interface InventoryTransferBatchResult {
  batch: InventoryTransferBatch
  items: InventoryTransferBatchItemResult[]
  movedCount: number
}

export interface InventoryTransferBatchHistoryItem {
  batch: InventoryTransferBatch
  productCount: number
  performedByName: string | null
  sourceIsBranch: boolean
  destinationIsBranch: boolean
}

export interface InventoryTransferBatchProductLine {
  transactionId: string
  productId: string
  productName: string
  sku: string
  quantity: number
  unit: string
  batchAllocations: InventoryTransferBatchAllocation[]
}

export interface InventoryTransferBatchDetails extends InventoryTransferBatchHistoryItem {
  products: InventoryTransferBatchProductLine[]
}

export interface InventoryTransferBatchHistoryQuery {
  workspaceId: string
  search?: string
  from?: string | null
  to?: string | null
  page: number
  pageSize: number
}

export interface InventoryTransferBatchHistoryPage {
  rows: InventoryTransferBatchHistoryItem[]
  totalCount: number
}

type LocalPayloadRow = { payload: string; product_count?: number | string }

function parseLocalPayload<T>(value: string | null | undefined): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function historyBounds(query: InventoryTransferBatchHistoryQuery) {
  const offset = (Math.max(1, Math.trunc(query.page)) - 1) * Math.min(100, Math.max(1, Math.trunc(query.pageSize)))
  const limit = Math.min(100, Math.max(1, Math.trunc(query.pageSize)))
  return { offset, limit }
}

function localSqliteSearch(query: InventoryTransferBatchHistoryQuery) {
  const predicates = [
    "b.entity_type = 'inventory_transfer_batches'",
    'b.workspace_id = $1',
    "COALESCE(json_extract(b.payload, '$.isDeleted'), 0) = 0",
  ]
  const params: unknown[] = [query.workspaceId]
  if (query.from) {
    params.push(query.from)
    predicates.push(`json_extract(b.payload, '$.transferredAt') >= $${params.length}`)
  }
  if (query.to) {
    params.push(query.to)
    predicates.push(`json_extract(b.payload, '$.transferredAt') < $${params.length}`)
  }
  const search = query.search?.trim()
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`)
    const searchParameter = `$${params.length}`
    predicates.push(`(
      json_extract(b.payload, '$.transferNumber') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
      OR json_extract(b.payload, '$.sourceWorkspaceName') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
      OR json_extract(b.payload, '$.sourceStorageName') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
      OR json_extract(b.payload, '$.destinationWorkspaceName') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
      OR json_extract(b.payload, '$.destinationStorageName') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
      OR EXISTS (
        SELECT 1 FROM local_entities actor
        WHERE actor.entity_type IN ('profiles', 'users')
          AND actor.entity_id = json_extract(b.payload, '$.performedBy')
          AND json_extract(actor.payload, '$.name') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
      )
      OR EXISTS (
        SELECT 1
        FROM local_entities tx
        JOIN local_entities product
          ON product.entity_type = 'products'
          AND product.entity_id = json_extract(tx.payload, '$.productId')
        WHERE tx.entity_type = 'inventory_transactions'
          AND json_extract(tx.payload, '$.transferBatchId') = b.entity_id
          AND COALESCE(json_extract(tx.payload, '$.isDeleted'), 0) = 0
          AND (
            json_extract(product.payload, '$.name') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
            OR json_extract(product.payload, '$.sku') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
            OR
            json_extract(product.payload, '$.barcode') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
            OR EXISTS (
              SELECT 1 FROM json_each(product.payload, '$.barcodes') AS product_barcode
              WHERE CAST(product_barcode.value AS TEXT) LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
            )
            OR EXISTS (
              SELECT 1 FROM local_entities barcode
              WHERE barcode.entity_type = 'product_barcodes'
                AND json_extract(barcode.payload, '$.productId') = json_extract(tx.payload, '$.productId')
                AND json_extract(barcode.payload, '$.barcode') LIKE ${searchParameter} ESCAPE '\\' COLLATE NOCASE
            )
          )
      )
    )`)
  }
  return { where: predicates.join(' AND '), params }
}

async function queryTransferBatchesFromSqlite(query: InventoryTransferBatchHistoryQuery): Promise<InventoryTransferBatchHistoryPage> {
  const connection = await getLocalModeSqliteConnection()
  if (!connection) throw new Error('Local transfer history is unavailable.')

  await connection.execute(`CREATE INDEX IF NOT EXISTS idx_local_transfer_batches_history
    ON local_entities (entity_type, workspace_id, json_extract(payload, '$.transferredAt'))`)
  await connection.execute(`CREATE INDEX IF NOT EXISTS idx_local_transfer_transactions_batch_product
    ON local_entities (entity_type, json_extract(payload, '$.transferBatchId'), json_extract(payload, '$.productId'))`)

  const { where, params } = localSqliteSearch(query)
  const [countRow] = await connection.select<Array<{ total_count: number }>>(
    `SELECT COUNT(*) AS total_count FROM local_entities b WHERE ${where}`,
    params,
  )
  const { offset, limit } = historyBounds(query)
  const rows = await connection.select<Array<LocalPayloadRow & { performed_by_name?: string | null }>>(
        `SELECT b.payload,
          (SELECT COUNT(DISTINCT json_extract(tx.payload, '$.productId'))
            FROM local_entities tx
            WHERE tx.entity_type = 'inventory_transactions'
              AND json_extract(tx.payload, '$.transferBatchId') = b.entity_id
              AND COALESCE(json_extract(tx.payload, '$.isDeleted'), 0) = 0
              AND json_extract(tx.payload, '$.transactionType') IN ('transfer_in', 'transfer_out')) AS product_count,
          (SELECT json_extract(actor.payload, '$.name')
            FROM local_entities actor
            WHERE actor.entity_type IN ('profiles', 'users')
              AND actor.entity_id = json_extract(b.payload, '$.performedBy')
            ORDER BY CASE actor.entity_type WHEN 'profiles' THEN 0 ELSE 1 END LIMIT 1) AS performed_by_name
        FROM local_entities b
        WHERE ${where}
        ORDER BY json_extract(b.payload, '$.transferredAt') DESC, b.entity_id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
  )

  return {
    totalCount: Number(countRow?.total_count) || 0,
    rows: rows.flatMap((row) => {
      const batch = parseLocalPayload<InventoryTransferBatch>(row.payload)
      if (!batch) return []
      return [{
        batch,
        productCount: Number(row.product_count) || 0,
        performedByName: row.performed_by_name ?? null,
        sourceIsBranch: false,
        destinationIsBranch: false,
      }]
    }),
  }
}

function mapRemoteHistoryRow(value: unknown): InventoryTransferBatchHistoryItem | null {
  const row = toCamelCase(value as Record<string, unknown>) as Record<string, unknown>
  const batchValue = row.batch
  if (!batchValue || typeof batchValue !== 'object') return null
  return {
    batch: toCamelCase(batchValue as Record<string, unknown>) as unknown as InventoryTransferBatch,
    productCount: Number(row.productCount) || 0,
    performedByName: typeof row.performedByName === 'string' ? row.performedByName : null,
    sourceIsBranch: row.sourceIsBranch === true,
    destinationIsBranch: row.destinationIsBranch === true,
  }
}

/** Fetches one indexed history page; Cloud and Hybrid use a server-side query. */
export async function fetchInventoryTransferBatchHistory(query: InventoryTransferBatchHistoryQuery): Promise<InventoryTransferBatchHistoryPage> {
  const workspaceId = query.workspaceId.trim()
  if (!workspaceId) return { rows: [], totalCount: 0 }
  const normalizedQuery = { ...query, workspaceId, ...historyBounds(query) }

  if (isLocalWorkspaceMode(workspaceId) && !isDemoWorkspaceMode(workspaceId)) {
    return queryTransferBatchesFromSqlite(normalizedQuery)
  }
  if (isDemoWorkspaceMode(workspaceId)) {
    return queryTransferBatchesFromDexie(normalizedQuery)
  }

  const client = getSupabaseClientForTable('inventory_transfer_batches')
  const response = await runSupabaseAction('inventoryTransferBatchHistory.page', () =>
    client.rpc('search_inventory_transfer_batches', {
      p_workspace_id: workspaceId,
      p_search: query.search?.trim() || null,
      p_from: query.from || null,
      p_to: query.to || null,
      p_page: Math.max(1, Math.trunc(query.page)),
      p_page_size: normalizedQuery.pageSize,
    }),
  )

  if (response.error) {
    if (isHybridWorkspaceMode(workspaceId) && isRetriableWebRequestError(response.error)) {
      return queryTransferBatchesFromSqlite(normalizedQuery)
    }
    if (isDemoWorkspaceMode(workspaceId)) {
      return queryTransferBatchesFromDexie(normalizedQuery)
    }
    throw response.error
  }

  const result = response.data as { rows?: unknown[]; total_count?: number; totalCount?: number } | null
  return {
    rows: (result?.rows ?? []).flatMap((row) => {
      const mapped = mapRemoteHistoryRow(row)
      return mapped ? [mapped] : []
    }),
    totalCount: Number(result?.totalCount ?? result?.total_count) || 0,
  }
}

async function queryTransferBatchesFromDexie(query: InventoryTransferBatchHistoryQuery): Promise<InventoryTransferBatchHistoryPage> {
  const batches = await db.inventory_transfer_batches
    .where('workspaceId').equals(query.workspaceId)
    .and((batch) => !batch.isDeleted
      && (!query.from || batch.transferredAt >= query.from)
      && (!query.to || batch.transferredAt < query.to))
    .toArray()
  const needle = query.search?.trim().toLocaleLowerCase()
  const filtered: InventoryTransferBatchHistoryItem[] = []
  for (const batch of batches) {
    const [transactions, actor] = await Promise.all([
      db.inventory_transactions.where('[workspaceId+transferBatchId]')
        .equals([query.workspaceId, batch.id]).toArray(),
      batch.performedBy ? db.users.get(batch.performedBy) : Promise.resolve(undefined),
    ])
    const productIds = new Set(transactions.filter((row) => !row.isDeleted).map((row) => row.productId))
    if (needle) {
      const metadata = [batch.transferNumber, batch.sourceWorkspaceName, batch.sourceStorageName,
        batch.destinationWorkspaceName, batch.destinationStorageName, actor?.name]
        .filter(Boolean).join(' ').toLocaleLowerCase()
      const products = await Promise.all([...productIds].map((id) => db.products.get(id)))
      const productMatch = products.some((product) => product && [product.name, product.sku, product.barcode,
        ...(product.barcodes ?? [])].some((value) => value?.toLocaleLowerCase().includes(needle)))
      if (!metadata.includes(needle) && !productMatch) continue
    }
    filtered.push({ batch, productCount: productIds.size, performedByName: actor?.name ?? null,
      sourceIsBranch: false, destinationIsBranch: false })
  }
  filtered.sort((left, right) => right.batch.transferredAt.localeCompare(left.batch.transferredAt)
    || right.batch.id.localeCompare(left.batch.id))
  const { offset, limit } = historyBounds(query)
  return { rows: filtered.slice(offset, offset + limit), totalCount: filtered.length }
}

/** Loads the requested batch and its transfer_out (or local-side) transaction lines. */
export async function fetchInventoryTransferBatchDetails(workspaceId: string, batchId: string): Promise<InventoryTransferBatchDetails | null> {
  const normalizedWorkspaceId = workspaceId.trim()
  if (!normalizedWorkspaceId || !batchId.trim()) return null
  if (isLocalWorkspaceMode(normalizedWorkspaceId) && !isDemoWorkspaceMode(normalizedWorkspaceId)) {
    return fetchTransferBatchDetailsFromSqlite(normalizedWorkspaceId, batchId)
  }
  if (isDemoWorkspaceMode(normalizedWorkspaceId)) {
    return fetchTransferBatchDetailsFromDexie(normalizedWorkspaceId, batchId)
  }

  const client = getSupabaseClientForTable('inventory_transfer_batches')
  const response = await runSupabaseAction('inventoryTransferBatchHistory.details', () =>
    client.rpc('get_inventory_transfer_batch_details', {
      p_workspace_id: normalizedWorkspaceId,
      p_batch_id: batchId,
    }),
  )
  if (response.error) {
    if (isHybridWorkspaceMode(normalizedWorkspaceId) && isRetriableWebRequestError(response.error)) {
      return fetchTransferBatchDetailsFromSqlite(normalizedWorkspaceId, batchId)
    }
    if (isDemoWorkspaceMode(normalizedWorkspaceId)) {
      return fetchTransferBatchDetailsFromDexie(normalizedWorkspaceId, batchId)
    }
    throw response.error
  }

  const result = response.data as Record<string, unknown> | null
  if (!result?.batch) return null
  const mapped = toCamelCase(result) as Record<string, unknown>
  const batch = toCamelCase(mapped.batch as Record<string, unknown>) as unknown as InventoryTransferBatch
  const products = (Array.isArray(mapped.products) ? mapped.products : []).flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const row = toCamelCase(value as Record<string, unknown>)
    const batchAllocations = Array.isArray(row.batchAllocations)
      ? row.batchAllocations.flatMap((allocation) => allocation && typeof allocation === 'object'
        ? [toCamelCase(allocation as Record<string, unknown>) as unknown as InventoryTransferBatchAllocation]
        : [])
      : []
    return [{
      transactionId: String(row.transactionId ?? ''),
      productId: String(row.productId ?? ''),
      productName: String(row.productName ?? ''),
      sku: String(row.sku ?? ''),
      quantity: Math.abs(Number(row.quantity) || 0),
      unit: String(row.unit ?? ''),
      batchAllocations,
    }]
  })
  return {
    batch,
    productCount: products.length,
    products,
    performedByName: typeof mapped.performedByName === 'string' ? mapped.performedByName : null,
    sourceIsBranch: mapped.sourceIsBranch === true,
    destinationIsBranch: mapped.destinationIsBranch === true,
  }
}

async function fetchTransferBatchDetailsFromSqlite(workspaceId: string, batchId: string): Promise<InventoryTransferBatchDetails | null> {
  const connection = await getLocalModeSqliteConnection()
  if (!connection) throw new Error('Local transfer history is unavailable.')
  const rows = await connection.select<Array<{ payload: string }>>(
    `SELECT payload FROM local_entities WHERE entity_type = 'inventory_transfer_batches'
      AND entity_id = $1 AND workspace_id = $2 LIMIT 1`,
    [batchId, workspaceId],
  )
  const batch = parseLocalPayload<InventoryTransferBatch>(rows[0]?.payload)
  if (!batch || batch.isDeleted) return null
  const result = await connection.select<Array<{ tx_payload: string; product_payload: string | null; activity_payload: string | null }>>(
    `SELECT tx.payload AS tx_payload, product.payload AS product_payload,
      (SELECT activity.payload FROM local_entities activity
        WHERE activity.entity_type = 'inventory_transfer_transactions'
          AND json_extract(activity.payload, '$.workspaceId') = $1
          AND json_extract(activity.payload, '$.productId') = json_extract(tx.payload, '$.productId')
          AND json_extract(activity.payload, '$.createdAt') = json_extract(tx.payload, '$.createdAt')
          AND COALESCE(json_extract(activity.payload, '$.isDeleted'), 0) = 0 LIMIT 1) AS activity_payload
     FROM local_entities tx
     LEFT JOIN local_entities product ON product.entity_type = 'products'
       AND product.entity_id = json_extract(tx.payload, '$.productId')
     WHERE tx.entity_type = 'inventory_transactions'
       AND json_extract(tx.payload, '$.transferBatchId') = $2
       AND COALESCE(json_extract(tx.payload, '$.isDeleted'), 0) = 0
       AND json_extract(tx.payload, '$.transactionType') IN ('transfer_in', 'transfer_out')
     ORDER BY CASE json_extract(tx.payload, '$.transactionType') WHEN 'transfer_out' THEN 0 ELSE 1 END`,
    [workspaceId, batchId],
  )
  const byProduct = new Map<string, InventoryTransferBatchProductLine>()
  for (const row of result) {
    const tx = parseLocalPayload<InventoryTransaction>(row.tx_payload)
    const product = parseLocalPayload<Product>(row.product_payload)
    if (!tx || byProduct.has(tx.productId)) continue
    const activity = parseLocalPayload<InventoryTransferTransaction>(row.activity_payload)
    byProduct.set(tx.productId, {
      transactionId: tx.id,
      productId: tx.productId,
      productName: product?.name ?? '',
      sku: product?.sku ?? '',
      quantity: Math.abs(tx.quantityDelta),
      unit: product?.unit ?? '',
      batchAllocations: activity?.batchAllocations ?? [],
    })
  }
  const actors = batch.performedBy ? await connection.select<Array<{ name: string | null }>>(
    `SELECT json_extract(payload, '$.name') AS name FROM local_entities
      WHERE entity_type IN ('profiles', 'users') AND entity_id = $1
      ORDER BY CASE entity_type WHEN 'profiles' THEN 0 ELSE 1 END LIMIT 1`,
    [batch.performedBy],
  ) : []
  const products = [...byProduct.values()]
  return { batch, productCount: products.length, products, performedByName: actors[0]?.name ?? null,
    sourceIsBranch: false, destinationIsBranch: false }
}

async function fetchTransferBatchDetailsFromDexie(workspaceId: string, batchId: string): Promise<InventoryTransferBatchDetails | null> {
  const batch = await db.inventory_transfer_batches.get(batchId)
  if (!batch || batch.workspaceId !== workspaceId || batch.isDeleted) return null
  const transactions = await db.inventory_transactions.where('[workspaceId+transferBatchId]')
    .equals([workspaceId, batchId]).and((row) => !row.isDeleted).toArray()
  const byProduct = new Map<string, InventoryTransferBatchProductLine>()
  for (const tx of transactions.sort((left, right) => left.transactionType === 'transfer_out' ? -1 : right.transactionType === 'transfer_out' ? 1 : 0)) {
    if (byProduct.has(tx.productId)) continue
    const product = await db.products.get(tx.productId)
    const activity = await db.inventory_transfer_transactions.where('[workspaceId+productId]')
      .equals([workspaceId, tx.productId]).and((row) => row.createdAt === tx.createdAt && !row.isDeleted).first()
    byProduct.set(tx.productId, { transactionId: tx.id, productId: tx.productId,
      productName: product?.name ?? '', sku: product?.sku ?? '', quantity: Math.abs(tx.quantityDelta),
      unit: product?.unit ?? '', batchAllocations: activity?.batchAllocations ?? [] })
  }
  const actor = batch.performedBy ? await db.users.get(batch.performedBy) : undefined
  const products = [...byProduct.values()]
  return { batch, productCount: products.length, products, performedByName: actor?.name ?? null,
    sourceIsBranch: false, destinationIsBranch: false }
}

interface PlannedItem extends InventoryTransferBatchItemInput {
  quantity: number
  sourcePreviousQuantity: number
  destinationPreviousQuantity: number
  sourceInventoryRow: Inventory | null
  destinationInventoryRow: Inventory | null
  batchAllocations: StockBatchAllocation[]
  unbatchedQuantity: number
  transferBatchAllocations: InventoryTransferBatchAllocation[]
}

interface StockBatchChange {
  expectedVersion: number
  row: StockBatch
}

function getPositionRow(rows: Inventory[], workspaceId: string) {
  return rows.find((row) => row.workspaceId === workspaceId && !row.isDeleted)
    ?? rows.find((row) => row.workspaceId === workspaceId)
    ?? null
}

async function getInventoryPosition(workspaceId: string, productId: string, storageId: string) {
  const rows = await db.inventory
    .where('[productId+storageId]')
    .equals([productId, storageId])
    .toArray()
  return getPositionRow(rows, workspaceId)
}

function normalizeItems(items: InventoryTransferBatchItemInput[]) {
  const byProductId = new Map<string, InventoryTransferBatchItemInput>()

  for (const item of items) {
    const productId = item.productId.trim()
    const quantity = Number(item.quantity)
    if (!productId || !isPositiveQuantity(quantity)) {
      throw new Error('Each transfer product must have a valid quantity')
    }

    const existing = byProductId.get(productId)
    if (!existing) {
      byProductId.set(productId, {
        productId,
        quantity: roundQuantity(quantity),
        ...(item.batchSelections !== undefined
          ? { batchSelections: item.batchSelections.map((selection) => ({ ...selection })) }
          : {}),
      })
      continue
    }

    byProductId.set(productId, {
      productId,
      quantity: roundQuantity(existing.quantity + quantity),
      ...(existing.batchSelections !== undefined && item.batchSelections !== undefined
        ? { batchSelections: [...existing.batchSelections, ...item.batchSelections] }
        : {}),
    })
  }

  if (byProductId.size === 0) {
    throw new Error('At least one product must be selected')
  }
  return Array.from(byProductId.values())
}

function isBatchCompatible(batch: StockBatch, allocation: StockBatchAllocation) {
  return batch.price === Number(allocation.price ?? batch.price)
    && batch.costPrice === Number(allocation.costPrice ?? batch.costPrice)
    && batch.currency === (allocation.currency ?? batch.currency)
    && (batch.expiryDate ?? null) === (allocation.expiryDate ?? null)
    && (batch.manufacturingDate ?? null) === (allocation.manufacturingDate ?? null)
}

async function prepareStockBatchChanges(
  workspaceId: string,
  sourceStorageId: string,
  destinationStorageId: string,
  items: PlannedItem[],
  timestamp: string,
) {
  const changesByBatchId = new Map<string, StockBatchChange>()
  const destinationBatchByKey = new Map<string, StockBatch>()

  for (const item of items) {
    const sourceBatches = await db.stock_batches
      .where('[productId+storageId]')
      .equals([item.productId, sourceStorageId])
      .and((batch) => batch.workspaceId === workspaceId && !batch.isDeleted)
      .toArray()
    const destinationBatches = await db.stock_batches
      .where('[productId+storageId]')
      .equals([item.productId, destinationStorageId])
      .and((batch) => batch.workspaceId === workspaceId)
      .toArray()

    for (const batch of destinationBatches) {
      const key = `${item.productId}:${batch.batchNumber.trim().toLocaleLowerCase()}`
      const existing = destinationBatchByKey.get(key)
      if (!existing || (existing.isDeleted && !batch.isDeleted)) {
        destinationBatchByKey.set(key, batch)
      }
    }

    const sourceById = new Map(sourceBatches.map((batch) => [batch.id, batch] as const))
    const transferAllocations: InventoryTransferBatchAllocation[] = []
    for (const allocation of item.batchAllocations) {
      const sourceBatch = sourceById.get(allocation.batchId)
      if (!sourceBatch || sourceBatch.quantity - allocation.quantity < -QUANTITY_EPSILON) {
        throw new Error(`Batch ${allocation.batchNumber} does not have enough stock`)
      }

      const sourceChange = changesByBatchId.get(sourceBatch.id)
      const sourceBase = sourceChange?.row ?? sourceBatch
      const sourceNextQuantity = roundQuantity(sourceBase.quantity - allocation.quantity)
      changesByBatchId.set(sourceBatch.id, {
        expectedVersion: sourceChange?.expectedVersion ?? sourceBatch.version,
        row: {
          ...sourceBase,
          quantity: Math.max(0, sourceNextQuantity),
          isDeleted: sourceNextQuantity <= QUANTITY_EPSILON,
          updatedAt: timestamp,
          version: (sourceChange?.expectedVersion ?? sourceBatch.version) + 1,
        },
      })

      const batchKey = `${item.productId}:${allocation.batchNumber.trim().toLocaleLowerCase()}`
      const targetExisting = destinationBatchByKey.get(batchKey)
      if (targetExisting && !isBatchCompatible(targetExisting, allocation)) {
        throw new Error(`Destination batch ${allocation.batchNumber} has different pricing or dates`)
      }

      const targetChange = targetExisting ? changesByBatchId.get(targetExisting.id) : undefined
      const targetBase = targetChange?.row ?? targetExisting
      const targetId = targetBase?.id ?? generateId()
      const targetNextQuantity = roundQuantity((targetBase?.quantity ?? 0) + allocation.quantity)
      const expectedVersion = targetChange?.expectedVersion ?? targetBase?.version ?? 0
      const targetRow: StockBatch = targetBase
        ? {
            ...targetBase,
            quantity: targetNextQuantity,
            isDeleted: false,
            updatedAt: timestamp,
            version: expectedVersion + 1,
          }
        : {
            id: targetId,
            workspaceId,
            productId: item.productId,
            storageId: destinationStorageId,
            batchNumber: allocation.batchNumber,
            quantity: targetNextQuantity,
            price: Number(allocation.price ?? 0),
            costPrice: Number(allocation.costPrice ?? 0),
            currency: allocation.currency ?? 'usd',
            expiryDate: allocation.expiryDate ?? null,
            manufacturingDate: allocation.manufacturingDate ?? null,
            notes: sourceBatch.notes ?? null,
            sourcePurchaseOrderId: null,
            sourcePurchaseOrderItemId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
            isDeleted: false,
            syncStatus: 'synced',
            lastSyncedAt: timestamp,
          }
      changesByBatchId.set(targetId, { expectedVersion, row: targetRow })
      destinationBatchByKey.set(batchKey, targetRow)
      transferAllocations.push({
        sourceBatchId: sourceBatch.id,
        destinationBatchId: targetId,
        batchNumber: allocation.batchNumber,
        quantity: allocation.quantity,
        price: allocation.price ?? null,
        costPrice: allocation.costPrice ?? null,
        currency: allocation.currency ?? null,
        expiryDate: allocation.expiryDate ?? null,
        manufacturingDate: allocation.manufacturingDate ?? null,
      })
    }
    item.transferBatchAllocations = transferAllocations
  }

  return Array.from(changesByBatchId.values())
}

async function prepareItems(
  workspaceId: string,
  sourceStorageId: string,
  destinationStorageId: string,
  items: InventoryTransferBatchItemInput[],
  timestamp: string,
) {
  const plannedItems: PlannedItem[] = []
  for (const input of items) {
    const [sourceInventoryRow, destinationInventoryRow] = await Promise.all([
      getInventoryPosition(workspaceId, input.productId, sourceStorageId),
      getInventoryPosition(workspaceId, input.productId, destinationStorageId),
    ])
    const sourcePreviousQuantity = sourceInventoryRow && !sourceInventoryRow.isDeleted
      ? roundQuantity(sourceInventoryRow.quantity)
      : 0
    const destinationPreviousQuantity = destinationInventoryRow && !destinationInventoryRow.isDeleted
      ? roundQuantity(destinationInventoryRow.quantity)
      : 0
    const batches = await db.stock_batches
      .where('[productId+storageId]')
      .equals([input.productId, sourceStorageId])
      .and((batch) => batch.workspaceId === workspaceId && !batch.isDeleted)
      .toArray()
    const plan = planStockBatchTransfer({
      inventoryQuantity: sourcePreviousQuantity,
      batches,
      requestedQuantity: input.quantity,
      selectedBatchAllocations: input.batchSelections,
    })
    plannedItems.push({
      ...input,
      quantity: roundQuantity(input.quantity),
      sourcePreviousQuantity,
      destinationPreviousQuantity,
      sourceInventoryRow,
      destinationInventoryRow,
      batchAllocations: plan.batchAllocations,
      unbatchedQuantity: plan.unbatchedQuantity,
      transferBatchAllocations: [],
    })
  }

  const stockBatchChanges = await prepareStockBatchChanges(
    workspaceId,
    sourceStorageId,
    destinationStorageId,
    plannedItems,
    timestamp,
  )
  return { plannedItems, stockBatchChanges }
}

function buildTransferActivityRows(input: {
  workspaceId: string
  sourceStorageId: string
  destinationStorageId: string
  batch: InventoryTransferBatch
  transferType: InventoryTransferTransactionType
  reorderRuleId?: string | null
  items: PlannedItem[]
}) {
  return input.items.map((item): InventoryTransferTransaction => ({
    id: generateId(),
    workspaceId: input.workspaceId,
    productId: item.productId,
    sourceStorageId: input.sourceStorageId,
    destinationStorageId: input.destinationStorageId,
    quantity: item.quantity,
    batchAllocations: item.transferBatchAllocations,
    transferType: input.transferType,
    reorderRuleId: input.reorderRuleId ?? null,
    sourceWorkspaceId: input.batch.sourceWorkspaceId,
    destinationWorkspaceId: input.batch.destinationWorkspaceId,
    sourceWorkspaceName: input.batch.sourceWorkspaceName ?? null,
    destinationWorkspaceName: input.batch.destinationWorkspaceName ?? null,
    sourceStorageName: input.batch.sourceStorageName ?? null,
    destinationStorageName: input.batch.destinationStorageName ?? null,
    createdAt: input.batch.transferredAt,
    updatedAt: input.batch.transferredAt,
    version: 1,
    isDeleted: false,
    syncStatus: 'synced',
    lastSyncedAt: input.batch.lastSyncedAt,
  }))
}

function getTransferTransactionRows(input: {
  batchId: string
  workspaceId: string
  sourceStorageId: string
  destinationStorageId: string
  createdBy: string | null
  timestamp: string
  referenceType: string
  notes: string | null
  items: PlannedItem[]
  local: boolean
}) {
  const inventoryRows: Inventory[] = []
  const transactions: InventoryTransaction[] = []

  for (const item of input.items) {
    const positions = [
      {
        storageId: input.sourceStorageId,
        oldRow: item.sourceInventoryRow,
        previousQuantity: item.sourcePreviousQuantity,
        quantity: roundQuantity(Math.max(item.sourcePreviousQuantity - item.quantity, 0)),
        transactionType: 'transfer_out' as const,
        delta: -item.quantity,
      },
      {
        storageId: input.destinationStorageId,
        oldRow: item.destinationInventoryRow,
        previousQuantity: item.destinationPreviousQuantity,
        quantity: roundQuantity(item.destinationPreviousQuantity + item.quantity),
        transactionType: 'transfer_in' as const,
        delta: item.quantity,
      },
    ]

    for (const position of positions) {
      const version = (position.oldRow?.version ?? 0) + 1
      const row: Inventory = {
        id: position.oldRow?.id ?? generateId(),
        workspaceId: input.workspaceId,
        productId: item.productId,
        storageId: position.storageId,
        quantity: position.quantity,
        createdAt: position.oldRow?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
        version,
        isDeleted: position.quantity <= QUANTITY_EPSILON,
        syncStatus: 'synced',
        lastSyncedAt: input.local ? input.timestamp : null,
      }
      inventoryRows.push(row)
      transactions.push({
        id: buildInventoryMovementTransactionId(input.workspaceId, item.productId, position.storageId, version),
        workspaceId: input.workspaceId,
        productId: item.productId,
        storageId: position.storageId,
        transferBatchId: input.batchId,
        transactionType: position.transactionType,
        quantityDelta: roundQuantity(position.delta),
        previousQuantity: position.previousQuantity,
        newQuantity: position.quantity,
        adjustmentReason: null,
        referenceId: input.batchId,
        referenceType: input.referenceType,
        notes: input.notes,
        createdBy: input.createdBy,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: input.local ? input.timestamp : null,
      })
    }
  }

  return { inventoryRows, transactions }
}

async function createLocalTransferBatch(input: CreateInventoryTransferBatchInput, batchId: string, timestamp: string) {
  const workspaceId = input.workspaceId
  const sourceStorageId = input.sourceStorageId.trim()
  const destinationStorageId = input.destinationStorageId.trim()
  const items = normalizeItems(input.items)
  const createdBy = input.createdBy ?? getActiveBusinessUserId() ?? null

  const committed = await db.transaction(
    'rw',
    [
      db.inventory,
      db.inventory_transactions,
      db.inventory_transfer_batches,
      db.inventory_transfer_sequences,
      db.inventory_transfer_transactions,
      db.stock_batches,
      db.products,
      db.storages,
      db.workspaces,
    ],
    async () => {
      const { plannedItems, stockBatchChanges } = await prepareItems(
        workspaceId,
        sourceStorageId,
        destinationStorageId,
        items,
        timestamp,
      )
      const { inventoryRows, transactions } = getTransferTransactionRows({
        batchId,
        workspaceId,
        sourceStorageId,
        destinationStorageId,
        createdBy,
        timestamp,
        referenceType: input.referenceType?.trim() || 'inventory_transfer',
        notes: input.notes?.trim() || null,
        items: plannedItems,
        local: true,
      })

      const existingSequence = await db.inventory_transfer_sequences.get(workspaceId)
      const nextSequence = (existingSequence?.lastSequence ?? 0) + 1
      await db.inventory_transfer_sequences.put({
        workspaceId,
        lastSequence: nextSequence,
        updatedAt: timestamp,
      })

      const sourceStorage = await db.storages.get(sourceStorageId)
      const destinationStorage = await db.storages.get(destinationStorageId)
      const currentWorkspace = await db.workspaces.get(workspaceId)
      const [sourceWorkspace, destinationWorkspace] = await Promise.all([
        input.sourceWorkspaceId && input.sourceWorkspaceId !== workspaceId
          ? db.workspaces.get(input.sourceWorkspaceId)
          : Promise.resolve(currentWorkspace),
        input.destinationWorkspaceId && input.destinationWorkspaceId !== workspaceId
          ? db.workspaces.get(input.destinationWorkspaceId)
          : Promise.resolve(currentWorkspace),
      ])
      const batchRow: InventoryTransferBatch = {
        id: batchId,
        workspaceId,
        transferNumber: `TRF-${String(nextSequence).padStart(5, '0')}`,
        sourceWorkspaceId: input.sourceWorkspaceId || workspaceId,
        sourceWorkspaceName: input.sourceWorkspaceName ?? sourceWorkspace?.name ?? null,
        sourceStorageId,
        sourceStorageName: sourceStorage?.name ?? null,
        destinationWorkspaceId: input.destinationWorkspaceId || workspaceId,
        destinationWorkspaceName: input.destinationWorkspaceName ?? destinationWorkspace?.name ?? null,
        destinationStorageId,
        destinationStorageName: destinationStorage?.name ?? null,
        performedBy: createdBy,
        transferredAt: timestamp,
        status: 'completed',
        notes: input.notes?.trim() || null,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: timestamp,
      }

      await db.inventory_transfer_batches.add(batchRow)
      await db.inventory.bulkPut(inventoryRows)
      await db.inventory_transactions.bulkPut(transactions)
      await db.inventory_transfer_transactions.bulkPut(buildTransferActivityRows({
        workspaceId,
        sourceStorageId,
        destinationStorageId,
        batch: batchRow,
        transferType: input.transferType ?? 'manual',
        reorderRuleId: input.reorderRuleId,
        items: plannedItems,
      }))
      if (stockBatchChanges.length > 0) {
        await db.stock_batches.bulkPut(stockBatchChanges.map(({ row }) => ({
          ...row,
          syncStatus: 'synced' as const,
          lastSyncedAt: timestamp,
        })))
      }
      for (const productId of new Set(items.map((item) => item.productId))) {
        await syncProductStockSnapshot(productId, timestamp, 'local')
      }
      return { batch: batchRow, plannedItems }
    },
  )

  return {
    batch: committed.batch,
    items: committed.plannedItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      batchAllocations: item.transferBatchAllocations,
      reverseBatchSelections: item.transferBatchAllocations.map((allocation) => ({
        batchId: allocation.destinationBatchId,
        quantity: allocation.quantity,
      })),
    })),
    movedCount: committed.plannedItems.length,
  } satisfies InventoryTransferBatchResult
}
async function createRemoteTransferBatch(input: CreateInventoryTransferBatchInput, batchId: string, timestamp: string) {
  const workspaceId = input.workspaceId
  const sourceStorageId = input.sourceStorageId.trim()
  const destinationStorageId = input.destinationStorageId.trim()
  const items = normalizeItems(input.items)

  await Promise.all(items.map((item) => hydrateInventoryProductStoragesFromSupabase(
    workspaceId,
    item.productId,
    [sourceStorageId, destinationStorageId],
    { requireAuthoritative: true },
  )))
  await refreshStockBatchesFromSupabase(workspaceId)

  const { plannedItems, stockBatchChanges } = await prepareItems(
    workspaceId,
    sourceStorageId,
    destinationStorageId,
    items,
    timestamp,
  )
  const [sourceStorage, destinationStorage, workspace] = await Promise.all([
    db.storages.get(sourceStorageId),
    db.storages.get(destinationStorageId),
    db.workspaces.get(workspaceId),
  ])
  const createdBy = input.createdBy ?? getActiveBusinessUserId() ?? null
  const { inventoryRows, transactions } = getTransferTransactionRows({
    batchId,
    workspaceId,
    sourceStorageId,
    destinationStorageId,
    createdBy,
    timestamp,
    referenceType: input.referenceType?.trim() || 'inventory_transfer',
    notes: input.notes?.trim() || null,
    items: plannedItems,
    local: false,
  })

  const transactionByPosition = new Map(transactions.map((transaction) => [
    `${transaction.productId}:${transaction.storageId}`,
    transaction,
  ]))
  const payload = {
    batch: {
      id: batchId,
      workspace_id: workspaceId,
      source_workspace_id: input.sourceWorkspaceId || workspaceId,
      source_workspace_name: input.sourceWorkspaceName ?? workspace?.name ?? null,
      source_storage_id: sourceStorageId,
      source_storage_name: sourceStorage?.name ?? null,
      destination_workspace_id: input.destinationWorkspaceId || workspaceId,
      destination_workspace_name: input.destinationWorkspaceName ?? workspace?.name ?? null,
      destination_storage_id: destinationStorageId,
      destination_storage_name: destinationStorage?.name ?? null,
      transferred_at: timestamp,
      status: 'completed',
      notes: input.notes?.trim() || null,
      created_by: createdBy,
    },
    inventory_changes: inventoryRows.map((row) => {
      const movement = transactionByPosition.get(`${row.productId}:${row.storageId}`)
      return {
        id: row.id,
        workspace_id: row.workspaceId,
        product_id: row.productId,
        storage_id: row.storageId,
        quantity: row.quantity,
        expected_version: row.version - 1,
        transfer_item_id: row.productId,
        transfer_side: row.storageId === sourceStorageId ? 'source' : 'destination',
        quantity_delta: movement?.quantityDelta,
        audit_transaction_type: movement?.transactionType,
        audit_reference_id: batchId,
        audit_reference_type: movement?.referenceType,
        audit_notes: movement?.notes,
        audit_created_by: createdBy,
      }
    }),
    stock_batch_changes: stockBatchChanges.map((change) => ({
      expected_version: change.expectedVersion,
      row: toSnakeCase({ ...change.row }),
    })),
  }

  const client = getSupabaseClientForTable('inventory')
  const execute = () => runSupabaseAction(
    'inventory.transfer_batch.commit',
    () => client.rpc('apply_inventory_transfer_batch', {
      p_operation_id: batchId,
      p_payload: payload,
    }),
  )
  let response = await execute()
  if (response.error && isRetriableWebRequestError(response.error)) {
    response = await execute()
  }
  if (response.error) {
    throw response.error
  }

  const result = response.data as Record<string, unknown> | null
  if (result?.conflict) {
    throw new Error('Inventory changed on another device; refresh and retry')
  }
  if (!result?.batch || !Array.isArray(result.inventory) || !Array.isArray(result.inventory_transactions)) {
    throw new Error('The transfer could not be confirmed by the server')
  }

  const syncedAt = new Date().toISOString()
  const batch = {
    ...(toCamelCase(result.batch as Record<string, unknown>) as unknown as InventoryTransferBatch),
    syncStatus: 'synced' as const,
    lastSyncedAt: syncedAt,
  }
  const syncedInventory = (result.inventory as Record<string, unknown>[]).map((row) => ({
    ...(toCamelCase(row) as unknown as Inventory),
    syncStatus: 'synced' as const,
    lastSyncedAt: syncedAt,
  }))
  const syncedTransactions = (result.inventory_transactions as Record<string, unknown>[]).map((row) => ({
    ...(toCamelCase(row) as unknown as InventoryTransaction),
    transferBatchId: batchId,
    syncStatus: 'synced' as const,
    lastSyncedAt: syncedAt,
  }))
  const syncedStockBatches = Array.isArray(result.stock_batches)
    ? (result.stock_batches as Record<string, unknown>[]).map((row) => ({
        ...(toCamelCase(row) as unknown as StockBatch),
        syncStatus: 'synced' as const,
        lastSyncedAt: syncedAt,
      }))
    : []
  const syncedProducts = Array.isArray(result.products)
    ? (result.products as Record<string, unknown>[])
    : []
  const transferActivityRows = buildTransferActivityRows({
    workspaceId,
    sourceStorageId,
    destinationStorageId,
    batch,
    transferType: input.transferType ?? 'manual',
    reorderRuleId: input.reorderRuleId,
    items: plannedItems,
  })

  try {
    await db.transaction(
      'rw',
      [
        db.inventory,
        db.inventory_transactions,
        db.inventory_transfer_batches,
        db.inventory_transfer_transactions,
        db.stock_batches,
        db.products,
      ],
      async () => {
        await db.inventory.bulkPut(syncedInventory)
        await db.inventory_transactions.bulkPut(syncedTransactions)
        await db.inventory_transfer_batches.put(batch)
        await db.inventory_transfer_transactions.bulkPut(transferActivityRows)
        if (syncedStockBatches.length > 0) {
          await db.stock_batches.bulkPut(syncedStockBatches)
        }
        if (syncedProducts.length > 0) {
          await db.products.bulkPut(syncedProducts.map((row) => ({
            ...(toCamelCase(row) as Record<string, unknown>),
            syncStatus: 'synced',
            lastSyncedAt: syncedAt,
          }) as never))
        }
      },
    )
  } catch (error) {
    // PostgreSQL has committed the complete operation; local rows are only a cache.
    console.error('[InventoryTransfer] Failed to refresh the local transfer cache:', error)
  }

  return {
    batch,
    items: plannedItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      batchAllocations: item.transferBatchAllocations,
      reverseBatchSelections: item.transferBatchAllocations.map((allocation) => ({
        batchId: allocation.destinationBatchId,
        quantity: allocation.quantity,
      })),
    })),
    movedCount: plannedItems.length,
  } satisfies InventoryTransferBatchResult
}

/**
 * Creates one transfer header and all of its inventory, audit, and stock-batch
 * changes as a single operation in the active workspace data store.
 */
export async function createInventoryTransferBatch(input: CreateInventoryTransferBatchInput): Promise<InventoryTransferBatchResult> {
  const workspaceId = input.workspaceId.trim()
  const sourceStorageId = input.sourceStorageId.trim()
  const destinationStorageId = input.destinationStorageId.trim()
  if (!workspaceId || !sourceStorageId || !destinationStorageId) {
    throw new Error('Workspace and storage are required for a transfer')
  }
  if (sourceStorageId === destinationStorageId) {
    throw new Error('Source and destination storages must be different')
  }

  const items = normalizeItems(input.items)
  await Promise.all([
    assertCurrentUserCanAccessStorage(workspaceId, sourceStorageId),
    assertCurrentUserCanAccessStorage(workspaceId, destinationStorageId),
  ])

  const normalizedInput: CreateInventoryTransferBatchInput = {
    ...input,
    workspaceId,
    sourceStorageId,
    destinationStorageId,
    items,
  }
  const batchId = input.batchId?.trim() || generateId()
  const timestamp = input.transferredAt || new Date().toISOString()

  if (isLocalWorkspaceMode(workspaceId)) {
    return createLocalTransferBatch(normalizedInput, batchId, timestamp)
  }
  assertInventoryMutationConnectivity(workspaceId)
  return createRemoteTransferBatch(normalizedInput, batchId, timestamp)
}
