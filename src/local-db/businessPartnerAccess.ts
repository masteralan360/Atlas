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
