import { useEffect, useMemo, useState } from 'react'

import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { toCamelCase } from '@/lib/utils'
import { runSupabaseAction, normalizeSupabaseActionError } from '@/lib/supabaseRequest'
import { generateId } from '@/lib/utils'
import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import {
  completeWorkspaceDataHydration,
  failWorkspaceDataHydration,
  recordWorkspaceDataFetch,
  startWorkspaceDataHydration,
  updateWorkspaceDataHydrationProgress
} from '@/workspace/workspaceDataFreshness'

import { db } from './database'
import type { CurrencyCode, Inventory, Product } from './models'

export type ProductAutocompleteSuggestion = Product

export type ProductCatalogSort =
  | 'name_asc'
  | 'name_desc'
  | 'sku_asc'
  | 'sku_desc'
  | 'price_asc'
  | 'price_desc'
  | 'stock_asc'
  | 'stock_desc'
  | 'date_asc'
  | 'date_desc'

export interface ProductCatalogPageQuery {
  workspaceId?: string
  search: string
  catalogType: 'all' | 'products' | 'services'
  categoryIds: string[]
  storageIds: string[]
  currencies: CurrencyCode[]
  minPrice: string
  maxPrice: string
  minStock: string
  maxStock: string
  sort: ProductCatalogSort
  page: number
  pageSize: number
  enabled?: boolean
}

export interface ProductCatalogPage {
  products: Product[]
  inventoryRows: Inventory[]
  matchedProductIds: string[]
  totalCount: number
  familyCount: number
  pageCount: number
}

const EMPTY_PAGE: ProductCatalogPage = {
  products: [],
  inventoryRows: [],
  matchedProductIds: [],
  totalCount: 0,
  familyCount: 0,
  pageCount: 1
}

function parseOptionalNumber(value: string) {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeRemoteProduct(value: unknown, workspaceId: string, syncedAt: string): Product {
  const product = toCamelCase(value as Record<string, unknown>) as unknown as Product
  product.workspaceId = workspaceId
  product.syncStatus = 'synced'
  product.lastSyncedAt = syncedAt
  product.isDeleted = false
  product.isService = product.isService === true
  product.sku = product.sku ?? ''
  product.unit = product.unit ?? ''
  product.quantity = Number(product.quantity ?? 0)
  product.minStockLevel = Number(product.minStockLevel ?? 0)
  product.price = Number(product.price ?? 0)
  product.costPrice = product.costPrice == null ? null : Number(product.costPrice)
  product.barcodes = Array.isArray(product.barcodes)
    ? product.barcodes.filter((barcode): barcode is string => typeof barcode === 'string')
    : []
  delete (product as Product & { autocompleteIsSupport?: boolean }).autocompleteIsSupport
  return product
}

function normalizeAutocompleteInventory(value: unknown, workspaceId: string, syncedAt: string): Inventory {
  const inventory = toCamelCase(value as Record<string, unknown>) as unknown as Inventory
  inventory.workspaceId = workspaceId
  inventory.syncStatus = 'synced'
  inventory.lastSyncedAt = syncedAt
  inventory.isDeleted = false
  inventory.quantity = Number(inventory.quantity ?? 0)
  return inventory
}

async function readLocalProductAutocompleteSuggestions(
  workspaceId: string,
  normalizedSearch: string,
  excludedCategoryIds: readonly string[],
  limit: number,
  pendingOnly = false,
): Promise<ProductAutocompleteSuggestion[]> {
  const excludedCategories = new Set(excludedCategoryIds)
  const matchesSearch = (product: Product) => !product.isDeleted
    && (!pendingOnly || product.syncStatus === 'pending' || product.syncStatus === 'conflict')
    && !excludedCategories.has(product.categoryId || '')
  const nameMatches = await db.products
    .where('[workspaceId+name+id]')
    .between([workspaceId, '', ''], [workspaceId, '\uffff', '\uffff'])
    .filter((product) => matchesSearch(product)
      && String(product.name ?? '').toLocaleLowerCase().includes(normalizedSearch))
    .limit(limit)
    .toArray()
  const skuMatches = await db.products
    .where('[workspaceId+sku+id]')
    .between([workspaceId, '', ''], [workspaceId, '\uffff', '\uffff'])
    .filter((product) => matchesSearch(product)
      && String(product.sku ?? '').toLocaleLowerCase().includes(normalizedSearch))
    .limit(limit)
    .toArray()
  const productsById = new Map([...nameMatches, ...skuMatches].map((product) => [product.id, product]))
  const products = [...productsById.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, limit)
  const familyIds = [...new Set(products.map((product) => product.parentProductId || product.id))]
  const [parentRows, familyChildren] = await Promise.all([
    familyIds.length ? db.products.bulkGet(familyIds) : Promise.resolve([]),
    familyIds.length
      ? db.products
        .where('[workspaceId+parentProductId]')
        .anyOf(familyIds.map((familyId) => [workspaceId, familyId]))
        .filter((product) => product.workspaceId === workspaceId
          && !product.isDeleted
          && !excludedCategories.has(product.categoryId || ''))
        .limit(limit * 8)
        .toArray()
      : Promise.resolve([]),
  ])
  const parentById = new Map<string, Product>()
  for (const product of parentRows) {
    if (!product
      || product.workspaceId !== workspaceId
      || product.isDeleted
      || excludedCategories.has(product.categoryId || '')) continue
    parentById.set(product.id, product)
  }
  const childrenByFamilyId = new Map<string, Product[]>()
  for (const child of familyChildren) {
    if (!child.parentProductId) continue
    const current = childrenByFamilyId.get(child.parentProductId) ?? []
    current.push(child)
    childrenByFamilyId.set(child.parentProductId, current)
  }
  const suggestions: ProductAutocompleteSuggestion[] = []
  const addedIds = new Set<string>()
  for (const familyId of familyIds) {
    const parent = parentById.get(familyId)
    if (parent && !addedIds.has(parent.id)) {
      suggestions.push(parent)
      addedIds.add(parent.id)
    }

    const familyMatches = products
      .filter((product) => (product.parentProductId || product.id) === familyId)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    for (const product of familyMatches) {
      if (addedIds.has(product.id)) continue
      suggestions.push(product)
      addedIds.add(product.id)
    }

    const siblings = childrenByFamilyId.get(familyId) ?? []
    for (const sibling of siblings.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))) {
      if (addedIds.has(sibling.id)) continue
      suggestions.push(sibling)
      addedIds.add(sibling.id)
    }
    if (suggestions.length >= limit) break
  }
  return suggestions.slice(0, limit)
}

/** Fetches a small typed-search result set without hydrating the product catalog. */
export async function searchProductAutocompleteSuggestions(
  workspaceId: string,
  search: string,
  excludedCategoryIds: readonly string[],
  excludedStorageIds: readonly string[],
): Promise<ProductAutocompleteSuggestion[]> {
  const normalizedSearch = search.trim().toLocaleLowerCase()
  if (!workspaceId || normalizedSearch.length < 2) return []

  if (isOnline(workspaceId) && !isLocalWorkspaceMode(workspaceId)) {
    const response = await runSupabaseAction('products.autocompleteSearch', () =>
      getSupabaseClientForTable('products').rpc('search_products_for_autocomplete', {
        p_workspace_id: workspaceId,
        p_search: search.trim(),
        p_excluded_category_ids: [...excludedCategoryIds],
        p_excluded_storage_ids: [...excludedStorageIds],
        p_limit: 8,
      })
    )
    if (response.error) throw normalizeSupabaseActionError(response.error)
    const result = response.data as { products?: unknown[]; inventory?: unknown[] } | null
    if (!result || !Array.isArray(result.products)) {
      throw new Error('The product autocomplete response was invalid.')
    }

    const syncedAt = new Date().toISOString()
    const productRows = result.products as Array<Record<string, unknown>>
    const familySupportIds = new Set(productRows.flatMap((row) => (
      row.autocomplete_is_support === true && typeof row.id === 'string' ? [row.id] : []
    )))
    const products = productRows.map((value) => normalizeRemoteProduct(value, workspaceId, syncedAt))
    const inventoryRows = (Array.isArray(result.inventory) ? result.inventory : [])
      .map((value) => normalizeAutocompleteInventory(value, workspaceId, syncedAt))

    if (products.some((product) => product.workspaceId !== workspaceId || !product.id)
      || inventoryRows.some((row) => row.workspaceId !== workspaceId || !row.id)) {
      throw new Error('The product autocomplete returned a record outside the active workspace.')
    }

    const cachedProducts = await db.products.bulkGet(products.map((product) => product.id))
    const productsToCache = products.filter((_, index) => {
      const cached = cachedProducts[index]
      return cached?.syncStatus !== 'pending' && cached?.syncStatus !== 'conflict'
    })
    if (productsToCache.length) await db.products.bulkPut(productsToCache)

    if (inventoryRows.length) {
      const cachedInventory = await db.inventory.bulkGet(inventoryRows.map((row) => row.id))
      const inventoryToCache = inventoryRows.filter((_, index) => {
        const cached = cachedInventory[index]
        return cached?.syncStatus !== 'pending' && cached?.syncStatus !== 'conflict'
      })
      if (inventoryToCache.length) await db.inventory.bulkPut(inventoryToCache)
    }

    const normalizedProducts = products.map((product, index) => {
      const cached = cachedProducts[index]
      const candidate = cached?.syncStatus === 'pending' || cached?.syncStatus === 'conflict'
        ? cached
        : product
      const stillMatches = familySupportIds.has(candidate.id)
        || String(candidate.name ?? '').toLocaleLowerCase().includes(normalizedSearch)
        || String(candidate.sku ?? '').toLocaleLowerCase().includes(normalizedSearch)
      return stillMatches ? candidate : null
    }).filter((product): product is ProductAutocompleteSuggestion => product !== null)

    const localPendingProducts = await readLocalProductAutocompleteSuggestions(
      workspaceId,
      normalizedSearch,
      excludedCategoryIds,
      8,
      true,
    )
    const mergedProducts = [...localPendingProducts]
    const mergedIndexes = new Map(mergedProducts.map((product, index) => [product.id, index]))
    for (const product of normalizedProducts) {
      const existingIndex = mergedIndexes.get(product.id)
      if (existingIndex === undefined) {
        mergedIndexes.set(product.id, mergedProducts.length)
        mergedProducts.push(product)
      } else {
        mergedProducts[existingIndex] = product
      }
    }
    return mergedProducts.slice(0, 16)
  }

  return readLocalProductAutocompleteSuggestions(workspaceId, normalizedSearch, excludedCategoryIds, 8)
}

async function readProductCatalogPage(query: ProductCatalogPageQuery): Promise<ProductCatalogPage> {
  const workspaceId = query.workspaceId
  if (!workspaceId) return EMPTY_PAGE

  const fetchStartedAt = new Date().toISOString()
  const response = await runSupabaseAction('products.catalogPage', () =>
    getSupabaseClientForTable('products').rpc('get_products_catalog_page', {
      p_search: query.search.trim(),
      p_catalog_type: query.catalogType,
      p_category_ids: query.categoryIds,
      p_storage_ids: query.storageIds,
      p_currencies: query.currencies.map((currency) => currency.toLowerCase()),
      p_min_price: parseOptionalNumber(query.minPrice),
      p_max_price: parseOptionalNumber(query.maxPrice),
      p_min_stock: parseOptionalNumber(query.minStock),
      p_max_stock: parseOptionalNumber(query.maxStock),
      p_sort: query.sort,
      p_page: query.page,
      p_page_size: query.pageSize
    })
  )

  if (response.error) throw normalizeSupabaseActionError(response.error)
  const result = response.data as {
    products?: unknown[]
    inventory?: unknown[]
    matched_product_ids?: unknown[]
    total_count?: number | string
    family_count?: number | string
    page_count?: number | string
  } | null
  if (!result || !Array.isArray(result.products)) {
    throw new Error('The product catalog page response was invalid.')
  }

  const syncedAt = new Date().toISOString()
  const products = result.products.map((row) => normalizeRemoteProduct(row, workspaceId, syncedAt))
  const inventoryRows = (Array.isArray(result.inventory) ? result.inventory : []).map((value) => {
    const inventory = toCamelCase(value as Record<string, unknown>) as unknown as Inventory
    inventory.workspaceId = workspaceId
    inventory.syncStatus = 'synced'
    inventory.lastSyncedAt = syncedAt
    inventory.isDeleted = false
    inventory.quantity = Number(inventory.quantity ?? 0)
    return inventory
  })
  if (products.some((product) => product.workspaceId !== workspaceId || !product.id)) {
    throw new Error('The product catalog page returned a product outside the active workspace.')
  }
  if (inventoryRows.some((row) => row.workspaceId !== workspaceId || !row.id)) {
    throw new Error('The product catalog page returned inventory outside the active workspace.')
  }

  // Keep rows that the user has browsed available to detail forms and offline
  // reads without reconciling or deleting the rest of the local catalog.
  if (products.length > 0) {
    const existingRows = await db.products.bulkGet(products.map((product) => product.id))
    const rowsToCache = products.filter((product, index) => {
      const existing = existingRows[index]
      if (!existing || existing.syncStatus !== 'synced') return !existing

      const localUpdatedAt = Date.parse(existing.updatedAt || '')
      const remoteUpdatedAt = Date.parse(product.updatedAt || '')
      const localChangedDuringFetch = Number.isFinite(localUpdatedAt)
        && localUpdatedAt > Date.parse(fetchStartedAt)
      const localIsNewer = Number.isFinite(localUpdatedAt)
        && Number.isFinite(remoteUpdatedAt)
        && localUpdatedAt > remoteUpdatedAt
      return !localChangedDuringFetch && !localIsNewer
    })
    if (rowsToCache.length > 0) await db.products.bulkPut(rowsToCache)
  }
  if (inventoryRows.length > 0) {
    const existingRows = await db.inventory.bulkGet(inventoryRows.map((row) => row.id))
    const rowsToCache = inventoryRows.filter((row, index) => {
      const existing = existingRows[index]
      if (!existing || existing.syncStatus !== 'synced') return !existing

      const localUpdatedAt = Date.parse(existing.updatedAt || '')
      const remoteUpdatedAt = Date.parse(row.updatedAt || '')
      const localChangedDuringFetch = Number.isFinite(localUpdatedAt)
        && localUpdatedAt > Date.parse(fetchStartedAt)
      const localIsNewer = Number.isFinite(localUpdatedAt)
        && Number.isFinite(remoteUpdatedAt)
        && localUpdatedAt > remoteUpdatedAt
      return !localChangedDuringFetch && !localIsNewer
    })
    if (rowsToCache.length > 0) await db.inventory.bulkPut(rowsToCache)
  }

  return {
    products,
    inventoryRows,
    matchedProductIds: Array.isArray(result.matched_product_ids)
      ? result.matched_product_ids.filter((id): id is string => typeof id === 'string')
      : [],
    totalCount: Number(result.total_count) || 0,
    familyCount: Number(result.family_count) || 0,
    pageCount: Math.max(1, Number(result.page_count) || 1)
  }
}

export async function fetchProductCatalogPage(query: ProductCatalogPageQuery): Promise<ProductCatalogPage> {
  if (!query.workspaceId) return EMPTY_PAGE

  const operationId = generateId()
  startWorkspaceDataHydration(query.workspaceId, 'supabase', 'products', operationId)
  try {
    const result = await readProductCatalogPage(query)
    updateWorkspaceDataHydrationProgress(
      query.workspaceId,
      'supabase',
      'products',
      result.products.length,
      operationId
    )
    const completedAt = new Date().toISOString()
    recordWorkspaceDataFetch(query.workspaceId, 'supabase', completedAt, 'products')
    completeWorkspaceDataHydration(query.workspaceId, 'supabase', 'products', completedAt, operationId)
    return result
  } catch (error) {
    failWorkspaceDataHydration(query.workspaceId, 'supabase', 'products', undefined, operationId)
    throw error
  }
}

export async function fetchAllProductCatalogMatches(
  query: Omit<ProductCatalogPageQuery, 'page' | 'pageSize' | 'enabled'>
) {
  const pageSize = 100
  const firstPage = await fetchProductCatalogPage({ ...query, page: 1, pageSize })
  const productsById = new Map<string, Product>()
  const collectMatches = (result: ProductCatalogPage) => {
    const matchedIds = new Set(result.matchedProductIds)
    for (const product of result.products) {
      if (matchedIds.has(product.id)) productsById.set(product.id, product)
    }
  }

  collectMatches(firstPage)
  for (let page = 2; page <= firstPage.pageCount; page += 1) {
    collectMatches(await fetchProductCatalogPage({ ...query, page, pageSize }))
  }

  return Array.from(productsById.values())
}

export function useProductCatalogPage(query: ProductCatalogPageQuery) {
  const [page, setPage] = useState<ProductCatalogPage>(EMPTY_PAGE)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const queryKey = useMemo(() => JSON.stringify(query), [query])
  const request = useMemo(() => JSON.parse(queryKey) as ProductCatalogPageQuery, [queryKey])

  useEffect(() => {
    if (!request.enabled || !request.workspaceId) {
      setIsLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)
    void fetchProductCatalogPage(request)
      .then((result) => {
        if (!cancelled) setPage(result)
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
    // request is stable across renders with the same serialized query.
  }, [queryKey, request])

  return { ...page, isLoading, error }
}
