import { useEffect, useState } from 'react'

import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { getActiveBusinessUserId, getActiveBusinessUserRole, getActiveBusinessWorkspaceId, isOnline } from '@/lib/network'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import i18n from '@/i18n/config'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { db } from './database'
import type { ServiceAccessCategory as LocalServiceAccessCategory } from './models'

export interface ServiceAccessCategorySummary {
  id: string
  workspaceId: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface ServiceAccessCategoryMemberAssignment {
  categoryId: string
  userId: string
}

export interface ServiceAccessWorkspaceMember {
  id: string
  name: string
  role: string
}

export interface ServiceAccessSettings {
  categoryIds: string[]
}

interface AccessIdCacheEntry {
  promise: Promise<ReadonlySet<string> | null>
  expiresAt: number
}

const ACCESS_ID_CACHE_MS = 10_000
const ACCESS_REFRESH_EVENT = 'atlas:service-access-invalidated'
const accessIdCache = new Map<string, AccessIdCacheEntry>()
const accessIdRequests = new Map<string, Promise<ReadonlySet<string> | null>>()

function getAccessCacheKey(workspaceId: string) {
  return `${workspaceId}:${getActiveBusinessUserId() ?? 'anonymous'}:${getActiveBusinessUserRole(workspaceId) ?? 'unknown'}:${isLocalWorkspaceMode(workspaceId) ? 'local' : 'remote'}`
}

function invalidateLocalAccessIdCache(workspaceId?: string) {
  if (!workspaceId) {
    accessIdCache.clear()
    accessIdRequests.clear()
    return
  }
  const prefix = `${workspaceId}:`
  for (const key of accessIdCache.keys()) {
    if (key.startsWith(prefix)) accessIdCache.delete(key)
  }
  for (const key of accessIdRequests.keys()) {
    if (key.startsWith(prefix)) accessIdRequests.delete(key)
  }
}

export function invalidateServiceAccessCache(workspaceId?: string) {
  invalidateLocalAccessIdCache(workspaceId)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ACCESS_REFRESH_EVENT, { detail: { workspaceId } }))
  }
}

function createLocalId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function makeLocalEntity<T extends Record<string, unknown>>(workspaceId: string, fields: T) {
  const now = new Date().toISOString()
  return {
    ...fields,
    id: createLocalId(),
    workspaceId,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced' as const,
    lastSyncedAt: null,
    version: 1,
    isDeleted: false,
  }
}

function normalizeCategoryName(name: string) {
  return name.trim().toLocaleLowerCase()
}

function normalizeLocalCategory(row: LocalServiceAccessCategory): ServiceAccessCategorySummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function getLocalMemberRole(workspaceId: string, userId: string) {
  const [user, profile] = await Promise.all([db.users.get(userId), db.profiles.get(userId)])
  const userBelongs = user?.workspaceId === workspaceId && !user.isDeleted
  const profileBelongs = profile?.workspaceId === workspaceId
  if (!userBelongs && !profileBelongs) return null

  const persistedRole = userBelongs ? user?.role : profile?.role
  const activeRole = getActiveBusinessUserRole(workspaceId)
  if (!persistedRole || !activeRole || persistedRole !== activeRole) return null
  return persistedRole
}

async function assertLocalWorkspaceAdmin(workspaceId: string) {
  const userId = getActiveBusinessUserId()
  if (!userId || await getLocalMemberRole(workspaceId, userId) !== 'admin') {
    throw new Error('Workspace administrator access is required.')
  }
  return userId
}

async function readLocalAccessibleServiceIds(workspaceId: string): Promise<ReadonlySet<string> | null> {
  const userId = getActiveBusinessUserId()
  if (!userId) return new Set<string>()

  const role = await getLocalMemberRole(workspaceId, userId)
  if (!role) return new Set<string>()
  if (role === 'admin') return null

  const [services, memberships, assignments] = await Promise.all([
    db.products.where('workspaceId').equals(workspaceId).filter((product) => product.isService === true && !product.isDeleted).toArray(),
    db.service_access_category_members.where('[workspaceId+userId]').equals([workspaceId, userId]).toArray(),
    db.service_access_category_services.where('workspaceId').equals(workspaceId).toArray(),
  ])

  const memberCategoryIds = new Set(memberships.map((membership) => membership.categoryId))
  const serviceIds = new Set(services.map((service) => service.id))
  const assignedServiceIds = new Set(assignments.map((assignment) => assignment.serviceId))
  const accessibleIds = new Set(services
    .filter((service) => !assignedServiceIds.has(service.id))
    .map((service) => service.id))
  for (const assignment of assignments) {
    if (serviceIds.has(assignment.serviceId) && memberCategoryIds.has(assignment.categoryId)) {
      accessibleIds.add(assignment.serviceId)
    }
  }
  return accessibleIds
}

async function getLocalAccessibleServiceIds(workspaceId: string): Promise<ReadonlySet<string> | null> {
  return db.transaction(
    'r',
    [db.products, db.users, db.profiles, db.service_access_category_members, db.service_access_category_services],
    () => readLocalAccessibleServiceIds(workspaceId),
  )
}

/** Read permissions inside a caller-owned Local-mode transaction before writes. */
export async function getLocalAccessibleServiceIdsInCurrentTransaction(workspaceId: string) {
  return readLocalAccessibleServiceIds(workspaceId)
}

/** Enforce service access from the caller-owned Local-mode read/write transaction. */
export async function assertLocalServiceAccessInCurrentTransaction(workspaceId: string, serviceIds: readonly string[]) {
  const uniqueServiceIds = Array.from(new Set(serviceIds.filter(Boolean)))
  if (!isLocalWorkspaceMode(workspaceId) || uniqueServiceIds.length === 0) return

  const accessibleServiceIds = await getLocalAccessibleServiceIdsInCurrentTransaction(workspaceId)
  if (accessibleServiceIds !== null && uniqueServiceIds.some((serviceId) => !accessibleServiceIds.has(serviceId))) {
    throw new Error(i18n.t('services.access.serviceUnavailable'))
  }
}

/**
 * Returns authorized service ids in one batched permission lookup. A null
 * result means administrator access; member and data-source failures fail closed.
 */
export function fetchAccessibleServiceIds(workspaceId: string, forceRefresh = false): Promise<ReadonlySet<string> | null> {
  const key = getAccessCacheKey(workspaceId)
  const cached = accessIdCache.get(key)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.promise
  const inFlight = accessIdRequests.get(key)
  if (inFlight) return inFlight

  if (isLocalWorkspaceMode(workspaceId)) {
    const promise = getLocalAccessibleServiceIds(workspaceId).finally(() => {
      if (accessIdRequests.get(key) === promise) accessIdRequests.delete(key)
    })
    accessIdRequests.set(key, promise)
    accessIdCache.set(key, { promise, expiresAt: Date.now() + ACCESS_ID_CACHE_MS })
    void promise.catch(() => {
      if (accessIdCache.get(key)?.promise === promise) accessIdCache.delete(key)
    })
    return promise
  }

  if (!isOnline(workspaceId)) {
    return Promise.resolve(getActiveBusinessUserRole(workspaceId) === 'admin' ? null : new Set<string>())
  }

  const promise = runSupabaseAction('serviceAccess.getAccessibleIds', () =>
    getSupabaseClientForTable('products').rpc('get_accessible_service_ids', {
      p_workspace_id: workspaceId,
    })
  ).then(({ data, error }) => {
    if (error) throw normalizeSupabaseActionError(error)
    if (!Array.isArray(data)) throw new Error('The service access response was invalid.')
    return new Set(data.filter((id): id is string => typeof id === 'string'))
  }).finally(() => {
    if (accessIdRequests.get(key) === promise) accessIdRequests.delete(key)
  })

  accessIdRequests.set(key, promise)
  accessIdCache.set(key, { promise, expiresAt: Date.now() + ACCESS_ID_CACHE_MS })
  void promise.catch(() => {
    if (accessIdCache.get(key)?.promise === promise) accessIdCache.delete(key)
  })
  return promise
}

export function useServiceAccessIds(workspaceId?: string, enabled = true) {
  const resolvedWorkspaceId = workspaceId ?? getActiveBusinessWorkspaceId() ?? undefined
  const networkOnline = useNetworkStatus()
  const [state, setState] = useState<{
    key: string
    ids: ReadonlySet<string> | null
    status: 'loading' | 'ready' | 'unavailable'
  }>(() => ({
    key: '',
    ids: new Set<string>(),
    status: 'loading',
  }))
  const key = resolvedWorkspaceId ? getAccessCacheKey(resolvedWorkspaceId) : ''
  const localMode = Boolean(resolvedWorkspaceId && isLocalWorkspaceMode(resolvedWorkspaceId))
  const activeRole = getActiveBusinessUserRole(resolvedWorkspaceId)
  const adminOfflineBypass = Boolean(resolvedWorkspaceId && !localMode && (!networkOnline || !isOnline(resolvedWorkspaceId))
    && activeRole === 'admin')
  const remoteOffline = Boolean(resolvedWorkspaceId && !localMode && (!networkOnline || !isOnline(resolvedWorkspaceId)) && !adminOfflineBypass)

  useEffect(() => {
    if (!enabled || !resolvedWorkspaceId || adminOfflineBypass) {
      setState({ key, ids: null, status: 'ready' })
      return
    }

    if (remoteOffline) {
      setState({ key, ids: new Set<string>(), status: 'unavailable' })
      return
    }

    let cancelled = false
    let requestSequence = 0
    const refresh = async (forceRefresh = false) => {
      const requestId = ++requestSequence
      try {
        const ids = await fetchAccessibleServiceIds(resolvedWorkspaceId, forceRefresh)
        if (!cancelled && requestId === requestSequence) setState({ key, ids, status: 'ready' })
      } catch {
        // Fail closed for protected actions without claiming a successful empty
        // authorization result. Existing orders must survive a failed refresh.
        if (!cancelled && requestId === requestSequence) {
          setState({ key, ids: new Set<string>(), status: 'unavailable' })
        }
      }
    }

    setState((current) => current.key === key
      ? { ...current, status: 'loading' }
      : { key, ids: new Set<string>(), status: 'loading' })
    void refresh()

    const refreshIfRelevant = (event?: Event) => {
      const eventWorkspaceId = (event as CustomEvent<{ workspaceId?: string }> | undefined)?.detail?.workspaceId
      if (!eventWorkspaceId || eventWorkspaceId === resolvedWorkspaceId) void refresh(true)
    }
    const refreshOnFocus = () => {
      if (document.visibilityState === 'visible') void refresh(true)
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, ACCESS_ID_CACHE_MS)
    window.addEventListener(ACCESS_REFRESH_EVENT, refreshIfRelevant)
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnFocus)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener(ACCESS_REFRESH_EVENT, refreshIfRelevant)
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnFocus)
    }
  }, [activeRole, adminOfflineBypass, enabled, key, localMode, remoteOffline, resolvedWorkspaceId])

  if (!enabled || !resolvedWorkspaceId || adminOfflineBypass) {
    return { ids: null, isReady: true, status: 'ready' as const }
  }
  if (remoteOffline) {
    return { ids: new Set<string>(), isReady: false, status: 'unavailable' as const }
  }
  return state.key === key
    ? { ids: state.ids, isReady: state.status === 'ready', status: state.status }
    : { ids: new Set<string>(), isReady: false, status: 'loading' as const }
}

export async function listServiceAccessCategories(workspaceId: string): Promise<ServiceAccessCategorySummary[]> {
  if (isLocalWorkspaceMode(workspaceId)) {
    const rows = await db.service_access_categories.where('workspaceId').equals(workspaceId).sortBy('nameKey')
    return rows.map(normalizeLocalCategory)
  }

  const { data, error } = await runSupabaseAction('serviceAccess.listCategories', () =>
    getSupabaseClientForTable('products')
      .from('service_access_categories')
      .select('id, workspace_id, name, created_at, updated_at')
      .eq('workspace_id', workspaceId)
      .order('name', { ascending: true })
  )
  if (error) throw normalizeSupabaseActionError(error)
  return (data ?? []).map((row: any) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }))
}

export async function listServiceAccessCategoryMembers(workspaceId: string): Promise<ServiceAccessCategoryMemberAssignment[]> {
  if (isLocalWorkspaceMode(workspaceId)) {
    const rows = await db.service_access_category_members.where('workspaceId').equals(workspaceId).toArray()
    return rows.map(({ categoryId, userId }) => ({ categoryId, userId }))
  }

  const { data, error } = await runSupabaseAction('serviceAccess.listMembers', () =>
    getSupabaseClientForTable('products')
      .from('service_access_category_members')
      .select('category_id, user_id')
      .eq('workspace_id', workspaceId)
  )
  if (error) throw normalizeSupabaseActionError(error)
  return (data ?? []).map((row: any) => ({ categoryId: String(row.category_id), userId: String(row.user_id) }))
}

export async function listServiceAccessWorkspaceMembers(workspaceId: string): Promise<ServiceAccessWorkspaceMember[]> {
  if (isLocalWorkspaceMode(workspaceId)) {
    const [users, profiles] = await Promise.all([
      db.users.where('workspaceId').equals(workspaceId).toArray(),
      db.profiles.where('workspaceId').equals(workspaceId).toArray(),
    ])
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]))
    const members = new Map<string, ServiceAccessWorkspaceMember>()
    const deletedUserIds = new Set(users.filter((user) => user.isDeleted).map((user) => user.id))
    for (const user of users) {
      if (user.isDeleted) continue
      members.set(user.id, { id: user.id, name: user.name || profileById.get(user.id)?.name || '', role: user.role })
    }
    for (const profile of profiles) {
      if (members.has(profile.id) || deletedUserIds.has(profile.id)) continue
      members.set(profile.id, { id: profile.id, name: profile.name || '', role: profile.role })
    }
    return [...members.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  const { data, error } = await runSupabaseAction('serviceAccess.listWorkspaceProfiles', () =>
    getSupabaseClientForTable('profiles').rpc('get_service_access_workspace_members', {
      p_workspace_id: workspaceId,
    })
  )
  if (error) throw normalizeSupabaseActionError(error)
  return (data ?? []).map((row: any) => ({ id: String(row.id), name: String(row.name ?? ''), role: String(row.role ?? '') }))
}

export async function createServiceAccessCategory(workspaceId: string, name: string) {
  if (isLocalWorkspaceMode(workspaceId)) {
    await assertLocalWorkspaceAdmin(workspaceId)
    const trimmedName = name.trim()
    const nameKey = normalizeCategoryName(trimmedName)
    await db.transaction('rw', db.service_access_categories, async () => {
      const existing = await db.service_access_categories.where('[workspaceId+nameKey]').equals([workspaceId, nameKey]).first()
      if (existing) throw new Error('A service access category with this name already exists.')
      await db.service_access_categories.add(makeLocalEntity(workspaceId, { name: trimmedName, nameKey }))
    })
    invalidateServiceAccessCache(workspaceId)
    return
  }

  const { error } = await runSupabaseAction('serviceAccess.createCategory', () =>
    getSupabaseClientForTable('products').from('service_access_categories').insert({
      workspace_id: workspaceId,
      name: name.trim(),
    })
  )
  if (error) throw normalizeSupabaseActionError(error)
  invalidateServiceAccessCache(workspaceId)
}

export async function renameServiceAccessCategory(workspaceId: string, categoryId: string, name: string) {
  if (isLocalWorkspaceMode(workspaceId)) {
    await assertLocalWorkspaceAdmin(workspaceId)
    const trimmedName = name.trim()
    const nameKey = normalizeCategoryName(trimmedName)
    await db.transaction('rw', db.service_access_categories, async () => {
      const category = await db.service_access_categories.get(categoryId)
      if (!category || category.workspaceId !== workspaceId) throw new Error('The service access category is unavailable.')
      const duplicate = await db.service_access_categories.where('[workspaceId+nameKey]').equals([workspaceId, nameKey]).first()
      if (duplicate && duplicate.id !== categoryId) throw new Error('A service access category with this name already exists.')
      await db.service_access_categories.update(categoryId, { name: trimmedName, nameKey, updatedAt: new Date().toISOString() })
    })
    invalidateServiceAccessCache(workspaceId)
    return
  }

  const { error } = await runSupabaseAction('serviceAccess.renameCategory', () =>
    getSupabaseClientForTable('products')
      .from('service_access_categories')
      .update({ name: name.trim(), updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('id', categoryId)
  )
  if (error) throw normalizeSupabaseActionError(error)
  invalidateServiceAccessCache(workspaceId)
}

export async function deleteServiceAccessCategory(workspaceId: string, categoryId: string) {
  if (isLocalWorkspaceMode(workspaceId)) {
    await assertLocalWorkspaceAdmin(workspaceId)
    await db.transaction('rw', db.service_access_categories, db.service_access_category_members, db.service_access_category_services, async () => {
      const category = await db.service_access_categories.get(categoryId)
      if (!category || category.workspaceId !== workspaceId) return
      await Promise.all([
        db.service_access_category_members.where('[workspaceId+categoryId]').equals([workspaceId, categoryId]).delete(),
        db.service_access_category_services.where('[workspaceId+categoryId]').equals([workspaceId, categoryId]).delete(),
      ])
      await db.service_access_categories.delete(categoryId)
    })
    invalidateServiceAccessCache(workspaceId)
    return
  }

  const { error } = await runSupabaseAction('serviceAccess.deleteCategory', () =>
    getSupabaseClientForTable('products')
      .from('service_access_categories')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('id', categoryId)
  )
  if (error) throw normalizeSupabaseActionError(error)
  invalidateServiceAccessCache(workspaceId)
}

export async function setServiceAccessCategoryMembers(categoryId: string, userIds: string[], requestedWorkspaceId?: string) {
  const workspaceId = requestedWorkspaceId ?? getActiveBusinessWorkspaceId()
  if (isLocalWorkspaceMode(workspaceId)) {
    if (!workspaceId) throw new Error('The active workspace is unavailable.')
    await assertLocalWorkspaceAdmin(workspaceId)
    const uniqueUserIds = [...new Set(userIds)]
    await db.transaction('rw', db.service_access_categories, db.service_access_category_members, db.users, db.profiles, async () => {
      const category = await db.service_access_categories.get(categoryId)
      if (!category || category.workspaceId !== workspaceId) throw new Error('The service access category is unavailable.')
      const [users, profiles] = await Promise.all([
        db.users.where('workspaceId').equals(workspaceId).toArray(),
        db.profiles.where('workspaceId').equals(workspaceId).toArray(),
      ])
      const deletedUserIds = new Set(users.filter((user) => user.isDeleted).map((user) => user.id))
      const validMemberIds = new Set([
        ...users.filter((user) => !user.isDeleted).map((user) => user.id),
        ...profiles.filter((profile) => !deletedUserIds.has(profile.id)).map((profile) => profile.id),
      ])
      if (uniqueUserIds.some((userId) => !validMemberIds.has(userId))) {
        throw new Error('A selected member is no longer part of this workspace.')
      }
      await db.service_access_category_members.where('[workspaceId+categoryId]').equals([workspaceId, categoryId]).delete()
      if (uniqueUserIds.length) {
        const now = new Date().toISOString()
        await db.service_access_category_members.bulkAdd(uniqueUserIds.map((userId) => ({
          id: `${categoryId}:${userId}`,
          workspaceId,
          categoryId,
          userId,
          createdAt: now,
          updatedAt: now,
          syncStatus: 'synced' as const,
          lastSyncedAt: null,
          version: 1,
          isDeleted: false,
        })))
      }
    })
    invalidateServiceAccessCache(workspaceId)
    return
  }

  const { data, error } = await runSupabaseAction('serviceAccess.setMembers', () =>
    getSupabaseClientForTable('products').rpc('set_service_access_category_members', {
      p_category_id: categoryId,
      p_user_ids: userIds,
    })
  )
  if (error) throw normalizeSupabaseActionError(error)
  void data
  invalidateServiceAccessCache()
}

export async function getServiceAccessSettings(serviceId: string): Promise<ServiceAccessSettings> {
  const service = await db.products.get(serviceId)
  if (service && isLocalWorkspaceMode(service.workspaceId)) {
    const rows = await db.service_access_category_services
      .where('[workspaceId+serviceId]')
      .equals([service.workspaceId, serviceId])
      .toArray()
    return {
      categoryIds: [...new Set(rows.map((row) => row.categoryId))],
    }
  }

  const { data, error } = await runSupabaseAction('serviceAccess.getServiceSettings', () =>
    getSupabaseClientForTable('products').rpc('get_service_access_settings', {
      p_service_id: serviceId,
    })
  )
  if (error) throw normalizeSupabaseActionError(error)
  const result = data as { category_ids?: unknown } | null
  return {
    categoryIds: Array.isArray(result?.category_ids)
      ? result.category_ids.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

export async function setServiceAccessCategories(serviceId: string, categoryIds: string[]) {
  const service = await db.products.get(serviceId)
  if (service && isLocalWorkspaceMode(service.workspaceId)) {
    const workspaceId = service.workspaceId
    await assertLocalWorkspaceAdmin(workspaceId)
    const uniqueCategoryIds = [...new Set(categoryIds)]
    await db.transaction('rw', db.products, db.service_access_categories, db.service_access_category_services, async () => {
      const currentService = await db.products.get(serviceId)
      if (!currentService || currentService.workspaceId !== workspaceId || currentService.isService !== true || currentService.isDeleted) {
        throw new Error('The service is unavailable.')
      }
      const categories = await Promise.all(uniqueCategoryIds.map((categoryId) => db.service_access_categories.get(categoryId)))
      if (categories.some((category) => !category || category.workspaceId !== workspaceId)) {
        throw new Error('A selected access category is unavailable in this workspace.')
      }
      await db.service_access_category_services.where('[workspaceId+serviceId]').equals([workspaceId, serviceId]).delete()
      if (uniqueCategoryIds.length) {
        const now = new Date().toISOString()
        await db.service_access_category_services.bulkAdd(uniqueCategoryIds.map((categoryId) => ({
          id: `${categoryId}:${serviceId}`,
          workspaceId,
          categoryId,
          serviceId,
          createdAt: now,
          updatedAt: now,
          syncStatus: 'synced' as const,
          lastSyncedAt: null,
          version: 1,
          isDeleted: false,
        })))
      }
    })
    invalidateServiceAccessCache(workspaceId)
    return
  }

  const { error } = await runSupabaseAction('serviceAccess.setServiceCategories', () =>
    getSupabaseClientForTable('products').rpc('set_service_access_categories', {
      p_service_id: serviceId,
      p_category_ids: categoryIds,
    })
  )
  if (error) throw normalizeSupabaseActionError(error)
  invalidateServiceAccessCache()
}
