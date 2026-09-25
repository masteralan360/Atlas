import { describe, expect, it } from 'vitest'

import {
  filterBusinessPartnersByGroup,
  getActiveAssignedBusinessPartners,
  getCreatorBusinessPartnerGroupIds,
  getVisibleBusinessPartnerIdsByGroup,
} from './businessPartnerGroupPrivacy'

const groups = [
  { id: 'group-a', accessType: 'protected' as const, isDeleted: false },
  { id: 'group-b', accessType: 'non_grouped' as const, isDeleted: false },
  { id: 'group-c', accessType: 'protected' as const, isDeleted: false },
]
const memberships = [
  { groupId: 'group-a', userId: 'user-1', isDeleted: false },
  { groupId: 'group-a', userId: 'user-2', isDeleted: false },
  { groupId: 'group-b', userId: 'user-3', isDeleted: false },
  { groupId: 'group-c', userId: 'user-2', isDeleted: false },
]
const assignments = [
  { groupId: 'group-a', businessPartnerId: 'partner-a', isDeleted: false },
  { groupId: 'group-b', businessPartnerId: 'partner-b', isDeleted: false },
  { groupId: 'group-c', businessPartnerId: 'partner-c', isDeleted: false },
  { groupId: 'group-c', businessPartnerId: 'partner-a', isDeleted: false },
  { groupId: 'group-a', businessPartnerId: 'partner-deleted', isDeleted: true },
]

describe('group-based business partner visibility', () => {
  it('returns partners from every group a multi-group user belongs to', () => {
    expect(getVisibleBusinessPartnerIdsByGroup(groups, memberships, assignments, {
      userId: 'user-2', role: 'staff', featureEnabled: true,
    })).toEqual(new Set(['partner-a', 'partner-c']))
  })

  it('does not add Non-Grouped Access partners for a user who belongs to groups', () => {
    expect(getVisibleBusinessPartnerIdsByGroup(groups, memberships, assignments, {
      userId: 'user-1', role: 'staff', featureEnabled: true,
    })).toEqual(new Set(['partner-a']))
  })

  it('lets an ungrouped non-admin user see only Non-Grouped Access partners', () => {
    expect(getVisibleBusinessPartnerIdsByGroup(groups, memberships, assignments, {
      userId: 'unassigned-user', role: 'viewer', featureEnabled: true,
    })).toEqual(new Set(['partner-b']))
  })

  it('lets admins and workspaces without the granted feature bypass group filtering', () => {
    expect(getVisibleBusinessPartnerIdsByGroup(groups, memberships, assignments, {
      userId: 'admin', role: 'admin', featureEnabled: true,
    })).toBeNull()
    expect(getVisibleBusinessPartnerIdsByGroup(groups, memberships, assignments, {
      userId: 'user-1', role: 'staff', featureEnabled: false,
    })).toBeNull()
  })

  it('hides unassigned partners and ignores deleted groups and assignments', () => {
    const deletedGroup = { id: 'deleted-group', accessType: 'non_grouped' as const, isDeleted: true }
    const allGroups = [...groups, deletedGroup]
    const links = [...assignments, { groupId: 'deleted-group', businessPartnerId: 'partner-deleted-group', isDeleted: false }]
    expect(getVisibleBusinessPartnerIdsByGroup(allGroups, memberships, links, {
      userId: 'unassigned-user', role: 'staff', featureEnabled: true,
    })).toEqual(new Set(['partner-b']))
  })

  it('automatically selects all active groups of a creator and Non-Grouped Access for an ungrouped creator', () => {
    expect(getCreatorBusinessPartnerGroupIds(groups, memberships, {
      userId: 'user-2', role: 'staff', featureEnabled: true,
    })).toEqual(['group-a', 'group-c'])
    expect(getCreatorBusinessPartnerGroupIds(groups, memberships, {
      userId: 'user-2', role: 'admin', featureEnabled: true,
    })).toEqual([])
    expect(getCreatorBusinessPartnerGroupIds(groups, memberships, {
      userId: 'unassigned-user', role: 'staff', featureEnabled: true,
    })).toEqual(['group-b'])
  })

  it('honors per-group creator assignment opt-outs without changing group visibility', () => {
    const optedOutMemberships = memberships.map((membership) => ({
      ...membership,
      autoAssignOnCreate: !(membership.userId === 'user-2' && membership.groupId === 'group-a'),
    }))
    expect(getCreatorBusinessPartnerGroupIds(groups, optedOutMemberships, {
      userId: 'user-2', role: 'staff', featureEnabled: true,
    })).toEqual(['group-c'])
    expect(getVisibleBusinessPartnerIdsByGroup(groups, optedOutMemberships, assignments, {
      userId: 'user-2', role: 'staff', featureEnabled: true,
    })).toEqual(new Set(['partner-a', 'partner-c']))

    const allOptedOut = optedOutMemberships.map((membership) => membership.userId === 'user-2'
      ? { ...membership, autoAssignOnCreate: false }
      : membership)
    expect(getCreatorBusinessPartnerGroupIds(groups, allOptedOut, {
      userId: 'user-2', role: 'staff', featureEnabled: true,
    })).toEqual([])
  })

  it('filters the actual partner list with the same reusable visibility result', () => {
    const partners = ['partner-a', 'partner-b', 'partner-c', 'partner-unassigned']
      .map((id) => ({ id }) as never)
    expect(filterBusinessPartnersByGroup(partners, groups, memberships, assignments, {
      userId: 'user-1', role: 'staff', featureEnabled: true,
    }).map((partner) => partner.id)).toEqual(['partner-a'])
  })

  it('omits deleted and missing partner records from active group assignments', () => {
    const partners = [
      { id: 'partner-active', partnerName: 'Active', isDeleted: false },
      { id: 'partner-deleted', partnerName: 'Deleted', isDeleted: true },
    ] as never[]
    expect(getActiveAssignedBusinessPartners(
      ['partner-active', 'partner-deleted', 'missing-partner'],
      partners,
    ).map((partner) => partner.id)).toEqual(['partner-active'])
  })
})
