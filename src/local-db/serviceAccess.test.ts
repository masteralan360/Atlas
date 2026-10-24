import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  online: true,
  localMode: false,
  role: 'staff' as string | null,
  userId: 'service-access-test-user',
}))

vi.mock('@/lib/supabaseSchema', () => ({
  getSupabaseClientForTable: vi.fn(() => ({ rpc: mocks.rpc })),
}))

vi.mock('@/lib/network', () => ({
  getActiveBusinessUserId: () => mocks.userId,
  getActiveBusinessUserRole: () => mocks.role,
  getActiveBusinessWorkspaceId: () => 'workspace-a',
  isOnline: () => mocks.online,
}))

vi.mock('@/workspace/workspaceMode', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/workspace/workspaceMode')>(),
  isLocalWorkspaceMode: () => mocks.localMode,
}))

vi.mock('@/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mocks.online,
}))

vi.mock('@/lib/supabaseRequest', () => ({
  runSupabaseAction: (_label: string, operation: () => Promise<unknown>) => operation(),
  normalizeSupabaseActionError: (error: unknown) => error,
}))

import { db } from './database'
import {
  createServiceAccessCategory,
  deleteServiceAccessCategory,
  fetchAccessibleServiceIds,
  getLocalAccessibleServiceIdsInCurrentTransaction,
  getServiceAccessSettings,
  invalidateServiceAccessCache,
  setServiceAccessCategoryMembers,
  setServiceAccessCategories,
} from './serviceAccess'

const TEST_USER_ID = 'service-access-test-user'
const WORKSPACE_ID = 'workspace-a'
const now = '2026-10-19T00:00:00.000Z'

async function seedLocalUser(role: 'admin' | 'staff' | 'viewer' = 'staff') {
  await db.users.put({
    id: TEST_USER_ID,
    workspaceId: WORKSPACE_ID,
    email: 'access@example.test',
    name: 'Access User',
    role,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
    lastSyncedAt: now,
    version: 1,
    isDeleted: false,
  })
}

describe('centralized service access lookup', () => {
  beforeEach(async () => {
    mocks.rpc.mockReset()
    mocks.rpc.mockResolvedValue({ data: ['service-a', 'service-b', 'service-a'], error: null })
    mocks.online = true
    mocks.localMode = false
    mocks.role = 'staff'
    mocks.userId = TEST_USER_ID
    await Promise.all([
      db.users.clear(),
      db.profiles.clear(),
      db.products.clear(),
      db.service_access_categories.clear(),
      db.service_access_category_members.clear(),
      db.service_access_category_services.clear(),
    ])
    invalidateServiceAccessCache()
  })

  it('uses one shared database request and de-duplicates authorized service ids', async () => {
    const results = await Promise.all([
      fetchAccessibleServiceIds('workspace-a'),
      fetchAccessibleServiceIds('workspace-a'),
      fetchAccessibleServiceIds('workspace-a'),
    ])

    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).toHaveBeenCalledWith('get_accessible_service_ids', { p_workspace_id: 'workspace-a' })
    expect(results[0]).toEqual(new Set(['service-a', 'service-b']))
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
  })

  it('scopes permission results to the active workspace', async () => {
    await fetchAccessibleServiceIds('workspace-a')
    await fetchAccessibleServiceIds('workspace-b')

    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a previous role or user permission snapshot', async () => {
    await fetchAccessibleServiceIds(WORKSPACE_ID)
    mocks.role = 'admin'
    await fetchAccessibleServiceIds(WORKSPACE_ID)
    mocks.userId = 'another-cashier'
    await fetchAccessibleServiceIds(WORKSPACE_ID)
    expect(mocks.rpc).toHaveBeenCalledTimes(3)
  })

  it('recomputes permissions from SQLite/Dexie authority after changing to Local mode', async () => {
    await fetchAccessibleServiceIds(WORKSPACE_ID)
    mocks.localMode = true
    await seedLocalUser()
    await db.products.put({ id: 'local-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false } as any)
    await expect(fetchAccessibleServiceIds(WORKSPACE_ID)).resolves.toEqual(new Set(['local-service']))
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed for remote members while offline', async () => {
    mocks.online = false

    await expect(fetchAccessibleServiceIds('workspace-a')).resolves.toEqual(new Set())
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('preserves the administrator bypass while offline', async () => {
    mocks.online = false
    mocks.role = 'admin'

    await expect(fetchAccessibleServiceIds('workspace-a')).resolves.toBeNull()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('leaves unassigned local services open and applies OR access to assigned services', async () => {
    mocks.localMode = true
    await seedLocalUser()
    await db.products.bulkPut([
      { id: 'legacy-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: true } as any,
      { id: 'new-unassigned-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: false } as any,
      { id: 'shared-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: false } as any,
      { id: 'one-category-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: false } as any,
      { id: 'other-workspace-service', workspaceId: 'workspace-b', isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: false } as any,
    ])
    await db.service_access_category_members.bulkPut([
      { id: 'category-a:user', workspaceId: WORKSPACE_ID, categoryId: 'category-a', userId: TEST_USER_ID, createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: null, version: 1, isDeleted: false },
    ])
    await db.service_access_category_services.bulkPut([
      { id: 'category-a:shared', workspaceId: WORKSPACE_ID, categoryId: 'category-a', serviceId: 'shared-service', createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: null, version: 1, isDeleted: false },
      { id: 'category-b:shared', workspaceId: WORKSPACE_ID, categoryId: 'category-b', serviceId: 'shared-service', createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: null, version: 1, isDeleted: false },
      { id: 'category-b:one', workspaceId: WORKSPACE_ID, categoryId: 'category-b', serviceId: 'one-category-service', createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: null, version: 1, isDeleted: false },
    ])

    await expect(fetchAccessibleServiceIds(WORKSPACE_ID)).resolves.toEqual(new Set([
      'legacy-service',
      'new-unassigned-service',
      'shared-service',
    ]))
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('requires local workspace membership and restricts only services with category assignments', async () => {
    mocks.localMode = true
    await seedLocalUser()
    await db.products.put({ id: 'unassigned-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: false } as any)
    await db.products.put({ id: 'restricted-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: false } as any)
    await db.service_access_category_services.put({
      id: 'category-no-access:restricted-service', workspaceId: WORKSPACE_ID, categoryId: 'category-no-access', serviceId: 'restricted-service',
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: null, version: 1, isDeleted: false,
    })

    await expect(fetchAccessibleServiceIds(WORKSPACE_ID)).resolves.toEqual(new Set(['unassigned-service']))
    await expect(fetchAccessibleServiceIds('workspace-b')).resolves.toEqual(new Set())
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('validates local category names and removes duplicate member selections', async () => {
    mocks.localMode = true
    mocks.role = 'admin'
    await seedLocalUser('admin')
    await createServiceAccessCategory(WORKSPACE_ID, 'Priority')
    await expect(createServiceAccessCategory(WORKSPACE_ID, ' priority ')).rejects.toThrow()
    const [category] = await db.service_access_categories.toArray()

    await db.users.put({
      id: 'another-member', workspaceId: WORKSPACE_ID, email: 'another@example.test', name: 'Another', role: 'staff',
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false,
    })
    await setServiceAccessCategoryMembers(category.id, ['another-member', 'another-member'], WORKSPACE_ID)
    await expect(db.service_access_category_members.where('[workspaceId+categoryId]').equals([WORKSPACE_ID, category.id]).toArray())
      .resolves.toHaveLength(1)
  })

  it('persists local service assignments, grants category members, and removes grants on deletion', async () => {
    mocks.localMode = true
    mocks.role = 'admin'
    await seedLocalUser('admin')
    await db.users.put({
      id: 'category-member', workspaceId: WORKSPACE_ID, email: 'member@example.test', name: 'Member', role: 'staff',
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false,
    })
    await db.products.put({
      id: 'managed-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: false,
    } as any)
    await createServiceAccessCategory(WORKSPACE_ID, 'Field service')
    const [category] = await db.service_access_categories.toArray()
    await setServiceAccessCategories('managed-service', [category.id, category.id])
    await setServiceAccessCategoryMembers(category.id, ['category-member'], WORKSPACE_ID)
    await expect(getServiceAccessSettings('managed-service')).resolves.toMatchObject({
      categoryIds: [category.id],
    })

    mocks.userId = 'category-member'
    mocks.role = 'staff'
    await expect(fetchAccessibleServiceIds(WORKSPACE_ID)).resolves.toEqual(new Set(['managed-service']))

    mocks.userId = TEST_USER_ID
    mocks.role = 'admin'
    await deleteServiceAccessCategory(WORKSPACE_ID, category.id)
    mocks.userId = 'category-member'
    mocks.role = 'staff'
    await expect(fetchAccessibleServiceIds(WORKSPACE_ID, true)).resolves.toEqual(new Set(['managed-service']))
  })

  it('supports a fresh access decision inside the local checkout transaction', async () => {
    mocks.localMode = true
    await seedLocalUser()
    await db.products.put({
      id: 'restricted-service', workspaceId: WORKSPACE_ID, isService: true, isDeleted: false, serviceLegacyWorkspaceAccess: false,
    } as any)
    let ids: ReadonlySet<string> | null = null
    await db.transaction('rw', db.tables, async () => {
      ids = await getLocalAccessibleServiceIdsInCurrentTransaction(WORKSPACE_ID)
    })
    expect(ids).toEqual(new Set(['restricted-service']))
  })
})
