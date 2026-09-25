import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { getActiveBusinessUserId, getActiveBusinessUserRole, hasBusinessPartnerGroupPrivacyAccess, isOnline } from '@/lib/network'
import { generateId } from '@/lib/utils'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { acquireTableHydrationFromSupabase } from './hooks'
import { addToOfflineMutations } from './offlineMutations'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { getCreatorBusinessPartnerGroupIds } from '@/lib/businessPartnerGroupPrivacy'
import type {
  BaseEntity,
  BusinessPartnerGroup,
  BusinessPartnerGroupAccessType,
  BusinessPartnerGroupPartner,
  BusinessPartnerGroupUser,
} from './models'
import { db } from './database'

type GroupTableName = 'business_partner_groups' | 'business_partner_group_users' | 'business_partner_group_partners'
type GroupEntity = BaseEntity

const GROUP_TABLES: GroupTableName[] = [
  'business_partner_groups',
  'business_partner_group_users',
  'business_partner_group_partners',
]

function assertCanManageGroups(workspaceId: string) {
  if (!hasBusinessPartnerGroupPrivacyAccess(workspaceId)) {
    throw new Error('Business partner group privacy is not enabled for this workspace.')
  }
  if (getActiveBusinessUserRole(workspaceId) !== 'admin') {
    throw new Error('Only workspace administrators can manage business partner groups.')
  }
}

function buildGroupEntity<T extends Record<string, unknown>>(workspaceId: string, data: T): T & BaseEntity {
  const now = new Date().toISOString()
  const localOnly = isLocalWorkspaceMode(workspaceId)
  return {
    ...data,
    id: generateId(),
    workspaceId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    syncStatus: localOnly ? 'synced' : 'pending',
    lastSyncedAt: localOnly ? now : null,
  }
}

function toRemoteRow(entity: GroupEntity) {
  const payload: Record<string, unknown> = { ...entity }
  delete payload.syncStatus
  delete payload.lastSyncedAt
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    value,
  ]))
}

async function queueGroupRows(tableName: GroupTableName, rows: GroupEntity[], workspaceId: string) {
  await Promise.all(rows.map((row) => addToOfflineMutations(
    tableName,
    row.id,
    row.version > 1 ? 'update' : 'create',
    row as BaseEntity & Record<string, unknown>,
    workspaceId,
  )))
}

async function syncGroupRows(tableName: GroupTableName, rows: GroupEntity[], workspaceId: string) {
  if (!rows.length || isLocalWorkspaceMode(workspaceId)) return
  if (!isOnline(workspaceId)) {
    await queueGroupRows(tableName, rows, workspaceId)
    return
  }

  const table = (db as unknown as Record<string, { update: (id: string, update: Record<string, unknown>) => Promise<unknown> }>)[tableName]
  const client = getSupabaseClientForTable(tableName)
  for (const row of rows) {
    try {
      const { error } = await client.from(tableName).upsert(toRemoteRow(row))
      if (error) throw error
      const syncedAt = new Date().toISOString()
      await table.update(row.id, { syncStatus: 'synced', lastSyncedAt: syncedAt })
    } catch (error) {
      console.error(`[BusinessPartnerGroups] Failed to sync ${tableName}:`, error)
      await queueGroupRows(tableName, [row], workspaceId)
    }
  }
}

async function saveGroupRows(tableName: GroupTableName, rows: GroupEntity[], workspaceId: string) {
  if (!rows.length) return
  const table = (db as unknown as Record<string, { bulkPut: (items: GroupEntity[]) => Promise<unknown> }>)[tableName]
  await table.bulkPut(rows)
  await syncGroupRows(tableName, rows, workspaceId)
}

function updatedEntity<T extends BaseEntity>(entity: T, changes: Partial<T>): T {
  const updatedAt = new Date().toISOString()
  return {
    ...entity,
    ...changes,
    updatedAt,
    version: entity.version + 1,
    syncStatus: isLocalWorkspaceMode(entity.workspaceId) ? 'synced' : 'pending',
    lastSyncedAt: isLocalWorkspaceMode(entity.workspaceId) ? updatedAt : null,
  }
}

export function useBusinessPartnerGroups(workspaceId: string | undefined, featureEnabled: boolean) {
  const groups = useLiveQuery(
    () => workspaceId
      ? db.business_partner_groups.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  )
  const groupUsers = useLiveQuery(
    () => workspaceId
      ? db.business_partner_group_users.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  )
  const groupPartners = useLiveQuery(
    () => workspaceId
      ? db.business_partner_group_partners.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  )

  useEffect(() => {
    if (!workspaceId || !featureEnabled || isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) {
      return
    }

    const leases = GROUP_TABLES.map((tableName) => acquireTableHydrationFromSupabase(
      tableName,
      (db as unknown as Record<string, never>)[tableName] as never,
      workspaceId,
    ))
    return () => leases.forEach((lease) => lease.release())
  }, [featureEnabled, workspaceId])

  return {
    groups: groups ?? [],
    groupUsers: groupUsers ?? [],
    groupPartners: groupPartners ?? [],
    isLoading: Boolean(workspaceId) && (groups === undefined || groupUsers === undefined || groupPartners === undefined),
  }
}

export async function createBusinessPartnerGroup(
  workspaceId: string,
  name: string,
  accessType: BusinessPartnerGroupAccessType,
): Promise<BusinessPartnerGroup> {
  assertCanManageGroups(workspaceId)
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error('Group name is required.')
  if (accessType !== 'non_grouped' && accessType !== 'protected') throw new Error('Choose a valid group access type.')

  const group = buildGroupEntity(workspaceId, {
    name: normalizedName,
    accessType,
    createdBy: getActiveBusinessUserId() ?? null,
  }) as BusinessPartnerGroup
  await db.business_partner_groups.put(group)
  await syncGroupRows('business_partner_groups', [group], workspaceId)
  return group
}

export async function updateBusinessPartnerGroup(
  workspaceId: string,
  groupId: string,
  changes: { name?: string; accessType?: BusinessPartnerGroupAccessType },
) {
  assertCanManageGroups(workspaceId)
  const current = await db.business_partner_groups.get(groupId)
  if (!current || current.workspaceId !== workspaceId || current.isDeleted) throw new Error('Business partner group not found.')

  const name = changes.name === undefined ? current.name : changes.name.trim()
  if (!name) throw new Error('Group name is required.')
  const accessType = changes.accessType ?? current.accessType
  if (accessType !== 'non_grouped' && accessType !== 'protected') throw new Error('Choose a valid group access type.')
  const updated = updatedEntity(current, { name, accessType })
  await db.business_partner_groups.put(updated)
  await syncGroupRows('business_partner_groups', [updated], workspaceId)
}

async function updateGroupUsers(
  workspaceId: string,
  groupId: string,
  userIds: string[],
  autoAssignUserIds?: string[],
) {
  assertCanManageGroups(workspaceId)
  const existing = await db.business_partner_group_users.where('workspaceId').equals(workspaceId).and((row) => row.groupId === groupId).toArray()
  const desired = new Set(userIds.filter(Boolean))
  const desiredAutoAssign = autoAssignUserIds === undefined ? null : new Set(autoAssignUserIds.filter(Boolean))
  const existingByUser = new Map(existing.map((row) => [row.userId, row]))
  const changes: BusinessPartnerGroupUser[] = []

  for (const userId of desired) {
    const row = existingByUser.get(userId)
    const autoAssignOnCreate = desiredAutoAssign
      ? desiredAutoAssign.has(userId)
      : row?.autoAssignOnCreate !== false
    if (row) {
      const membershipChanges: Partial<BusinessPartnerGroupUser> = {}
      if (row.isDeleted) membershipChanges.isDeleted = false
      if ((row.autoAssignOnCreate !== false) !== autoAssignOnCreate) {
        membershipChanges.autoAssignOnCreate = autoAssignOnCreate
      }
      if (Object.keys(membershipChanges).length) changes.push(updatedEntity(row, membershipChanges))
      continue
    }
    changes.push(buildGroupEntity(workspaceId, { groupId, userId, autoAssignOnCreate }) as BusinessPartnerGroupUser)
  }
  for (const row of existing) {
    if (!row.isDeleted && !desired.has(row.userId)) changes.push(updatedEntity(row, { isDeleted: true }))
  }

  await saveGroupRows('business_partner_group_users', changes, workspaceId)
}

async function updateGroupPartners(workspaceId: string, groupId: string, businessPartnerIds: string[]) {
  assertCanManageGroups(workspaceId)
  const existing = await db.business_partner_group_partners.where('workspaceId').equals(workspaceId).and((row) => row.groupId === groupId).toArray()
  const desired = new Set(businessPartnerIds.filter(Boolean))
  const existingByPartner = new Map(existing.map((row) => [row.businessPartnerId, row]))
  const changes: BusinessPartnerGroupPartner[] = []

  for (const businessPartnerId of desired) {
    const row = existingByPartner.get(businessPartnerId)
    if (row) {
      if (row.isDeleted) changes.push(updatedEntity(row, { isDeleted: false }))
      continue
    }
    changes.push({
      ...buildGroupEntity(workspaceId, { groupId, businessPartnerId }),
      id: getBusinessPartnerGroupPartnerId(groupId, businessPartnerId),
    } as BusinessPartnerGroupPartner)
  }
  for (const row of existing) {
    if (!row.isDeleted && !desired.has(row.businessPartnerId)) changes.push(updatedEntity(row, { isDeleted: true }))
  }

  await saveGroupRows('business_partner_group_partners', changes, workspaceId)
}

export async function saveBusinessPartnerGroupMembers(
  workspaceId: string,
  groupId: string,
  userIds: string[],
  businessPartnerIds: string[],
  autoAssignUserIds?: string[],
) {
  assertCanManageGroups(workspaceId)
  const group = await db.business_partner_groups.get(groupId)
  if (!group || group.workspaceId !== workspaceId || group.isDeleted) throw new Error('Business partner group not found.')
  await updateGroupUsers(workspaceId, groupId, userIds, autoAssignUserIds)
  await updateGroupPartners(workspaceId, groupId, businessPartnerIds)
}

export async function deleteBusinessPartnerGroup(workspaceId: string, groupId: string) {
  assertCanManageGroups(workspaceId)
  const current = await db.business_partner_groups.get(groupId)
  if (!current || current.workspaceId !== workspaceId || current.isDeleted) throw new Error('Business partner group not found.')
  await updateGroupUsers(workspaceId, groupId, [])
  await updateGroupPartners(workspaceId, groupId, [])
  const deleted = updatedEntity(current, { isDeleted: true })
  await db.business_partner_groups.put(deleted)
  await syncGroupRows('business_partner_groups', [deleted], workspaceId)
}

export function getBusinessPartnerGroupPartnerId(groupId: string, businessPartnerId: string) {
  return `${groupId}:${businessPartnerId}`
}

/**
 * Optimistically mirrors the server's insert trigger for a newly created
 * partner so the creator sees it immediately, including while offline. The
 * server creates the same deterministic relationship when the partner syncs.
 */
export async function assignNewBusinessPartnerToCreatorGroups(workspaceId: string, businessPartnerId: string) {
  if (!hasBusinessPartnerGroupPrivacyAccess(workspaceId)) return
  const role = getActiveBusinessUserRole(workspaceId)
  const userId = getActiveBusinessUserId()
  if (!userId || role === 'admin') return

  const [groups, memberships] = await Promise.all([
    db.business_partner_groups.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray(),
    db.business_partner_group_users.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted && row.userId === userId).toArray(),
  ])
  const groupIds = getCreatorBusinessPartnerGroupIds(groups, memberships, {
    userId,
    role,
    featureEnabled: true,
  })
  if (!groupIds.length) return

  const partner = await db.business_partners.get(businessPartnerId)
  if (!partner || partner.workspaceId !== workspaceId) return
  const existing = await db.business_partner_group_partners.where('workspaceId').equals(workspaceId)
    .and((row) => row.businessPartnerId === businessPartnerId)
    .toArray()
  const existingByGroup = new Map(existing.map((row) => [row.groupId, row]))
  const assignedAt = partner.createdAt
  const assignments = groupIds.map((groupId) => {
    const row = existingByGroup.get(groupId)
    if (row) {
      return row.isDeleted
        ? { ...updatedEntity(row, { isDeleted: false }), updatedAt: assignedAt, syncStatus: 'synced' as const, lastSyncedAt: assignedAt }
        : row
    }
    return {
      id: getBusinessPartnerGroupPartnerId(groupId, businessPartnerId),
      workspaceId,
      groupId,
      businessPartnerId,
      createdAt: assignedAt,
      updatedAt: assignedAt,
      version: 1,
      isDeleted: false,
      syncStatus: 'synced' as const,
      lastSyncedAt: assignedAt,
    }
  })
  await db.business_partner_group_partners.bulkPut(assignments)
}
