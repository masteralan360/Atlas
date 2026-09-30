import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline, getActiveBusinessUserId } from '@/lib/network'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { normalizeUnitCode, type Product, type ProductUom, type UnitRef } from './models'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { fetchTableFromSupabase } from './hooks'
import { addToOfflineMutations } from './offlineMutations'

const TABLE = 'product_uoms'

export type ProductUomInput = {
  unitRef: UnitRef
  unitCode: string
  coefficient: number
  isBase?: boolean
  isActive?: boolean
  isDefaultSelling?: boolean
  sellingPrice: number
  costPrice: number | null
  minimumSellingPrice: number | null
  sku?: string | null
  barcode?: string | null
}

export class ProductUomValidationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ProductUomValidationError'
  }
}

export function useProductUomCatalogState(workspaceId?: string) {
  const online = useNetworkStatus()
  const [remoteState, setRemoteState] = useState<{ key: string; ready: boolean; error: unknown | null }>({
    key: '',
    ready: false,
    error: null,
  })
  const rows = useLiveQuery(
    () => workspaceId
      ? db.product_uoms.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  )

  useEffect(() => {
    const key = `${workspaceId ?? ''}:${online}`
    let cancelled = false
    if (!workspaceId || !online || isLocalWorkspaceMode(workspaceId)) {
      setRemoteState({ key, ready: true, error: null })
      return () => { cancelled = true }
    }
    setRemoteState({ key, ready: false, error: null })
    void fetchTableFromSupabase(TABLE, db.product_uoms, workspaceId)
      .then(() => { if (!cancelled) setRemoteState({ key, ready: true, error: null }) })
      .catch((error) => { if (!cancelled) setRemoteState({ key, ready: true, error }) })
    return () => { cancelled = true }
  }, [online, workspaceId])

  const key = `${workspaceId ?? ''}:${online}`
  return {
    rows: rows ?? [],
    isReady: rows !== undefined && remoteState.key === key && remoteState.ready,
    error: remoteState.key === key ? remoteState.error : null,
  }
}

export function useProductUoms(workspaceId?: string) {
  return useProductUomCatalogState(workspaceId).rows
}

function usesCloud(workspaceId: string) {
  return !isLocalWorkspaceMode(workspaceId)
}

function makeMetadata(workspaceId: string, now: string) {
  const synced = !usesCloud(workspaceId) || isOnline(workspaceId)
  return {
    syncStatus: synced ? 'synced' as const : 'pending' as const,
    lastSyncedAt: synced ? now : null,
  }
}

function unitIdentity(code: string) {
  return normalizeUnitCode(code).toLocaleLowerCase()
}

export function validateProductUoms(rows: readonly ProductUomInput[]) {
  const bases = rows.filter((row) => row.isBase)
  if (bases.length !== 1) throw new ProductUomValidationError('product_uom_base_required')
  if (Math.abs(Number(bases[0].coefficient) - 1) > 1e-9) {
    throw new ProductUomValidationError('product_uom_base_coefficient')
  }

  const identities = new Set<string>()
  const skus = new Set<string>()
  const barcodes = new Set<string>()
  let defaultCount = 0
  for (const row of rows) {
    const code = normalizeUnitCode(row.unitCode)
    const coefficient = Number(row.coefficient)
    if (!row.unitRef || !code || !Number.isFinite(coefficient) || coefficient <= 0
      || Math.abs(coefficient * 1_000_000 - Math.round(coefficient * 1_000_000)) > 1e-7) {
      throw new ProductUomValidationError('product_uom_invalid')
    }
    if (row.isBase && coefficient !== 1) throw new ProductUomValidationError('product_uom_base_coefficient')
    if (!row.isBase && coefficient === 1) throw new ProductUomValidationError('product_uom_non_base_coefficient_one')
    const identity = row.unitRef.toLocaleLowerCase()
    const codeIdentity = unitIdentity(code)
    if (identities.has(identity) || identities.has(`code:${codeIdentity}`)) {
      throw new ProductUomValidationError('product_uom_duplicate')
    }
    identities.add(identity)
    identities.add(`code:${codeIdentity}`)
    for (const [value, values] of [[row.sku, skus], [row.barcode, barcodes]] as const) {
      const normalized = value?.trim().toLocaleLowerCase()
      if (!normalized) continue
      if (values.has(normalized)) throw new ProductUomValidationError('product_uom_duplicate')
      values.add(normalized)
    }
    if (row.isDefaultSelling) {
      defaultCount += 1
      if (row.isActive === false) throw new ProductUomValidationError('product_uom_default_inactive')
    }
    for (const value of [row.sellingPrice, row.costPrice, row.minimumSellingPrice]) {
      if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        throw new ProductUomValidationError('product_uom_price_invalid')
      }
    }
    if (row.isActive === false && row.isBase) {
      throw new ProductUomValidationError('product_uom_base_inactive')
    }
  }
  if (defaultCount === 0) throw new ProductUomValidationError('product_uom_default_required')
  if (defaultCount > 1) throw new ProductUomValidationError('product_uom_multiple_defaults')
}

function buildBaseInput(product: Product, base: ProductUomInput): ProductUomInput {
  return {
    ...base,
    unitCode: normalizeUnitCode(product.unit),
    coefficient: 1,
    isBase: true,
    isActive: true,
    sellingPrice: product.price,
    costPrice: product.costPrice,
    minimumSellingPrice: product.minimumSellingPrice ?? null,
    isDefaultSelling: base.isDefaultSelling ?? true,
  }
}

async function remoteUpsert(row: ProductUom) {
  const payload = toSnakeCase({ ...row, syncStatus: undefined, lastSyncedAt: undefined })
  const { data, error } = await runSupabaseAction('productUoms.upsert', () => supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'product_id,unit_ref' })
    .select('*')
    .single())
  if (error) throw normalizeSupabaseActionError(error)
  return {
    ...toCamelCase(data as Record<string, unknown>),
    syncStatus: 'synced' as const,
    lastSyncedAt: row.updatedAt,
  } as ProductUom
}

async function hasUomHistory(productId: string) {
  const [sales, movements, saleOrders, purchaseOrders] = await Promise.all([
    db.sale_items.where('productId').equals(productId).first(),
    db.inventory_transactions.where('productId').equals(productId).first(),
    db.sales_orders.toArray(),
    db.purchase_orders.toArray(),
  ])
  const orderHasProduct = (items: unknown) => Array.isArray(items)
    && items.some((item) => Boolean(item && typeof item === 'object'
      && (item as Record<string, unknown>).productId === productId))
  return Boolean(sales || movements || saleOrders.some((row) => orderHasProduct(row.items))
    || purchaseOrders.some((row) => orderHasProduct(row.items)))
}

export async function assertProductBaseUnitChangeAllowed(workspaceId: string, productId: string, nextUnitCode: string) {
  const product = await db.products.get(productId)
  if (!product || product.workspaceId !== workspaceId || product.isDeleted) {
    throw new ProductUomValidationError('product_uom_product_missing')
  }
  if (unitIdentity(product.unit) === unitIdentity(nextUnitCode)) return
  const inventoryRows = await db.inventory.where('productId').equals(productId).toArray()
  if (inventoryRows.some((row) => Math.abs(row.quantity) > 1e-9) || await hasUomHistory(productId)) {
    throw new ProductUomValidationError('product_uom_base_change_has_history')
  }
}

/**
 * Replaces the active product UoM configuration. Removed choices are archived
 * in place, retaining IDs referenced by old sales, returns and orders.
 */
export async function replaceProductUoms(
  workspaceId: string,
  productId: string,
  inputRows: readonly ProductUomInput[],
) {
  const product = await db.products.get(productId)
  if (!product || product.workspaceId !== workspaceId || product.isDeleted) {
    throw new ProductUomValidationError('product_uom_product_missing')
  }

  const baseInput = inputRows.find((row) => row.isBase)
  if (!baseInput) throw new ProductUomValidationError('product_uom_base_required')
  const nextRows = [buildBaseInput(product, baseInput), ...inputRows.filter((row) => !row.isBase)]
  validateProductUoms(nextRows)

  const oldBase = await db.product_uoms
    .where('[workspaceId+productId]')
    .equals([workspaceId, productId])
    .and((row) => row.isBase && !row.isDeleted && row.isActive)
    .first()
  const baseUnitChanged = oldBase
    ? oldBase.unitRef !== baseInput.unitRef
    : unitIdentity(product.unit) !== unitIdentity(baseInput.unitCode)
  const inventoryRows = await db.inventory.where('productId').equals(productId).toArray()
  if (baseUnitChanged && (inventoryRows.some((row) => Math.abs(row.quantity) > 1e-9) || await hasUomHistory(productId))) {
    throw new ProductUomValidationError('product_uom_base_change_has_history')
  }

  const existing = await db.product_uoms
    .where('[workspaceId+productId]')
    .equals([workspaceId, productId])
    .toArray()
  const existingByRef = new Map(existing.map((row) => [row.unitRef, row]))
  const submittedRefs = new Set(nextRows.map((row) => row.unitRef))
  const now = new Date().toISOString()
  const actorId = getActiveBusinessUserId() ?? null
  const rows: ProductUom[] = nextRows.map((draft) => {
    const prior = existingByRef.get(draft.unitRef)
    return {
      id: prior?.id ?? generateId(),
      workspaceId,
      productId,
      unitRef: draft.unitRef,
      unitCode: normalizeUnitCode(draft.unitCode),
      coefficient: draft.isBase ? 1 : Number(draft.coefficient),
      isBase: draft.isBase === true,
      isActive: draft.isActive !== false,
      isDefaultSelling: draft.isDefaultSelling === true,
      sellingPrice: Number(draft.sellingPrice),
      costPrice: draft.costPrice == null ? null : Number(draft.costPrice),
      minimumSellingPrice: draft.minimumSellingPrice == null ? null : Number(draft.minimumSellingPrice),
      sku: draft.sku?.trim() || null,
      barcode: draft.barcode?.trim() || null,
      createdBy: prior?.createdBy ?? actorId,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      version: (prior?.version ?? 0) + 1,
      isDeleted: false,
      ...makeMetadata(workspaceId, now),
    } satisfies ProductUom
  })

  // The database enforces one active default selling UoM. Cloud writes are
  // sequential requests, so demote an old default before promoting its
  // replacement; otherwise the intermediate row would trip the unique index.
  const desiredDefaultRef = nextRows.find((row) => row.isDefaultSelling)?.unitRef
  const desiredBaseRef = baseInput.unitRef
  if (usesCloud(workspaceId) && isOnline(workspaceId)) {
    for (const prior of existing.filter((row) => !row.isDeleted && (
      (row.isDefaultSelling && (row.unitRef !== desiredDefaultRef || !row.isActive))
      || (row.isBase && row.unitRef !== desiredBaseRef && row.isActive)
    ))) {
      const demoted = await remoteUpsert({
        ...prior,
        isBase: prior.unitRef === desiredBaseRef ? prior.isBase : false,
        isActive: prior.unitRef === desiredBaseRef ? prior.isActive : false,
        isDefaultSelling: false,
        updatedAt: now,
        version: prior.version + 1,
        ...makeMetadata(workspaceId, now),
      })
      await db.product_uoms.put(demoted)
      existingByRef.set(prior.unitRef, demoted)
    }
  }

  for (const prior of existing.filter((row) => !submittedRefs.has(row.unitRef) && !row.isDeleted)) {
    const current = existingByRef.get(prior.unitRef) ?? prior
    if (!current.isBase && !current.isActive && !current.isDefaultSelling) continue
    rows.push({
      ...current,
      isBase: false,
      isActive: false,
      isDefaultSelling: false,
      updatedAt: now,
      version: current.version + 1,
      ...makeMetadata(workspaceId, now),
    })
  }

  const persisted: ProductUom[] = []
  for (const row of rows) {
    if (usesCloud(workspaceId) && isOnline(workspaceId)) {
      persisted.push(await remoteUpsert(row))
    } else {
      const pending = usesCloud(workspaceId)
        ? { ...row, syncStatus: 'pending' as const, lastSyncedAt: null }
        : row
      if (usesCloud(workspaceId)) {
        await addToOfflineMutations(TABLE, pending.id, existingByRef.has(row.unitRef) ? 'update' : 'create',
          pending as unknown as Record<string, unknown>, workspaceId)
      }
      persisted.push(pending)
    }
  }

  await db.product_uoms.bulkPut(persisted)
  return persisted.filter((row) => row.isActive && !row.isDeleted)
}

export function getProductBaseUom(product: Product, rows: readonly ProductUom[]): ProductUom {
  const existing = rows.find((row) => row.productId === product.id && row.isBase && row.isActive && !row.isDeleted)
  if (existing) return existing
  const now = product.updatedAt
  return {
    id: `legacy-base:${product.id}`,
    workspaceId: product.workspaceId,
    productId: product.id,
    unitRef: `builtin:${normalizeUnitCode(product.unit).toLowerCase()}`,
    unitCode: normalizeUnitCode(product.unit),
    coefficient: 1,
    isBase: true,
    isActive: true,
    isDefaultSelling: true,
    sellingPrice: product.price,
    costPrice: product.costPrice,
    minimumSellingPrice: product.minimumSellingPrice ?? null,
    createdAt: product.createdAt,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    syncStatus: product.syncStatus,
    lastSyncedAt: product.lastSyncedAt,
  }
}
