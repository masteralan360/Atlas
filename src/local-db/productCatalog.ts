import { useEffect, useMemo, useState } from 'react'

import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { toCamelCase } from '@/lib/utils'
import { runSupabaseAction, normalizeSupabaseActionError } from '@/lib/supabaseRequest'
import { generateId } from '@/lib/utils'
import {
  completeWorkspaceDataHydration,
  failWorkspaceDataHydration,
  recordWorkspaceDataFetch,
  startWorkspaceDataHydration,
  updateWorkspaceDataHydrationProgress
} from '@/workspace/workspaceDataFreshness'

import { db } from './database'
import type { CurrencyCode, Inventory, Product } from './models'

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
  return product
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
