import { db } from './database'

import type { BusinessPartnerRole } from './models'

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
    return Boolean(
        partner
        && !partner.isDeleted
        && partner.workspaceId === workspaceId
        && hasRoleForScope(partner.role, scope)
    )
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
