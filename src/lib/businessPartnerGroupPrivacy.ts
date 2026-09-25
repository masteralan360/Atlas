import type {
  BusinessPartner,
  BusinessPartnerGroup,
  BusinessPartnerGroupPartner,
  BusinessPartnerGroupUser,
  UserRole,
} from '@/local-db/models'

type GroupRow = Pick<BusinessPartnerGroup, 'id' | 'accessType' | 'isDeleted'>
type GroupUserRow = Pick<BusinessPartnerGroupUser, 'groupId' | 'userId' | 'isDeleted' | 'autoAssignOnCreate'>
type GroupPartnerRow = Pick<BusinessPartnerGroupPartner, 'groupId' | 'businessPartnerId' | 'isDeleted'>

export interface BusinessPartnerGroupPrivacyViewer {
  userId: string | null | undefined
  role: UserRole | null | undefined
  featureEnabled: boolean
}

export function getVisibleBusinessPartnerIdsByGroup(
  groups: readonly GroupRow[],
  groupUsers: readonly GroupUserRow[],
  groupPartners: readonly GroupPartnerRow[],
  viewer: BusinessPartnerGroupPrivacyViewer,
): Set<string> | null {
  if (!viewer.featureEnabled || viewer.role === 'admin') return null
  if (!viewer.userId) return new Set()

  const activeGroups = groups.filter((group) => !group.isDeleted)
  const activeGroupIds = new Set(activeGroups.map((group) => group.id))
  const userGroupIds = new Set(
    groupUsers
      .filter((membership) => !membership.isDeleted && membership.userId === viewer.userId)
      .filter((membership) => activeGroupIds.has(membership.groupId))
      .map((membership) => membership.groupId),
  )

  const permittedGroupIds = userGroupIds.size > 0
    ? userGroupIds
    : new Set(activeGroups.filter((group) => group.accessType === 'non_grouped').map((group) => group.id))

  return new Set(
    groupPartners
      .filter((assignment) => !assignment.isDeleted && permittedGroupIds.has(assignment.groupId))
      .map((assignment) => assignment.businessPartnerId),
  )
}

export function filterBusinessPartnersByGroup(
  partners: readonly BusinessPartner[],
  groups: readonly GroupRow[],
  groupUsers: readonly GroupUserRow[],
  groupPartners: readonly GroupPartnerRow[],
  viewer: BusinessPartnerGroupPrivacyViewer,
): BusinessPartner[] {
  const visiblePartnerIds = getVisibleBusinessPartnerIdsByGroup(groups, groupUsers, groupPartners, viewer)
  if (visiblePartnerIds === null) return [...partners]
  return partners.filter((partner) => visiblePartnerIds.has(partner.id))
}

export function getActiveAssignedBusinessPartners(
  partnerIds: readonly string[],
  partners: readonly BusinessPartner[],
): BusinessPartner[] {
  const activePartnersById = new Map(
    partners.filter((partner) => !partner.isDeleted).map((partner) => [partner.id, partner]),
  )
  return [...new Set(partnerIds)].flatMap((partnerId) => {
    const partner = activePartnersById.get(partnerId)
    return partner ? [partner] : []
  })
}

export function getCreatorBusinessPartnerGroupIds(
  groups: readonly GroupRow[],
  groupUsers: readonly GroupUserRow[],
  viewer: BusinessPartnerGroupPrivacyViewer,
): string[] {
  if (!viewer.featureEnabled || viewer.role === 'admin' || !viewer.userId) return []
  const activeGroupIds = new Set(groups.filter((group) => !group.isDeleted).map((group) => group.id))
  const userMemberships = groupUsers
    .filter((membership) => !membership.isDeleted && membership.userId === viewer.userId)
    .filter((membership) => activeGroupIds.has(membership.groupId))
  if (userMemberships.length > 0) {
    return [...new Set(
      userMemberships
        .filter((membership) => membership.autoAssignOnCreate !== false)
        .map((membership) => membership.groupId),
    )]
  }
  return groups
    .filter((group) => !group.isDeleted && group.accessType === 'non_grouped')
    .map((group) => group.id)
}
