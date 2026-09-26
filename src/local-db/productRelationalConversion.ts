import { supabase } from '@/auth/supabase'
import { getActiveBusinessUserId, getActiveBusinessUserRole, isOnline } from '@/lib/network'
import { QUANTITY_EPSILON, roundQuantity } from '@/lib/quantity'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import {
  buildInventoryMovementTransactionId,
  createInventoryTransaction,
  hydrateInventoryTransactionsForReferences,
} from './inventoryTransactions'
import type {
  CurrencyCode,
  Inventory,
  PriceBookItem,
  PriceBookUnitPrice,
  Product,
  ProductUnitConversion,
  StockBatch,
} from './models'
import { normalizeProductSku, DuplicateProductSkuError, trimProductSku } from './productSku'
import { assertCurrentUserCanAccessStorage } from './storagePermissions'

export type RelationalConversionErrorCode =
  | 'online_required'
  | 'already_relational'
  | 'hidden_costs'
  | 'storage_access'
  | 'validation'
  | 'result_missing'

export class ProductRelationalConversionError extends Error {
  constructor(readonly code: RelationalConversionErrorCode) {
    super(code)
    this.name = 'ProductRelationalConversionError'
  }
}

export type RelationalConversionPriceBookInput = {
  priceBookId: string
  costPrice: number
  price: number
  parentPrice: number
  currency: CurrencyCode
}

export type ConvertSingleUnitProductInput = {
  workspaceId: string
  productId: string
  relationshipId: string
  factor: number
  parentPrice: number
  childIsDynamic: boolean
  initialStock: number
  storageId: string
  createdBy?: string | null
  product: Pick<
    Product,
    | 'sku'
    | 'name'
    | 'description'
    | 'categoryId'
    | 'category'
    | 'price'
    | 'costPrice'
    | 'minStockLevel'
    | 'currency'
    | 'imageUrl'
    | 'canBeReturned'
    | 'returnRules'
  >
  priceBookItems: RelationalConversionPriceBookInput[]
}

export type ConvertedRelationalProductState = {
  product: Product
  conversion: ProductUnitConversion
  inventory: Inventory[]
  stockBatches: StockBatch[]
  priceBookItems: PriceBookItem[]
  priceBookUnitPrices: PriceBookUnitPrice[]
}

function isFiniteNonnegative(value: number) {
  return Number.isFinite(value) && value >= 0
}

function validateInput(input: ConvertSingleUnitProductInput) {
  if (
    !input.workspaceId
    || !input.productId
    || !input.relationshipId
    || !input.storageId
    || !input.product.name.trim()
    || !input.product.sku.trim()
    || !Number.isFinite(input.factor)
    || input.factor <= 0
    || (!input.childIsDynamic && !Number.isInteger(input.factor))
    || !isFiniteNonnegative(input.parentPrice)
    || !isFiniteNonnegative(input.initialStock)
    || (!input.childIsDynamic && !Number.isInteger(input.initialStock))
    || !isFiniteNonnegative(input.product.price)
    || input.product.costPrice == null
    || !isFiniteNonnegative(input.product.costPrice)
    || !isFiniteNonnegative(input.product.minStockLevel)
  ) {
    throw new ProductRelationalConversionError('validation')
  }

  const priceBookIds = new Set<string>()
  for (const row of input.priceBookItems) {
    if (
      !row.priceBookId
      || priceBookIds.has(row.priceBookId)
      || !isFiniteNonnegative(row.costPrice)
      || !isFiniteNonnegative(row.price)
      || !isFiniteNonnegative(row.parentPrice)
    ) {
      throw new ProductRelationalConversionError('validation')
    }
    priceBookIds.add(row.priceBookId)
  }
}

function normalizeConversionError(error: unknown) {
  if (error instanceof ProductRelationalConversionError || error instanceof DuplicateProductSkuError) {
    return error
  }

  const normalized = normalizeSupabaseActionError(error)
  const message = normalized.message.toLowerCase()
  if (message.includes('single_unit_conversion_already_relational')) {
    return new ProductRelationalConversionError('already_relational')
  }
  if (message.includes('single_unit_conversion_hidden_costs')) {
    return new ProductRelationalConversionError('hidden_costs')
  }
  if (message.includes('single_unit_conversion_storage_access')) {
    return new ProductRelationalConversionError('storage_access')
  }
  if (message.includes('single_unit_conversion_invalid')) {
    return new ProductRelationalConversionError('validation')
  }
  if (message.includes('duplicate') && message.includes('sku')) {
    return new DuplicateProductSkuError()
  }
  return normalized
}

function buildRemotePayload(input: ConvertSingleUnitProductInput) {
  return {
    product_id: input.productId,
    relationship_id: input.relationshipId,
    factor: input.factor,
    parent_price: input.parentPrice,
    initial_stock: input.initialStock,
    storage_id: input.storageId,
    product: {
      sku: trimProductSku(input.product.sku),
      name: input.product.name.trim(),
      description: input.product.description,
      category_id: input.product.categoryId ?? null,
      category: input.product.category ?? null,
      price: input.product.price,
      cost_price: input.product.costPrice,
      min_stock_level: input.product.minStockLevel,
      currency: input.product.currency,
      image_url: input.product.imageUrl ?? '',
      can_be_returned: input.product.canBeReturned,
      return_rules: input.product.returnRules ?? '',
    },
    price_book_items: input.priceBookItems.map((row) => ({
      price_book_id: row.priceBookId,
      cost_price: row.costPrice,
      price: row.price,
      parent_price: row.parentPrice,
      currency: row.currency,
    })),
  }
}

function normalizeRemoteRow<T>(row: Record<string, unknown>, syncedAt: string): T {
  return {
    ...toCamelCase(row),
    syncStatus: 'synced',
    lastSyncedAt: syncedAt,
  } as T
}

function parseRemoteState(value: unknown, input: ConvertSingleUnitProductInput): ConvertedRelationalProductState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductRelationalConversionError('result_missing')
  }
  const result = value as Record<string, unknown>
  if (
    !result.product
    || typeof result.product !== 'object'
    || !result.conversion
    || typeof result.conversion !== 'object'
  ) {
    throw new ProductRelationalConversionError('result_missing')
  }

  const arrays = ['inventory', 'stock_batches', 'price_book_items', 'price_book_unit_prices'] as const
  if (arrays.some((key) => !Array.isArray(result[key]))) {
    throw new ProductRelationalConversionError('result_missing')
  }

  const syncedAt = new Date().toISOString()
  const product = normalizeRemoteRow<Product>(result.product as Record<string, unknown>, syncedAt)
  product.skuKey = normalizeProductSku(product.sku)
  const conversion = normalizeRemoteRow<ProductUnitConversion>(result.conversion as Record<string, unknown>, syncedAt)
  if (product.id !== input.productId || conversion.productId !== input.productId) {
    throw new ProductRelationalConversionError('result_missing')
  }

  return {
    product,
    conversion,
    inventory: (result.inventory as Record<string, unknown>[]).map((row) => normalizeRemoteRow<Inventory>(row, syncedAt)),
    stockBatches: (result.stock_batches as Record<string, unknown>[]).map((row) => normalizeRemoteRow<StockBatch>(row, syncedAt)),
    priceBookItems: (result.price_book_items as Record<string, unknown>[]).map((row) => normalizeRemoteRow<PriceBookItem>(row, syncedAt)),
    priceBookUnitPrices: (result.price_book_unit_prices as Record<string, unknown>[]).map((row) => normalizeRemoteRow<PriceBookUnitPrice>(row, syncedAt)),
  }
}

async function cacheRemoteState(state: ConvertedRelationalProductState, productId: string, storageId: string) {
  const storage = await db.storages.get(storageId)
  const activeInventory = state.inventory.filter((row) => !row.isDeleted)
  const product = {
    ...state.product,
    storageName: activeInventory.length === 1 && state.product.storageId === storageId
      ? storage?.name
      : undefined,
  }

  await db.transaction('rw', [
    db.products,
    db.inventory,
    db.stock_batches,
    db.product_unit_conversions,
    db.price_book_items,
    db.price_book_unit_prices,
  ], async () => {
    const [inventoryRows, batchRows, conversionRows, priceRows, unitPriceRows] = await Promise.all([
      db.inventory.where('productId').equals(productId).toArray(),
      db.stock_batches.where('productId').equals(productId).toArray(),
      db.product_unit_conversions.where('productId').equals(productId).toArray(),
      db.price_book_items.where('productId').equals(productId).toArray(),
      db.price_book_unit_prices.where('productId').equals(productId).toArray(),
    ])
    await Promise.all([
      inventoryRows.length ? db.inventory.bulkDelete(inventoryRows.map((row) => row.id)) : Promise.resolve(),
      batchRows.length ? db.stock_batches.bulkDelete(batchRows.map((row) => row.id)) : Promise.resolve(),
      conversionRows.length ? db.product_unit_conversions.bulkDelete(conversionRows.map((row) => row.id)) : Promise.resolve(),
      priceRows.length ? db.price_book_items.bulkDelete(priceRows.map((row) => row.id)) : Promise.resolve(),
      unitPriceRows.length ? db.price_book_unit_prices.bulkDelete(unitPriceRows.map((row) => row.id)) : Promise.resolve(),
    ])
    await db.products.put(product)
    if (state.inventory.length) await db.inventory.bulkPut(state.inventory)
    if (state.stockBatches.length) await db.stock_batches.bulkPut(state.stockBatches)
    await db.product_unit_conversions.put(state.conversion)
    if (state.priceBookItems.length) await db.price_book_items.bulkPut(state.priceBookItems)
    if (state.priceBookUnitPrices.length) await db.price_book_unit_prices.bulkPut(state.priceBookUnitPrices)
  })
  return { ...state, product }
}

async function assertLocalCostPermission(workspaceId: string) {
  const userId = getActiveBusinessUserId()
  if (getActiveBusinessUserRole(workspaceId) === 'admin' || !userId) return
  const hidden = await db.workspace_permissions
    .where('workspaceId')
    .equals(workspaceId)
    .and((row) => row.userUuid === userId && row.key === 'global.hideCosts')
    .first()
  if (hidden) throw new ProductRelationalConversionError('hidden_costs')
}

async function assertLocalSkuAvailable(product: Product, nextSku: string) {
  const skuKey = normalizeProductSku(nextSku)
  const matches = await db.products
    .where('[workspaceId+skuKey]')
    .equals([product.workspaceId, skuKey])
    .and((row) => !row.isDeleted && row.id !== product.id)
    .toArray()
  const familyId = product.parentProductId ?? product.id
  if (matches.some((row) => (row.parentProductId ?? row.id) !== familyId)) {
    throw new DuplicateProductSkuError()
  }
}

async function convertLocal(input: ConvertSingleUnitProductInput): Promise<ConvertedRelationalProductState> {
  const [product, relationship, existingConversion, inventoryRows, batchRows] = await Promise.all([
    db.products.get(input.productId),
    db.unit_relationships.get(input.relationshipId),
    db.product_unit_conversions.where('[workspaceId+productId]').equals([input.workspaceId, input.productId]).and((row) => !row.isDeleted).first(),
    db.inventory.where('productId').equals(input.productId).toArray(),
    db.stock_batches.where('productId').equals(input.productId).toArray(),
  ])
  if (!product || product.isDeleted || product.workspaceId !== input.workspaceId || product.isService) {
    throw new ProductRelationalConversionError('validation')
  }
  if (existingConversion) throw new ProductRelationalConversionError('already_relational')
  if (!relationship || relationship.isDeleted || relationship.isArchived || relationship.workspaceId !== input.workspaceId) {
    throw new ProductRelationalConversionError('validation')
  }

  await assertLocalCostPermission(input.workspaceId)
  await assertLocalSkuAvailable(product, input.product.sku)
  const storageIds = new Set([
    input.storageId,
    ...inventoryRows.map((row) => row.storageId),
    ...batchRows.map((row) => row.storageId),
  ])
  for (const storageId of storageIds) {
    await assertCurrentUserCanAccessStorage(input.workspaceId, storageId)
  }

  const selectedStorage = await db.storages.get(input.storageId)
  if (!selectedStorage || selectedStorage.isDeleted || selectedStorage.workspaceId !== input.workspaceId) {
    throw new ProductRelationalConversionError('validation')
  }

  return db.transaction('rw', [
    db.products,
    db.inventory,
    db.inventory_transactions,
    db.stock_batches,
    db.product_unit_conversions,
    db.price_books,
    db.price_book_items,
    db.price_book_unit_prices,
  ], async () => {
    const selectedBooks = await db.price_books.bulkGet(input.priceBookItems.map((row) => row.priceBookId))
    if (selectedBooks.some((book) => !book || book.isDeleted || book.workspaceId !== input.workspaceId)) {
      throw new ProductRelationalConversionError('validation')
    }

    const now = new Date().toISOString()
    const createdBy = input.createdBy ?? getActiveBusinessUserId() ?? null
    const metadata = { syncStatus: 'synced' as const, lastSyncedAt: now }
    const allInventoryRows = await db.inventory.where('productId').equals(input.productId).toArray()
    const selectedInventory = allInventoryRows.find((row) => row.storageId === input.storageId)
    const nextInventory = allInventoryRows.map((row) => ({
      ...row,
      quantity: row.storageId === input.storageId && input.initialStock > 0
        ? roundQuantity(input.initialStock)
        : 0,
      isDeleted: row.storageId !== input.storageId || input.initialStock <= 0,
      updatedAt: now,
      version: row.version + 1,
      ...metadata,
    }))
    if (input.initialStock > 0 && !selectedInventory) {
      nextInventory.push({
        id: generateId(),
        workspaceId: input.workspaceId,
        productId: input.productId,
        storageId: input.storageId,
        quantity: roundQuantity(input.initialStock),
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...metadata,
      })
    }

    const nextBatches = (await db.stock_batches.where('productId').equals(input.productId).toArray()).map((row) => ({
      ...row,
      quantity: 0,
      updatedAt: now,
      version: row.version + 1,
      ...metadata,
    }))
    const inactiveConversion = await db.product_unit_conversions
      .where('[workspaceId+productId]')
      .equals([input.workspaceId, input.productId])
      .first()
    const conversion: ProductUnitConversion = {
      id: inactiveConversion?.id ?? generateId(),
      workspaceId: input.workspaceId,
      productId: input.productId,
      relationshipId: relationship.id,
      factor: input.factor,
      parentPrice: input.parentPrice,
      createdBy: inactiveConversion?.createdBy ?? createdBy,
      createdAt: inactiveConversion?.createdAt ?? now,
      updatedAt: now,
      version: (inactiveConversion?.version ?? 0) + 1,
      isDeleted: false,
      ...metadata,
    }

    const existingPriceRows = await db.price_book_items.where('[workspaceId+productId]').equals([input.workspaceId, input.productId]).toArray()
    const existingPriceByBook = new Map(existingPriceRows.map((row) => [row.priceBookId, row]))
    const selectedBookIds = new Set(input.priceBookItems.map((row) => row.priceBookId))
    const nextPriceRows: PriceBookItem[] = [
      ...input.priceBookItems.map((row) => {
        const existing = existingPriceByBook.get(row.priceBookId)
        return {
          id: existing?.id ?? generateId(),
          workspaceId: input.workspaceId,
          productId: input.productId,
          priceBookId: row.priceBookId,
          costPrice: row.costPrice,
          price: row.price,
          currency: row.currency,
          createdBy: existing?.createdBy ?? createdBy,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          version: (existing?.version ?? 0) + 1,
          isDeleted: false,
          ...metadata,
        }
      }),
      ...existingPriceRows.filter((row) => !selectedBookIds.has(row.priceBookId)).map((row) => ({
        ...row,
        isDeleted: true,
        updatedAt: now,
        version: row.version + 1,
        ...metadata,
      })),
    ]

    const existingUnitPrices = await db.price_book_unit_prices.where('[workspaceId+productId]').equals([input.workspaceId, input.productId]).toArray()
    const existingUnitPriceByBook = new Map(existingUnitPrices.map((row) => [row.priceBookId, row]))
    const nextUnitPrices: PriceBookUnitPrice[] = input.priceBookItems.map((row) => {
      const existing = existingUnitPriceByBook.get(row.priceBookId)
      return {
        id: existing?.id ?? generateId(),
        workspaceId: input.workspaceId,
        productId: input.productId,
        priceBookId: row.priceBookId,
        unitRef: relationship.parentUnitRef,
        price: row.parentPrice,
        currency: row.currency,
        createdBy: existing?.createdBy ?? createdBy,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        version: (existing?.version ?? 0) + 1,
        isDeleted: false,
        ...metadata,
      }
    })

    const productRow: Product = {
      ...product,
      ...input.product,
      sku: trimProductSku(input.product.sku),
      skuKey: normalizeProductSku(input.product.sku),
      unit: relationship.childUnitCode,
      quantity: roundQuantity(input.initialStock),
      storageId: input.initialStock > 0 ? input.storageId : null,
      storageName: input.initialStock > 0 ? selectedStorage.name : undefined,
      updatedAt: now,
      version: product.version + 1,
      ...metadata,
    }

    await db.products.put(productRow)
    if (nextInventory.length) await db.inventory.bulkPut(nextInventory)
    for (const row of nextInventory) {
      const previous = allInventoryRows.find((candidate) => candidate.storageId === row.storageId)
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
        createdBy,
      }, {
        id: buildInventoryMovementTransactionId(input.workspaceId, input.productId, row.storageId, row.version),
        timestamp: now,
        skipRemoteSync: true,
      })
    }
    if (nextBatches.length) await db.stock_batches.bulkPut(nextBatches)
    await db.product_unit_conversions.put(conversion)
    if (nextPriceRows.length) await db.price_book_items.bulkPut(nextPriceRows)
    if (existingUnitPrices.length) await db.price_book_unit_prices.bulkDelete(existingUnitPrices.map((row) => row.id))
    if (nextUnitPrices.length) await db.price_book_unit_prices.bulkPut(nextUnitPrices)

    return {
      product: productRow,
      conversion,
      inventory: nextInventory,
      stockBatches: nextBatches,
      priceBookItems: nextPriceRows,
      priceBookUnitPrices: nextUnitPrices,
    }
  })
}

/**
 * Atomically turns a persisted single-unit product into a related-unit product.
 * Cloud/Hybrid workspaces use one authoritative RPC; Local workspaces use one
 * Dexie transaction, which is mirrored to SQLite by the database middleware.
 */
export async function convertSingleUnitProductToRelationship(
  input: ConvertSingleUnitProductInput,
): Promise<ConvertedRelationalProductState> {
  validateInput(input)

  if (isLocalWorkspaceMode(input.workspaceId)) {
    return convertLocal(input)
  }
  if (!isOnline(input.workspaceId)) {
    throw new ProductRelationalConversionError('online_required')
  }

  try {
    const { data, error } = await runSupabaseAction('products.convertToRelationalUnits', () => supabase.rpc(
      'convert_single_unit_product_to_relationship',
      { p_payload: buildRemotePayload(input) },
    ))
    if (error) throw error
    const state = parseRemoteState(data, input)
    const cachedState = await cacheRemoteState(state, input.productId, input.storageId)
    await hydrateInventoryTransactionsForReferences(input.workspaceId, [input.productId])
    return cachedState
  } catch (error) {
    throw normalizeConversionError(error)
  }
}
