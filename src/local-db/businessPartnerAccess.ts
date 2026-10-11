import { db } from './database'
import { getActiveBusinessUserId, getActiveBusinessUserRole, hasBusinessPartnerGroupPrivacyAccess } from '@/lib/network'
import { getVisibleBusinessPartnerIdsByGroup } from '@/lib/businessPartnerGroupPrivacy'

import type { BusinessPartner, BusinessPartnerRole } from './models'

export type BusinessPartnerAccessScope = 'customer' | 'supplier'

function hasRoleForScope(role: BusinessPartnerRole, scope: BusinessPartnerAccessScope) {
    return scope !== 'supplier' || role !== 'customer'
}

export async function canAccessBusinessPartnerInLocalCache(
    workspaceId: string,
    businessPartnerId: string | null | undefined,
    scope: BusinessPartnerAccessScope = 'customer'
): Promise<boolean> {
    if (!businessPartnerId) {
        return true
    }

    const partner = await db.business_partners.get(businessPartnerId)
    const validPartner = Boolean(
        partner
        && !partner.isDeleted
        && partner.workspaceId === workspaceId
        && hasRoleForScope(partner.role, scope)
    )
    if (!validPartner || !partner) return false
    return canViewBusinessPartnerByGroupPrivacy(workspaceId, partner)
}

export async function filterBusinessPartnersByGroupPrivacy(
    workspaceId: string,
    partners: readonly BusinessPartner[]
): Promise<BusinessPartner[]> {
    if (!hasBusinessPartnerGroupPrivacyAccess(workspaceId)) return [...partners]
    const viewer = {
        userId: getActiveBusinessUserId(),
        role: getActiveBusinessUserRole(workspaceId),
        featureEnabled: true
    }
    const [groups, memberships, assignments] = await Promise.all([
        db.business_partner_groups.where('workspaceId').equals(workspaceId).toArray(),
        db.business_partner_group_users.where('workspaceId').equals(workspaceId).toArray(),
        db.business_partner_group_partners.where('workspaceId').equals(workspaceId).toArray()
    ])
    const visiblePartnerIds = getVisibleBusinessPartnerIdsByGroup(groups, memberships, assignments, viewer)
    return visiblePartnerIds === null ? [...partners] : partners.filter((partner) => visiblePartnerIds.has(partner.id))
}

/**
 * Resolve visibility for a batch of partner ids with one IndexedDB lookup and
 * one group privacy calculation. List hooks should use this instead of calling
 * canAccessBusinessPartnerInLocalCache once per row.
 */
export async function getAccessibleBusinessPartnerIdsInLocalCache(
    workspaceId: string,
    businessPartnerIds: readonly (string | null | undefined)[],
    scope: BusinessPartnerAccessScope = 'customer'
): Promise<Set<string>> {
    const ids = [...new Set(businessPartnerIds.filter((id): id is string => Boolean(id)))]
    if (ids.length === 0) return new Set()

    const partners = (await db.business_partners.bulkGet(ids)).filter((partner): partner is BusinessPartner => Boolean(
        partner
        && !partner.isDeleted
        && partner.workspaceId === workspaceId
        && hasRoleForScope(partner.role, scope)
    ))
    const visiblePartners = await filterBusinessPartnersByGroupPrivacy(workspaceId, partners)
    return new Set(visiblePartners.map((partner) => partner.id))
}

/** Resolve customer/supplier facet visibility for a batch without repeating partner checks. */
export async function getAccessibleBusinessPartnerFacetIdsInLocalCache(
    workspaceId: string,
    facetIds: readonly (string | null | undefined)[],
    scope: BusinessPartnerAccessScope
): Promise<Set<string>> {
    const ids = [...new Set(facetIds.filter((id): id is string => Boolean(id)))]
    if (ids.length === 0) return new Set()

    const table = scope === 'supplier' ? db.suppliers : db.customers
    const facets = (await table.bulkGet(ids)).filter((facet): facet is NonNullable<typeof facet> => Boolean(
        facet
        && !facet.isDeleted
        && facet.workspaceId === workspaceId
    ))
    const partnerIds = facets.map((facet) => facet.businessPartnerId)
    const visiblePartnerIds = await getAccessibleBusinessPartnerIdsInLocalCache(workspaceId, partnerIds, scope)

    return new Set(facets
        .filter((facet) => !facet.businessPartnerId || visiblePartnerIds.has(facet.businessPartnerId))
        .map((facet) => facet.id))
}

async function canViewBusinessPartnerByGroupPrivacy(workspaceId: string, partner: BusinessPartner) {
    if (!hasBusinessPartnerGroupPrivacyAccess(workspaceId)) return true
    const [groups, memberships, assignments] = await Promise.all([
        db.business_partner_groups.where('workspaceId').equals(workspaceId).toArray(),
        db.business_partner_group_users.where('workspaceId').equals(workspaceId).toArray(),
        db.business_partner_group_partners.where('workspaceId').equals(workspaceId).toArray()
    ])
    const visiblePartnerIds = getVisibleBusinessPartnerIdsByGroup(groups, memberships, assignments, {
        userId: getActiveBusinessUserId(),
        role: getActiveBusinessUserRole(workspaceId),
        featureEnabled: true
    })
    return visiblePartnerIds === null || visiblePartnerIds.has(partner.id)
}

export async function canAccessBusinessPartnerFacetInLocalCache(
    workspaceId: string,
    facetId: string | null | undefined,
    scope: BusinessPartnerAccessScope
): Promise<boolean> {
    if (!facetId) {
        return true
    }

    const facet = scope === 'supplier'
        ? await db.suppliers.get(facetId)
        : await db.customers.get(facetId)
    if (!facet || facet.isDeleted || facet.workspaceId !== workspaceId) {
        return false
    }

    return canAccessBusinessPartnerInLocalCache(
        workspaceId,
        facet.businessPartnerId,
        scope
    )
}
