import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline, getActiveBusinessUserId } from '@/lib/network'
import { QUANTITY_EPSILON, roundQuantity } from '@/lib/quantity'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import {
  assertValidProductUnitFactor,
  assertValidUnitRelationship,
} from '@/lib/unitRelationships'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { buildInventoryMovementTransactionId, createInventoryTransaction, hydrateInventoryTransactionsForReferences } from './inventoryTransactions'
import { fetchTableFromSupabase } from './hooks'
import type {
  CurrencyCode,
  PriceBookUnitPrice,
  ProductUnitConversion,
  UnitRelationship,
  UnitRef,
} from './models'
import { addToOfflineMutations } from './offlineMutations'

const TABLES = {
  relationships: 'unit_relationships',
  conversions: 'product_unit_conversions',
  priceBookPrices: 'price_book_unit_prices',
} as const

function usesCloud(workspaceId?: string | null) {
  return Boolean(workspaceId) && !isLocalWorkspaceMode(workspaceId)
}

function metadata(workspaceId: string, now: string) {
  const synced = !usesCloud(workspaceId) || isOnline(workspaceId)
  return {
    syncStatus: synced ? 'synced' as const : 'pending' as const,
    lastSyncedAt: synced ? now : null,
  }
}

function remotePayload(value: Record<string, unknown>) {
  return toSnakeCase({ ...value, syncStatus: undefined, lastSyncedAt: undefined })
}

async function upsertRemote(tableName: string, row: Record<string, unknown>, onConflict = 'id') {
  const { data, error } = await runSupabaseAction(`${tableName}.upsert`, () => supabase
    .from(tableName)
    .upsert(remotePayload(row), { onConflict })
    .select('*')
    .single())
  if (error) throw normalizeSupabaseActionError(error)
  return toCamelCase(data as Record<string, unknown>) as Record<string, unknown>
}

export function useUnitRelationships(workspaceId?: string) {
  const online = useNetworkStatus()
  const rows = useLiveQuery(
    () => workspaceId
      ? db.unit_relationships.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  )

  useEffect(() => {
    if (!online || !workspaceId || !usesCloud(workspaceId)) return
    void fetchTableFromSupabase(TABLES.relationships, db.unit_relationships, workspaceId)
  }, [online, workspaceId])

  return rows ?? []
}

export function useProductUnitConversions(workspaceId?: string) {
  const online = useNetworkStatus()
  const rows = useLiveQuery(
    () => workspaceId
      ? db.product_unit_conversions.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  )

  useEffect(() => {
    if (!online || !workspaceId || !usesCloud(workspaceId)) return
    void fetchTableFromSupabase(TABLES.conversions, db.product_unit_conversions, workspaceId)
  }, [online, workspaceId])

  return rows ?? []
}

export function usePriceBookUnitPrices(workspaceId?: string) {
  const online = useNetworkStatus()
  const rows = useLiveQuery(
    () => workspaceId
      ? db.price_book_unit_prices.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  )

  useEffect(() => {
    if (!online || !workspaceId || !usesCloud(workspaceId)) return
    void fetchTableFromSupabase(TABLES.priceBookPrices, db.price_book_unit_prices, workspaceId)
  }, [online, workspaceId])

  return rows ?? []
}

export type UnitRelationshipInput = {
  name?: string | null
  parentUnitRef: UnitRef
  parentUnitCode: string
  childUnitRef: UnitRef
  childUnitCode: string
}

export class UnitRelationshipInUseError extends Error {
  constructor() {
    super('unit_relationship_in_use')
    this.name = 'UnitRelationshipInUseError'
  }
}

export class UnitRelationshipEndpointInUseError extends Error {
  constructor() {
    super('unit_relationship_endpoint_in_use')
    this.name = 'UnitRelationshipEndpointInUseError'
  }
}

export class UnitRelationshipVerificationRequiredError extends Error {
  constructor() {
    super('unit_relationship_verification_required')
    this.name = 'UnitRelationshipVerificationRequiredError'
  }
}

function normalizeRelationshipMutationError(error: unknown): Error {
  const normalized = normalizeSupabaseActionError(error)
  const message = normalized.message.toLowerCase()
  if (message.includes('unit relationship endpoint is already used by a product')) {
    return new UnitRelationshipEndpointInUseError()
  }
  if (message.includes('unit relationship is used by a product')) {
    return new UnitRelationshipInUseError()
  }
  return normalized
}

function assertRelationshipMutationCanBeVerified(workspaceId: string) {
  if (usesCloud(workspaceId) && !isOnline(workspaceId)) {
    throw new UnitRelationshipVerificationRequiredError()
  }
}

async function getActiveRelationshipProductState(workspaceId: string) {
  const [products, conversions, relationships] = await Promise.all([
    db.products.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray(),
    db.product_unit_conversions.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray(),
    db.unit_relationships.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray(),
  ])
  const activeProductIds = new Set(products.map((product) => product.id))
  return {
    products,
    conversions: conversions.filter((conversion) => activeProductIds.has(conversion.productId)),
    relationships,
  }
}

async function relationshipHasActiveProducts(workspaceId: string, relationshipId: string) {
  const { conversions } = await getActiveRelationshipProductState(workspaceId)
  return conversions.some((conversion) => conversion.relationshipId === relationshipId)
}

async function relationshipEndpointsHaveActiveProducts(
  workspaceId: string,
  input: Pick<UnitRelationshipInput, 'parentUnitRef' | 'parentUnitCode' | 'childUnitRef' | 'childUnitCode'>,
) {
  const { products, conversions, relationships } = await getActiveRelationshipProductState(workspaceId)
  const endpointCodes = new Set([
    input.parentUnitCode.trim().toLowerCase(),
    input.childUnitCode.trim().toLowerCase(),
  ])
  if (products.some((product) => endpointCodes.has(product.unit.trim().toLowerCase()))) return true

  const endpointRefs = new Set([input.parentUnitRef, input.childUnitRef])
  const relationshipsById = new Map(relationships.map((relationship) => [relationship.id, relationship]))
  return conversions.some((conversion) => {
    const relationship = relationshipsById.get(conversion.relationshipId)
    return Boolean(relationship && (
      endpointRefs.has(relationship.parentUnitRef)
      || endpointRefs.has(relationship.childUnitRef)
    ))
  })
}

export async function saveUnitRelationship(
  workspaceId: string,
  input: UnitRelationshipInput,
  id?: string,
) {
  const existingRows = await db.unit_relationships.where('workspaceId').equals(workspaceId).toArray()
  const existing = id ? await db.unit_relationships.get(id) : undefined
  const endpointsChanged = !existing
    || existing.parentUnitRef !== input.parentUnitRef
    || existing.childUnitRef !== input.childUnitRef
  if (!existing?.isArchived) {
    assertValidUnitRelationship(input as Pick<UnitRelationship, 'parentUnitRef' | 'childUnitRef'>, existingRows, id)
  }
  if (existing && endpointsChanged && await relationshipHasActiveProducts(workspaceId, existing.id)) {
    throw new UnitRelationshipInUseError()
  }
  if (endpointsChanged) {
    if (await relationshipEndpointsHaveActiveProducts(workspaceId, input)) {
      throw new UnitRelationshipEndpointInUseError()
    }
    assertRelationshipMutationCanBeVerified(workspaceId)
  }

  const now = new Date().toISOString()
  let row: UnitRelationship = {
    id: existing?.id ?? generateId(),
    workspaceId,
    name: input.name?.trim() || null,
    parentUnitRef: input.parentUnitRef,
    parentUnitCode: input.parentUnitCode.trim(),
    childUnitRef: input.childUnitRef,
    childUnitCode: input.childUnitCode.trim(),
    isArchived: existing?.isArchived ?? false,
    createdBy: existing?.createdBy ?? getActiveBusinessUserId() ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    isDeleted: false,
    ...metadata(workspaceId, now),
  }

  if (usesCloud(workspaceId) && isOnline(workspaceId)) {
    try {
      row = { ...row, ...(await upsertRemote(TABLES.relationships, row as unknown as Record<string, unknown>)) } as UnitRelationship
    } catch (error) {
      throw normalizeRelationshipMutationError(error)
    }
    row.syncStatus = 'synced'
    row.lastSyncedAt = now
  } else if (usesCloud(workspaceId)) {
    await addToOfflineMutations(TABLES.relationships, row.id, existing ? 'update' : 'create', row as unknown as Record<string, unknown>, workspaceId)
  }
  await db.unit_relationships.put(row)
  return row
}

export async function setUnitRelationshipArchived(id: string, archived: boolean) {
  const existing = await db.unit_relationships.get(id)
  if (!existing) return
  if (await relationshipHasActiveProducts(existing.workspaceId, existing.id)) {
    throw new UnitRelationshipInUseError()
  }
  if (!archived) {
    const existingRows = await db.unit_relationships.where('workspaceId').equals(existing.workspaceId).toArray()
    assertValidUnitRelationship(existing, existingRows, existing.id)
    if (await relationshipEndpointsHaveActiveProducts(existing.workspaceId, existing)) {
      throw new UnitRelationshipEndpointInUseError()
    }
  }
  assertRelationshipMutationCanBeVerified(existing.workspaceId)
  const now = new Date().toISOString()
  let row: UnitRelationship = {
    ...existing,
    isArchived: archived,
    updatedAt: now,
    version: existing.version + 1,
    ...metadata(existing.workspaceId, now),
  }
  if (usesCloud(existing.workspaceId) && isOnline(existing.workspaceId)) {
    try {
      row = { ...row, ...(await upsertRemote(TABLES.relationships, row as unknown as Record<string, unknown>)) } as UnitRelationship
    } catch (error) {
      throw normalizeRelationshipMutationError(error)
    }
    row.syncStatus = 'synced'
    row.lastSyncedAt = now
  } else if (usesCloud(existing.workspaceId)) {
    await addToOfflineMutations(TABLES.relationships, id, 'update', row as unknown as Record<string, unknown>, existing.workspaceId)
  }
  await db.unit_relationships.put(row)
}

export async function deleteUnitRelationship(id: string) {
  const existing = await db.unit_relationships.get(id)
  if (!existing) return
  if (await relationshipHasActiveProducts(existing.workspaceId, id)) throw new UnitRelationshipInUseError()
  assertRelationshipMutationCanBeVerified(existing.workspaceId)

  if (usesCloud(existing.workspaceId) && isOnline(existing.workspaceId)) {
    try {
      const { error } = await runSupabaseAction('unitRelationships.delete', () => supabase
        .from(TABLES.relationships)
        .delete()
        .eq('id', id))
      if (error) throw error
    } catch (error) {
      throw normalizeRelationshipMutationError(error)
    }
  } else if (usesCloud(existing.workspaceId)) {
    await addToOfflineMutations(TABLES.relationships, id, 'delete', { id, hardDelete: true }, existing.workspaceId)
  }
  await db.unit_relationships.delete(id)
}

export async function replaceProductUnitConversion(
  workspaceId: string,
  productId: string,
  input: { relationshipId: string; factor: number; parentPrice: number; childIsDynamic: boolean } | null,
) {
  const existingRows = await db.product_unit_conversions
    .where('[workspaceId+productId]')
    .equals([workspaceId, productId])
    .toArray()
  const existing = existingRows.find((row) => !row.isDeleted)
  const now = new Date().toISOString()

  if (!input) {
    if (!existing) return null
    if (usesCloud(workspaceId) && isOnline(workspaceId)) {
      const { error } = await runSupabaseAction('productUnitConversions.delete', () => supabase
        .from(TABLES.conversions)
        .delete()
        .eq('id', existing.id))
      if (error) throw normalizeSupabaseActionError(error)
    } else if (usesCloud(workspaceId)) {
      await addToOfflineMutations(TABLES.conversions, existing.id, 'delete', { id: existing.id, hardDelete: true }, workspaceId)
    }
    await db.product_unit_conversions.delete(existing.id)
    return null
  }

  assertValidProductUnitFactor(input.factor, input.childIsDynamic)
  if (!Number.isFinite(input.parentPrice) || input.parentPrice < 0) throw new Error('unit_parent_price_invalid')
  const relationship = await db.unit_relationships.get(input.relationshipId)
  const product = await db.products.get(productId)
  if (!relationship || relationship.isDeleted || relationship.workspaceId !== workspaceId
    || (relationship.isArchived && existing?.relationshipId !== input.relationshipId)) {
    throw new Error('unit_relationship_unavailable')
  }
  if (!product || product.isDeleted || product.workspaceId !== workspaceId || product.unit !== relationship.childUnitCode) {
    throw new Error('unit_product_base_mismatch')
  }

  let row: ProductUnitConversion = {
    id: existing?.id ?? generateId(),
    workspaceId,
    productId,
    relationshipId: input.relationshipId,
    factor: input.factor,
    parentPrice: input.parentPrice,
    createdBy: existing?.createdBy ?? getActiveBusinessUserId() ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    isDeleted: false,
    ...metadata(workspaceId, now),
  }
  if (usesCloud(workspaceId) && isOnline(workspaceId)) {
    row = { ...row, ...(await upsertRemote(TABLES.conversions, row as unknown as Record<string, unknown>, 'product_id')) } as ProductUnitConversion
    row.syncStatus = 'synced'
    row.lastSyncedAt = now
  } else if (usesCloud(workspaceId)) {
    await addToOfflineMutations(TABLES.conversions, row.id, existing ? 'update' : 'create', row as unknown as Record<string, unknown>, workspaceId)
  }
  await db.product_unit_conversions.put(row)
  return row
}

/**
 * One-time migration for an existing product whose stock is currently counted
 * in the larger unit. The operation converts every inventory and batch row to
 * the canonical smaller unit and normalizes the stored base cost.
 */
export async function convertProductInventoryToChildUnit(input: {
  workspaceId: string
  productId: string
  factor: number
  childUnitCode: string
}) {
  if (!Number.isFinite(input.factor) || input.factor <= 0) throw new Error('unit_factor_positive')
  const product = await db.products.get(input.productId)
  if (!product || product.workspaceId !== input.workspaceId || product.isDeleted) throw new Error('product_not_found')

  if (usesCloud(input.workspaceId)) {
    if (!isOnline(input.workspaceId)) throw new Error('unit_conversion_online_required')
    const { error } = await runSupabaseAction('productUnitConversions.convertInventory', () => supabase.rpc(
      'convert_product_inventory_to_child_unit',
      {
        p_product_id: input.productId,
        p_factor: input.factor,
        p_child_unit_code: input.childUnitCode,
      },
    ))
    if (error) throw normalizeSupabaseActionError(error)
    await Promise.all([
      fetchTableFromSupabase('products', db.products, input.workspaceId, { force: true }),
      fetchTableFromSupabase('inventory', db.inventory, input.workspaceId, { force: true }),
      fetchTableFromSupabase('stock_batches', db.stock_batches, input.workspaceId, { force: true }),
      hydrateInventoryTransactionsForReferences(input.workspaceId, [input.productId]),
    ])
    return
  }

  const now = new Date().toISOString()
  await db.transaction('rw', [db.products, db.inventory, db.inventory_transactions, db.stock_batches], async () => {
    const inventoryRows = await db.inventory.where('productId').equals(input.productId).toArray()
    const batches = await db.stock_batches.where('productId').equals(input.productId).toArray()
    const nextInventoryRows = inventoryRows.map((row) => ({
      ...row,
      quantity: roundQuantity(row.quantity * input.factor),
      updatedAt: now,
      version: row.version + 1,
    }))
    await db.inventory.bulkPut(nextInventoryRows)
    for (const row of nextInventoryRows) {
      const previous = inventoryRows.find((candidate) => candidate.id === row.id)
      const previousQuantity = previous && !previous.isDeleted ? Math.max(0, previous.quantity) : 0
      const newQuantity = row.isDeleted ? 0 : Math.max(0, row.quantity)
      const quantityDelta = roundQuantity(newQuantity - previousQuantity)
      if (Math.abs(quantityDelta) <= QUANTITY_EPSILON) continue

      await createInventoryTransaction(input.workspaceId, {
        productId: input.productId,
        storageId: row.storageId,
        transactionType: 'inventory_change',
        quantityDelta,
        previousQuantity,
        newQuantity,
        referenceId: input.productId,
        referenceType: 'product_unit_conversion',
        notes: null,
        createdBy: getActiveBusinessUserId() ?? null,
      }, {
        id: buildInventoryMovementTransactionId(input.workspaceId, input.productId, row.storageId, row.version),
        timestamp: now,
        skipRemoteSync: true,
      })
    }
    await db.stock_batches.bulkPut(batches.map((row) => ({
      ...row,
      quantity: roundQuantity(row.quantity * input.factor),
      price: row.price / input.factor,
      costPrice: row.costPrice / input.factor,
      updatedAt: now,
      version: row.version + 1,
    })))
    await db.products.put({
      ...product,
      unit: input.childUnitCode,
      quantity: roundQuantity(product.quantity * input.factor),
      minStockLevel: roundQuantity(product.minStockLevel * input.factor),
      costPrice: product.costPrice == null ? null : product.costPrice / input.factor,
      updatedAt: now,
      version: product.version + 1,
    })
  })
}

export async function replaceProductPriceBookUnitPrices(
  workspaceId: string,
  productId: string,
  inputs: Array<{ priceBookId: string; unitRef: UnitRef; price: number; currency: CurrencyCode }>,
) {
  const existing = await db.price_book_unit_prices.where('[workspaceId+productId]').equals([workspaceId, productId]).toArray()
  const desiredKeys = new Set(inputs.map((row) => `${row.priceBookId}:${row.unitRef}`))
  const existingByKey = new Map(existing.map((row) => [`${row.priceBookId}:${row.unitRef}`, row]))
  const now = new Date().toISOString()
  const rows: PriceBookUnitPrice[] = inputs.map((input) => {
    if (!Number.isFinite(input.price) || input.price < 0) throw new Error('unit_price_invalid')
    const previous = existingByKey.get(`${input.priceBookId}:${input.unitRef}`)
    return {
      id: previous?.id ?? generateId(),
      workspaceId,
      productId,
      ...input,
      createdBy: previous?.createdBy ?? getActiveBusinessUserId() ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      version: (previous?.version ?? 0) + 1,
      isDeleted: false,
      ...metadata(workspaceId, now),
    }
  })

  if (usesCloud(workspaceId) && isOnline(workspaceId)) {
    const { data, error } = await runSupabaseAction('priceBookUnitPrices.replace', () => supabase
      .from(TABLES.priceBookPrices)
      .upsert(rows.map((row) => remotePayload(row as unknown as Record<string, unknown>)), {
        onConflict: 'price_book_id,product_id,unit_ref',
      })
      .select('*'))
    if (error) throw normalizeSupabaseActionError(error)
    rows.splice(0, rows.length, ...(data ?? []).map((row) => ({
      ...(toCamelCase(row as Record<string, unknown>) as unknown as PriceBookUnitPrice),
      syncStatus: 'synced' as const,
      lastSyncedAt: now,
    })))
    const removed = existing.filter((row) => !desiredKeys.has(`${row.priceBookId}:${row.unitRef}`))
    if (removed.length) {
      const { error: deleteError } = await runSupabaseAction('priceBookUnitPrices.deleteRemoved', () => supabase
        .from(TABLES.priceBookPrices)
        .delete()
        .in('id', removed.map((row) => row.id)))
      if (deleteError) throw normalizeSupabaseActionError(deleteError)
    }
  } else if (usesCloud(workspaceId)) {
    for (const row of rows) {
      await addToOfflineMutations(TABLES.priceBookPrices, row.id, existingByKey.has(`${row.priceBookId}:${row.unitRef}`) ? 'update' : 'create', row as unknown as Record<string, unknown>, workspaceId)
    }
    for (const row of existing.filter((item) => !desiredKeys.has(`${item.priceBookId}:${item.unitRef}`))) {
      await addToOfflineMutations(TABLES.priceBookPrices, row.id, 'delete', { id: row.id, hardDelete: true }, workspaceId)
    }
  }

  await db.transaction('rw', db.price_book_unit_prices, async () => {
    if (existing.length) await db.price_book_unit_prices.bulkDelete(existing.map((row) => row.id))
    if (rows.length) await db.price_book_unit_prices.bulkPut(rows)
  })
  return rows
}
