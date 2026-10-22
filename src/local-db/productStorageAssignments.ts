import { useLiveQuery } from 'dexie-react-hooks'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import type { ProductStorageAssignment } from './models'

export function productStorageAssignmentId(productId: string, storageId: string) {
  return `${productId}:${storageId}`
}

export function useProductStorageAssignments(workspaceId: string | undefined) {
  const rows = useLiveQuery(
    () => workspaceId
      ? db.product_storage_assignments
        .where('workspaceId')
        .equals(workspaceId)
        .and((row) => !row.isDeleted)
        .toArray()
      : [],
    [workspaceId],
  )
  return rows ?? []
}

export async function getProductStorageAssignments(
  workspaceId: string,
  productIds?: readonly string[],
) {
  if (productIds && productIds.length === 0) return []
  const rows = productIds
    ? await db.product_storage_assignments
      .where('[workspaceId+productId]')
      .anyOf(productIds.map((productId) => [workspaceId, productId]))
      .and((row) => !row.isDeleted)
      .toArray()
    : await db.product_storage_assignments
      .where('workspaceId')
      .equals(workspaceId)
      .and((row) => !row.isDeleted)
      .toArray()
  return rows
}

/**
 * Persist a product's storage membership independently from its stock row.
 * Cloud writes are sent immediately; offline writes follow the normal sync queue.
 */
export async function ensureProductStorageAssignment(
  workspaceId: string,
  productId: string,
  storageId: string,
  options: { remoteAlreadyPersisted?: boolean; remoteHydration?: boolean } = {},
) {
  if (!workspaceId || !productId || !storageId) return null

  const id = productStorageAssignmentId(productId, storageId)
  const existing = await db.product_storage_assignments.get(id)
  const now = new Date().toISOString()
  const isCloudWorkspace = !isLocalWorkspaceMode(workspaceId)
  const updateProductScope = async (isRemoteAuthoritative: boolean) => {
    const product = await db.products.get(productId)
    if (!product || product.isService || product.storageScope === 'storage') return
    const updatedProduct = {
      ...product,
      storageScope: 'storage' as const,
      updatedAt: now,
      version: product.version + 1,
      syncStatus: isRemoteAuthoritative || !isCloudWorkspace ? 'synced' as const : 'pending' as const,
      lastSyncedAt: isRemoteAuthoritative || !isCloudWorkspace ? now : product.lastSyncedAt,
    }
    await db.products.put(updatedProduct)
    if (isCloudWorkspace && !isRemoteAuthoritative) {
      await addToOfflineMutations(
        'products',
        product.id,
        'update',
        updatedProduct as unknown as Record<string, unknown>,
        workspaceId,
      )
    }
  }

  if (existing && !existing.isDeleted && existing.syncStatus === 'synced') {
    await updateProductScope(true)
    return existing
  }

  const shouldWriteRemote = isCloudWorkspace
    && !options.remoteHydration
    && options.remoteAlreadyPersisted !== true
    && isOnline(workspaceId)
  const remoteIsAuthoritative = shouldWriteRemote
    || options.remoteAlreadyPersisted === true
    || options.remoteHydration
    || !isCloudWorkspace

  const row: ProductStorageAssignment = {
    id,
    workspaceId,
    productId,
    storageId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    isDeleted: false,
    syncStatus: remoteIsAuthoritative ? 'synced' : 'pending',
    lastSyncedAt: remoteIsAuthoritative
      ? now
      : existing?.lastSyncedAt ?? null,
  }

  if (shouldWriteRemote) {
    const client = getSupabaseClientForTable('product_storage_assignments')
    const { error } = await runSupabaseAction('product-storage-assignment.upsert', () =>
      client.from('product_storage_assignments').upsert(
        toSnakeCase({ ...row, syncStatus: undefined, lastSyncedAt: undefined }),
        { onConflict: 'workspace_id,product_id,storage_id' },
      )
    )
    if (error) throw normalizeSupabaseActionError(error)
  }

  await db.product_storage_assignments.put(row)
  await updateProductScope(remoteIsAuthoritative)
  if (isCloudWorkspace && !shouldWriteRemote && !options.remoteHydration) {
    await addToOfflineMutations(
      'product_storage_assignments',
      row.id,
      existing && !existing.isDeleted ? 'update' : 'create',
      row as unknown as Record<string, unknown>,
      workspaceId,
    )
  }
  return row
}

/** Retire a location only after an explicit transfer has emptied it. */
export async function removeProductStorageAssignment(
  workspaceId: string,
  productId: string,
  storageId: string,
) {
  const id = productStorageAssignmentId(productId, storageId)
  const existing = await db.product_storage_assignments.get(id)
  if (!existing || existing.isDeleted) return existing ?? null

  const now = new Date().toISOString()
  const isCloudWorkspace = !isLocalWorkspaceMode(workspaceId)
  const shouldWriteRemote = isCloudWorkspace && isOnline(workspaceId)
  const row: ProductStorageAssignment = {
    ...existing,
    isDeleted: true,
    updatedAt: now,
    version: existing.version + 1,
    syncStatus: shouldWriteRemote || !isCloudWorkspace ? 'synced' : 'pending',
    lastSyncedAt: shouldWriteRemote || !isCloudWorkspace ? now : existing.lastSyncedAt,
  }

  if (shouldWriteRemote) {
    const client = getSupabaseClientForTable('product_storage_assignments')
    const { error } = await runSupabaseAction('product-storage-assignment.remove', () =>
      client.from('product_storage_assignments').update({
        is_deleted: true,
        updated_at: now,
        version: row.version,
      }).eq('id', id)
    )
    if (error) throw normalizeSupabaseActionError(error)
  }

  await db.product_storage_assignments.put(row)
  if (isCloudWorkspace && !shouldWriteRemote) {
    await addToOfflineMutations(
      'product_storage_assignments',
      row.id,
      'update',
      row as unknown as Record<string, unknown>,
      workspaceId,
    )
  }
  return row
}
