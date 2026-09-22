import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import i18n from '@/i18n/config'
import {
  getActiveBusinessUserId,
  getActiveBusinessUserRole,
  getActiveBusinessWorkspaceId,
  isOnline
} from '@/lib/network'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import type {
  Inventory,
  Product,
  PurchaseOrder,
  Sale,
  SaleItem,
  SalesOrder,
  StorageMemberExclusion
} from './models'

export interface StorageAccess {
  isAdmin: boolean
  excludedStorageIds: ReadonlySet<string>
  /** False only while the active member's local access boundary is unresolved. */
  isReady?: boolean
}

const unrestrictedStorageAccess: StorageAccess = {
  isAdmin: true,
  excludedStorageIds: new Set<string>(),
  isReady: true
}

const unresolvedStorageAccess: StorageAccess = {
  isAdmin: false,
  excludedStorageIds: new Set<string>(),
  isReady: false
}

const exclusionRefreshesInFlight = new Map<string, Promise<StorageMemberExclusion[]>>()
const recentCloudStorageAccesses = new Map<string, {
  userId: string
  access: StorageAccess
  expiresAt: number
}>()
const RECENT_CLOUD_STORAGE_ACCESS_TTL_MS = 15_000

function shouldUseCloudStorageData(workspaceId?: string | null) {
  return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

function getStorageAccessSignature(access: StorageAccess) {
  return `${access.isReady === false ? 'resolving' : access.isAdmin ? 'admin' : 'member'}:${Array.from(access.excludedStorageIds).sort().join('|')}`
}

export function canAccessStorage(storageId: string | null | undefined, access: StorageAccess) {
  return access.isReady !== false
    && (!storageId || access.isAdmin || !access.excludedStorageIds.has(storageId))
}

/**
 * Returns true only for a just-fetched Cloud boundary belonging to the active
 * user. Inventory transactions use this after their preflight so they never
 * await a network request from inside an IndexedDB transaction.
 */
export function assertRecentCurrentUserCanAccessStorage(workspaceId: string, storageId: string) {
  const userId = getActiveBusinessUserId()
  const cached = recentCloudStorageAccesses.get(workspaceId)
  if (!userId || !cached || cached.userId !== userId || cached.expiresAt < Date.now()) {
    if (cached?.expiresAt && cached.expiresAt < Date.now()) {
      recentCloudStorageAccesses.delete(workspaceId)
    }
    return false
  }
  if (!canAccessStorage(storageId, cached.access)) {
    throw new Error(i18n.t('storages.permissions.errors.accessDenied'))
  }
  return true
}

export function filterStorageScopedRows<T extends { storageId?: string | null }>(
  rows: readonly T[],
  access: StorageAccess
) {
  return access.isAdmin ? [...rows] : rows.filter((row) => canAccessStorage(row.storageId, access))
}

/**
 * A document can only be changed as a whole when every one of its lines is
 * in a location the current member can access. The UI may safely redact
 * restricted lines for viewing, but it must never let an update write those
 * hidden lines back or change their inventory.
 */
export function canAccessOrderForStorageAccess(
  order: SalesOrder | PurchaseOrder,
  access: StorageAccess
) {
  const fallbackStorageId = 'customerId' in order
    ? order.sourceStorageId
    : order.destinationStorageId

  return access.isReady !== false && order.items.every((item) => (
    canAccessStorage(item.storageId || fallbackStorageId, access)
  ))
}

/**
 * Products remain global catalog entries, but non-admins only see a stock
 * product when it is assigned to at least one storage they can access.
 */
export function filterProductsByStorageAccess<T extends Product>(
  products: readonly T[],
  inventoryRows: readonly Inventory[],
  access: StorageAccess
) {
  if (access.isReady === false) {
    return []
  }

  if (access.isAdmin || access.excludedStorageIds.size === 0) {
    return [...products]
  }

  const accessibleProductIds = new Set(
    inventoryRows
      .filter((row) => !row.isDeleted && canAccessStorage(row.storageId, access))
      .map((row) => row.productId)
  )

  return products.filter((product) => {
    // Services and unassigned catalog entries have no location-specific stock.
    if (product.isService || !product.storageId) {
      return true
    }

    return canAccessStorage(product.storageId, access) || accessibleProductIds.has(product.id)
  })
}

function roundVisibleAmount(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 1000000) / 1000000
}

function calculateVisibleRatio(visibleTotal: number, originalTotal: number) {
  if (originalTotal <= 0) return 0
  return Math.min(1, Math.max(0, visibleTotal / originalTotal))
}

/** Removes excluded order lines and derives totals from only the remaining data. */
export function redactSalesOrderForStorageAccess(order: SalesOrder, access: StorageAccess) {
  if (access.isReady === false) return null
  if (access.isAdmin || access.excludedStorageIds.size === 0) return order

  const visibleItems = order.items.filter((item) => (
    canAccessStorage(item.storageId || order.sourceStorageId, access)
  ))
  if (order.items.length > 0 && visibleItems.length === 0) return null

  const subtotal = roundVisibleAmount(visibleItems.reduce((sum, item) => sum + item.lineTotal, 0))
  const ratio = calculateVisibleRatio(subtotal, order.subtotal)
  const discount = roundVisibleAmount(order.discount * ratio)
  const tax = roundVisibleAmount(order.tax * ratio)
  const total = roundVisibleAmount(Math.max(0, subtotal - discount + tax))
  const paidAmount = roundVisibleAmount(Math.min(total, order.paidAmount * ratio))

  return {
    ...order,
    sourceStorageId: canAccessStorage(order.sourceStorageId, access)
      ? order.sourceStorageId
      : null,
    items: visibleItems,
    subtotal,
    discount,
    tax,
    total,
    paidAmount,
    balanceAmount: roundVisibleAmount(Math.max(0, total - paidAmount)),
    initialPaymentAmount: roundVisibleAmount(Math.min(total, order.initialPaymentAmount * ratio)),
    returnedAmount: order.returnedAmount === undefined ? undefined : roundVisibleAmount(order.returnedAmount * ratio)
  }
}

/** Removes excluded purchase-order lines and derives visible document totals. */
export function redactPurchaseOrderForStorageAccess(order: PurchaseOrder, access: StorageAccess) {
  if (access.isReady === false) return null
  if (access.isAdmin || access.excludedStorageIds.size === 0) return order

  const visibleItems = order.items.filter((item) => (
    canAccessStorage(item.storageId || order.destinationStorageId, access)
  ))
  if (order.items.length > 0 && visibleItems.length === 0) return null

  const subtotal = roundVisibleAmount(visibleItems.reduce((sum, item) => sum + item.lineTotal, 0))
  const ratio = calculateVisibleRatio(subtotal, order.subtotal)
  const discount = roundVisibleAmount(order.discount * ratio)
  const total = roundVisibleAmount(Math.max(0, subtotal - discount))
  const paidAmount = roundVisibleAmount(Math.min(total, order.paidAmount * ratio))

  return {
    ...order,
    destinationStorageId: canAccessStorage(order.destinationStorageId, access)
      ? order.destinationStorageId
      : null,
    items: visibleItems,
    subtotal,
    discount,
    total,
    paidAmount,
    balanceAmount: roundVisibleAmount(Math.max(0, total - paidAmount))
  }
}

/** Hides excluded POS lines and recalculates the sale's visible total. */
export function redactSaleForStorageAccess<T extends Sale & { _enrichedItems?: Array<SaleItem | Record<string, unknown>> }>(
  sale: T,
  access: StorageAccess
) {
  if (access.isReady === false) return null
  if (access.isAdmin || access.excludedStorageIds.size === 0 || !sale._enrichedItems) return sale

  // RLS removes excluded sale_items before an online sale history is
  // enriched. A non-empty sale with no visible line must therefore disappear
  // rather than retaining its original, location-leaking aggregate total.
  if (sale._enrichedItems.length === 0) return null

  const visibleItems = sale._enrichedItems.filter((item) => {
    const storageId = item.storageId ?? ('storage_id' in item ? item.storage_id : null)
    return canAccessStorage(typeof storageId === 'string' ? storageId : null, access)
  })
  if (visibleItems.length === 0) return null

  const totalAmount = roundVisibleAmount(visibleItems.reduce((sum, item) => {
    const totalPrice = 'totalPrice' in item ? item.totalPrice : item.total_price
    return sum + (typeof totalPrice === 'number' ? totalPrice : 0)
  }, 0))
  const ratio = calculateVisibleRatio(totalAmount, sale.totalAmount)
  return {
    ...sale,
    totalAmount,
    originalTotalAmount: sale.originalTotalAmount === undefined
      ? undefined
      : roundVisibleAmount(sale.originalTotalAmount * ratio),
    returnedAmount: sale.returnedAmount === undefined ? undefined : roundVisibleAmount(sale.returnedAmount * ratio),
    _enrichedItems: visibleItems
  }
}

async function getStorageAccessSnapshot(
  workspaceId: string | undefined,
  userId = getActiveBusinessUserId()
): Promise<StorageAccess | undefined> {
  if (!workspaceId || !userId) {
    return unrestrictedStorageAccess
  }

  // The authenticated identity is authoritative for the active workspace;
  // local membership mirrors can lag or be unavailable while the cache is
  // repaired. Remote RLS remains the authority for every cloud mutation.
  const activeRole = userId === getActiveBusinessUserId()
    ? getActiveBusinessUserRole(workspaceId)
    : null
  if (activeRole === 'admin') {
    return unrestrictedStorageAccess
  }

  const role = activeRole ?? await (async () => {
    const [user, profile] = await Promise.all([db.users.get(userId), db.profiles.get(userId)])
    return user?.workspaceId === workspaceId
      ? user.role
      : profile?.workspaceId === workspaceId
        ? profile.role
        : undefined
  })()

  if (!role) {
    return undefined
  }

  if (role === 'admin') {
    return unrestrictedStorageAccess
  }

  const exclusions = await db.storage_member_exclusions
    .where('[workspaceId+userId]')
    .equals([workspaceId, userId])
    .and((row) => !row.isDeleted)
    .toArray()

  return {
    isAdmin: false,
    excludedStorageIds: new Set(exclusions.map((row) => row.storageId)),
    isReady: true
  }
}

/** Non-reactive counterpart for background workflows that must choose a location. */
export async function getCurrentStorageAccess(workspaceId: string): Promise<StorageAccess> {
  const userId = getActiveBusinessUserId()
  const activeRole = userId === getActiveBusinessUserId()
    ? getActiveBusinessUserRole(workspaceId)
    : null
  // Administrators are never subject to a storage exclusion. Resolve that
  // before refreshing the member deny-list, otherwise a transient refresh
  // failure incorrectly turns an admin-only inventory mutation into a deny.
  if (activeRole === 'admin') {
    return unrestrictedStorageAccess
  }

  if (userId && activeRole && shouldUseCloudStorageData(workspaceId) && isOnline(workspaceId)) {
    try {
      // A Cloud mutation uses the just-fetched RLS-scoped deny-list rather
      // than an optional local mirror. This permits the transaction to remain
      // safe while a damaged IndexedDB cache is being repaired.
      const exclusions = await fetchStorageMemberExclusionsFromSupabase(workspaceId)
      const access: StorageAccess = {
        isAdmin: false,
        excludedStorageIds: new Set(exclusions.map((row) => row.storageId)),
        isReady: true
      }
      recentCloudStorageAccesses.set(workspaceId, {
        userId,
        access,
        expiresAt: Date.now() + RECENT_CLOUD_STORAGE_ACCESS_TTL_MS
      })
      return access
    } catch (error) {
      console.error('[Storage permissions] Could not refresh mutation access:', error)
      return unresolvedStorageAccess
    }
  }

  const cachedAccess = await getStorageAccessSnapshot(workspaceId, userId)
  if (cachedAccess?.isAdmin) {
    return unrestrictedStorageAccess
  }

  if (userId && shouldUseCloudStorageData(workspaceId) && isOnline(workspaceId)) {
    try {
      // A mutation must use the latest deny-list rather than trusting a
      // possibly stale UI cache. A refresh failure remains deny-by-default.
      await refreshStorageMemberExclusionsFromSupabase(workspaceId)
    } catch (error) {
      console.error('[Storage permissions] Could not refresh mutation access:', error)
      return unresolvedStorageAccess
    }
  }
  return (await getStorageAccessSnapshot(workspaceId, userId)) ?? unresolvedStorageAccess
}

/** Guard local/offline mutations where server-side RLS is not present. */
export async function assertCurrentUserCanAccessStorage(workspaceId: string, storageId: string) {
  const access = await getCurrentStorageAccess(workspaceId)
  if (!canAccessStorage(storageId, access)) {
    throw new Error(i18n.t('storages.permissions.errors.accessDenied'))
  }
}

async function fetchStorageMemberExclusionsFromSupabase(workspaceId: string) {
  const { data, error } = await runSupabaseAction('storage-exclusions.fetch', () =>
    supabase
      .from('storage_member_exclusions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('is_deleted', false)
  )
  if (error) {
    throw normalizeSupabaseActionError(error)
  }

  const syncedAt = new Date().toISOString()
  return (data ?? []).map((row) => ({
    ...(toCamelCase(row) as unknown as StorageMemberExclusion),
    syncStatus: 'synced' as const,
    lastSyncedAt: syncedAt
  }))
}

async function persistStorageMemberExclusions(
  workspaceId: string,
  remoteRows: StorageMemberExclusion[]
) {
  const remoteIds = new Set(remoteRows.map((row) => row.id))
  await db.transaction('rw', db.storage_member_exclusions, async () => {
    const localRows = await db.storage_member_exclusions.where('workspaceId').equals(workspaceId).toArray()
    const staleSyncedIds = localRows
      .filter((row) => row.syncStatus === 'synced' && !remoteIds.has(row.id))
      .map((row) => row.id)
    if (staleSyncedIds.length > 0) {
      await db.storage_member_exclusions.bulkDelete(staleSyncedIds)
    }
    if (remoteRows.length > 0) {
      await db.storage_member_exclusions.bulkPut(remoteRows)
    }
  })
}

export async function refreshStorageMemberExclusionsFromSupabase(workspaceId: string): Promise<StorageMemberExclusion[]> {
  if (!workspaceId || !shouldUseCloudStorageData(workspaceId)) {
    return []
  }

  const existingRefresh = exclusionRefreshesInFlight.get(workspaceId)
  if (existingRefresh) {
    return existingRefresh
  }

  const refresh = (async () => {
    const remoteRows = await fetchStorageMemberExclusionsFromSupabase(workspaceId)
    await persistStorageMemberExclusions(workspaceId, remoteRows)
    return remoteRows
  })()

  exclusionRefreshesInFlight.set(workspaceId, refresh)
  try {
    await refresh
  } finally {
    exclusionRefreshesInFlight.delete(workspaceId)
  }
}

export function useStorageMemberExclusionsState(workspaceId: string | undefined, storageId?: string | null) {
  const online = useNetworkStatus()
  const rows = useLiveQuery(
    () => workspaceId
      ? db.storage_member_exclusions
          .where('workspaceId')
          .equals(workspaceId)
          .and((row) => !row.isDeleted && (!storageId || row.storageId === storageId))
          .toArray()
      : [],
    [storageId, workspaceId]
  )
  const [isHydrated, setIsHydrated] = useState(() => (
    !shouldUseCloudStorageData(workspaceId) || !online
  ))

  useEffect(() => {
    if (!online || !workspaceId || !shouldUseCloudStorageData(workspaceId)) {
      setIsHydrated(true)
      return
    }

    let cancelled = false
    setIsHydrated(false)
    void refreshStorageMemberExclusionsFromSupabase(workspaceId)
      .then(() => {
        if (!cancelled) setIsHydrated(true)
      })
      .catch((error) => {
        // Keep the boundary closed when a cloud refresh fails. The offline
        // effect above permits the locally cached boundary once connectivity
        // is actually unavailable.
        console.error('[Storage permissions] Failed to hydrate exclusions:', error)
      })

    return () => {
      cancelled = true
    }
  }, [online, workspaceId])

  return {
    rows: rows ?? [],
    isReady: rows !== undefined && isHydrated
  }
}

export function useStorageMemberExclusions(workspaceId: string | undefined, storageId?: string | null) {
  return useStorageMemberExclusionsState(workspaceId, storageId).rows
}

/** Reactive access boundary shared by storage, inventory, products, and histories. */
export function useStorageAccess(workspaceId: string | undefined, userId?: string | null) {
  const resolvedWorkspaceId = workspaceId ?? getActiveBusinessWorkspaceId() ?? undefined
  const activeUserId = userId ?? getActiveBusinessUserId()
  const exclusionsState = useStorageMemberExclusionsState(resolvedWorkspaceId)
  const snapshot = useLiveQuery(
    () => getStorageAccessSnapshot(resolvedWorkspaceId, activeUserId),
    [activeUserId, resolvedWorkspaceId]
  )
  const access = snapshot ?? (
    resolvedWorkspaceId && activeUserId
      ? unresolvedStorageAccess
      : unrestrictedStorageAccess
  )
  // Storage exclusions are a deny-list. For cloud workspaces a member must
  // not see locally cached location data before its latest policy snapshot
  // has arrived. Admins have an unconditional server-side override.
  const effectiveAccess = !access.isAdmin && !exclusionsState.isReady
    ? unresolvedStorageAccess
    : access
  const signature = getStorageAccessSignature(effectiveAccess)

  return useMemo(() => ({
    ...effectiveAccess,
    signature,
    canAccessStorage: (storageId: string | null | undefined) => canAccessStorage(storageId, effectiveAccess),
    filterStorageScopedRows: <T extends { storageId?: string | null }>(rows: readonly T[]) =>
      filterStorageScopedRows(rows, effectiveAccess),
    filterProducts: (products: readonly Product[], inventoryRows: readonly Inventory[]) =>
      filterProductsByStorageAccess(products, inventoryRows, effectiveAccess)
  }), [effectiveAccess, signature])
}

export async function replaceStorageMemberExclusions(
  workspaceId: string,
  storageId: string,
  userIds: readonly string[]
) {
  const storage = await db.storages.get(storageId)
  if (!storage || storage.isDeleted || storage.workspaceId !== workspaceId) {
    throw new Error(i18n.t('storages.permissions.errors.storageNotFound'))
  }

  const requestedUserIds = [...new Set(userIds.filter(Boolean))]
  const [users, profiles] = await Promise.all([
    db.users.where('workspaceId').equals(workspaceId).toArray(),
    db.profiles.where('workspaceId').equals(workspaceId).toArray()
  ])
  const adminIds = new Set([
    ...users.filter((user) => !user.isDeleted && user.role === 'admin').map((user) => user.id),
    ...profiles.filter((profile) => profile.role === 'admin').map((profile) => profile.id)
  ])
  if (requestedUserIds.some((userId) => adminIds.has(userId))) {
    throw new Error(i18n.t('storages.permissions.errors.adminProtected'))
  }

  const current = await db.storage_member_exclusions
    .where('[workspaceId+storageId]')
    .equals([workspaceId, storageId])
    .and((row) => !row.isDeleted)
    .toArray()
  const currentByUserId = new Map(current.map((row) => [row.userId, row]))
  const requestedSet = new Set(requestedUserIds)
  const removed = current.filter((row) => !requestedSet.has(row.userId))
  const now = new Date().toISOString()
  const additions = requestedUserIds
    .filter((userId) => !currentByUserId.has(userId))
    .map((userId) => ({
      id: generateId(),
      workspaceId,
      storageId,
      userId,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'pending' as const,
      lastSyncedAt: null,
      version: 1,
      isDeleted: false
    } satisfies StorageMemberExclusion))

  const remotePayload = (row: StorageMemberExclusion) => {
    const payload = toSnakeCase(row as unknown as Record<string, unknown>) as Record<string, unknown>
    // These values are local cache metadata, not columns in the remote table.
    delete payload.last_synced_at
    return payload
  }

  if (removed.length === 0 && additions.length === 0) {
    return
  }

  await db.transaction('rw', db.storage_member_exclusions, async () => {
    if (removed.length > 0) {
      await db.storage_member_exclusions.bulkDelete(removed.map((row) => row.id))
    }
    if (additions.length > 0) {
      await db.storage_member_exclusions.bulkPut(additions)
    }
  })

  const syncToCloud = shouldUseCloudStorageData(workspaceId)
  if (!syncToCloud || !isOnline(workspaceId)) {
    await Promise.all([
      ...additions.map((row) => addToOfflineMutations(
        'storage_member_exclusions',
        row.id,
        'create',
        remotePayload(row),
        workspaceId
      )),
      ...removed.map((row) => addToOfflineMutations(
        'storage_member_exclusions',
        row.id,
        'delete',
        // Keep the unique-scope fields with the deletion. The sync queue uses
        // them to ensure a removal is committed before a later re-exclusion
        // for the same member and storage.
        {
          id: row.id,
          storageId: row.storageId,
          userId: row.userId,
          hardDelete: true
        },
        workspaceId
      ))
    ])
    return
  }

  try {
    if (removed.length > 0) {
      const { error } = await runSupabaseAction('storage-exclusions.delete', () =>
        supabase
          .from('storage_member_exclusions')
          .delete()
          .eq('workspace_id', workspaceId)
          .in('id', removed.map((row) => row.id))
      )
      if (error) throw normalizeSupabaseActionError(error)
    }
    if (additions.length > 0) {
      const { error } = await runSupabaseAction('storage-exclusions.create', () =>
        supabase.from('storage_member_exclusions').insert(
          additions.map(remotePayload)
        )
      )
      if (error) throw normalizeSupabaseActionError(error)
      await db.storage_member_exclusions.bulkPut(additions.map((row) => ({
        ...row,
        syncStatus: 'synced' as const,
        lastSyncedAt: now
      })))
    }
  } catch (error) {
    await db.transaction('rw', db.storage_member_exclusions, async () => {
      if (additions.length > 0) {
        await db.storage_member_exclusions.bulkDelete(additions.map((row) => row.id))
      }
      if (removed.length > 0) {
        await db.storage_member_exclusions.bulkPut(removed)
      }
    })
    throw normalizeSupabaseActionError(error)
  }
}
