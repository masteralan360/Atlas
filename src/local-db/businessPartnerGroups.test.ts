import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import {
  setActiveBusinessUser,
  setBusinessPartnerGroupPrivacyAccess,
  setNetworkStatus,
} from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

const remote = vi.hoisted(() => ({
  upserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  error: null as unknown,
}))

vi.mock('@/lib/supabaseSchema', () => ({
  getSupabaseClientForTable: () => ({
    from: (table: string) => ({
      upsert: async (payload: Record<string, unknown>) => {
        remote.upserts.push({ table, payload })
        return { error: remote.error }
      },
    }),
  }),
}))

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000701'
let createBusinessPartnerGroup: typeof import('./businessPartnerGroups').createBusinessPartnerGroup
let saveBusinessPartnerGroupMembers: typeof import('./businessPartnerGroups').saveBusinessPartnerGroupMembers
let assignNewBusinessPartnerToCreatorGroups: typeof import('./businessPartnerGroups').assignNewBusinessPartnerToCreatorGroups

describe('Cloud group privacy management request contract', () => {
  beforeAll(async () => {
    installTestBrowser()
    const service = await import('./businessPartnerGroups')
    createBusinessPartnerGroup = service.createBusinessPartnerGroup
    saveBusinessPartnerGroupMembers = service.saveBusinessPartnerGroupMembers
    assignNewBusinessPartnerToCreatorGroups = service.assignNewBusinessPartnerToCreatorGroups
  })

  beforeEach(async () => {
    installTestBrowser()
    await db.delete()
    await db.open()
    remote.upserts.length = 0
    remote.error = null
    setNetworkStatus(true)
    setActiveBusinessUser('workspace-admin', 'admin', WORKSPACE_ID)
    setBusinessPartnerGroupPrivacyAccess(WORKSPACE_ID, true)
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
  })

  afterEach(() => {
    setActiveBusinessUser(null)
    setBusinessPartnerGroupPrivacyAccess(WORKSPACE_ID, false)
    setNetworkStatus(true)
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
  })

  afterAll(async () => {
    await db.delete()
  })

  it('persists groups and many-to-many user and partner assignments to workspace-scoped CRM tables', async () => {
    const group = await createBusinessPartnerGroup(WORKSPACE_ID, 'North region', 'protected')
    await saveBusinessPartnerGroupMembers(WORKSPACE_ID, group.id, ['member-1', 'member-2'], ['partner-1'], ['member-2'])

    expect(remote.upserts).toHaveLength(4)
    expect(remote.upserts[0]).toMatchObject({
      table: 'business_partner_groups',
      payload: {
        id: group.id,
        workspace_id: WORKSPACE_ID,
        name: 'North region',
        access_type: 'protected',
      },
    })
    expect(remote.upserts.filter((entry) => entry.table === 'business_partner_group_users').map(({ payload }) => payload))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ workspace_id: WORKSPACE_ID, group_id: group.id, user_id: 'member-1', auto_assign_on_create: false }),
        expect.objectContaining({ workspace_id: WORKSPACE_ID, group_id: group.id, user_id: 'member-2', auto_assign_on_create: true }),
      ]))
    expect(remote.upserts.find((entry) => entry.table === 'business_partner_group_partners')?.payload).toMatchObject({
      id: `${group.id}:partner-1`,
      workspace_id: WORKSPACE_ID,
      group_id: group.id,
      business_partner_id: 'partner-1',
    })
    expect((await db.business_partner_group_users.where('workspaceId').equals(WORKSPACE_ID).toArray())).toHaveLength(2)
    expect((await db.business_partner_group_partners.where('workspaceId').equals(WORKSPACE_ID).first())?.isDeleted).toBe(false)
  })

  it('creates local partner assignments only for creator memberships with auto-assignment enabled', async () => {
    const createdAt = new Date().toISOString()
    const base = {
      workspaceId: WORKSPACE_ID,
      createdAt,
      updatedAt: createdAt,
      version: 1,
      isDeleted: false,
      syncStatus: 'synced' as const,
      lastSyncedAt: createdAt,
    }
    await db.business_partner_groups.bulkPut([
      { ...base, id: 'group-opted-out', name: 'Opted out', accessType: 'protected' },
      { ...base, id: 'group-enabled', name: 'Enabled', accessType: 'protected' },
    ] as never[])
    await db.business_partner_group_users.bulkPut([
      { ...base, id: 'membership-opted-out', groupId: 'group-opted-out', userId: 'workspace-member', autoAssignOnCreate: false },
      { ...base, id: 'membership-enabled', groupId: 'group-enabled', userId: 'workspace-member', autoAssignOnCreate: true },
    ])
    await db.business_partners.put({ id: 'partner-created', workspaceId: WORKSPACE_ID, createdAt } as never)

    setActiveBusinessUser('workspace-member', 'staff', WORKSPACE_ID)
    await assignNewBusinessPartnerToCreatorGroups(WORKSPACE_ID, 'partner-created')

    const assignments = await db.business_partner_group_partners.where('workspaceId').equals(WORKSPACE_ID).toArray()
    expect(assignments.filter((assignment) => !assignment.isDeleted).map((assignment) => assignment.groupId))
      .toEqual(['group-enabled'])
  })

  it('queues failed Cloud writes locally and rejects group management by non-admins', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    remote.error = { message: 'temporary network failure' }
    const group = await createBusinessPartnerGroup(WORKSPACE_ID, 'Protected group', 'protected')
    expect((await db.business_partner_groups.get(group.id))?.syncStatus).toBe('pending')
    expect(await db.offline_mutations.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(1)

    setActiveBusinessUser('workspace-staff', 'staff', WORKSPACE_ID)
    await expect(createBusinessPartnerGroup(WORKSPACE_ID, 'Blocked group', 'protected'))
      .rejects.toThrow('Only workspace administrators can manage business partner groups.')
    expect(remote.upserts).toHaveLength(1)
    logError.mockRestore()
  })
})
