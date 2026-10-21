import { useLiveQuery } from 'dexie-react-hooks'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthContext'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { getVisibleBusinessPartnerIdsByGroup, type BusinessPartnerGroupPrivacyViewer } from '@/lib/businessPartnerGroupPrivacy'
import {
    normalizeBusinessPartnerName,
    normalizeBusinessPartnerPhone,
    type BusinessPartnerDuplicateMatches,
} from '@/lib/businessPartnerDuplicates'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { queryKeys } from '@/query/queryKeys'
import { db } from './database'

export type BusinessPartnerDuplicateCheck = { name: string; phone: string; excludeBusinessPartnerId?: string }

export async function readLocalBusinessPartnerDuplicates(
    workspaceId: string,
    input: BusinessPartnerDuplicateCheck,
    viewer: BusinessPartnerGroupPrivacyViewer,
    pendingOnly = false,
): Promise<BusinessPartnerDuplicateMatches> {
    const name = normalizeBusinessPartnerName(input.name)
    const phone = normalizeBusinessPartnerPhone(input.phone)
    const matches = { name: false, phone: false }
    if (!name && !phone) return matches

    let visibleIds: Set<string> | null = null
    if (viewer.featureEnabled && viewer.role !== 'admin') {
        const [groups, users, partners] = await Promise.all([
            db.business_partner_groups.where('workspaceId').equals(workspaceId).toArray(),
            db.business_partner_group_users.where('workspaceId').equals(workspaceId).toArray(),
            db.business_partner_group_partners.where('workspaceId').equals(workspaceId).toArray(),
        ])
        visibleIds = getVisibleBusinessPartnerIdsByGroup(groups, users, partners, viewer)
        if (visibleIds?.size === 0) return matches
    }

    // Retain only two flags, and stop as soon as both checks are satisfied.
    // Cloud reads inspect only unsent edits; they never hydrate the directory.
    const candidates = pendingOnly
        ? db.business_partners.where('syncStatus').anyOf('pending', 'conflict')
        : db.business_partners.where('workspaceId').equals(workspaceId)
    await candidates.until(() => (!name || matches.name) && (!phone || matches.phone)).each((partner) => {
        if (partner.workspaceId !== workspaceId || partner.isDeleted || partner.mergedIntoBusinessPartnerId
            || String(partner.role) === 'witness' || partner.id === input.excludeBusinessPartnerId
            || (visibleIds && !visibleIds.has(partner.id))) return
        if (name && normalizeBusinessPartnerName(partner.partnerName) === name) matches.name = true
        if (phone && normalizeBusinessPartnerPhone(partner.phone || '') === phone) matches.phone = true
    })
    return matches
}

export async function fetchRemoteBusinessPartnerDuplicates(
    workspaceId: string,
    input: BusinessPartnerDuplicateCheck,
    signal: AbortSignal,
): Promise<BusinessPartnerDuplicateMatches> {
    const { data, error } = await getSupabaseClientForTable('business_partners')
        .rpc('check_business_partner_duplicates', {
            p_workspace_id: workspaceId,
            p_name: normalizeBusinessPartnerName(input.name),
            p_phone: normalizeBusinessPartnerPhone(input.phone),
            p_exclude_id: input.excludeBusinessPartnerId ?? null,
        })
        .abortSignal(signal)
    if (error) throw error
    if (!data || typeof data.name !== 'boolean' || typeof data.phone !== 'boolean') {
        throw new Error('Invalid business partner duplicate check response')
    }
    return { name: data.name, phone: data.phone }
}

export function useBusinessPartnerDuplicateMatches(workspaceId: string | undefined, input: BusinessPartnerDuplicateCheck) {
    const { user } = useAuth()
    const { hasCapability } = useWorkspace()
    const online = useNetworkStatus()
    const viewer: BusinessPartnerGroupPrivacyViewer = {
        userId: user?.id,
        role: user?.role,
        featureEnabled: hasCapability('businessPartnerGroupPrivacy'),
    }
    const enabled = Boolean(workspaceId && (input.name || input.phone))
    const useRemote = Boolean(workspaceId && online && !isLocalWorkspaceMode(workspaceId))
    const remote = useQuery({
        queryKey: queryKeys.businessPartners.duplicates(workspaceId, input, viewer),
        enabled: enabled && useRemote,
        queryFn: ({ signal }) => fetchRemoteBusinessPartnerDuplicates(workspaceId!, input, signal),
    })
    const pendingOnly = useRemote && !remote.isError
    const localScope = JSON.stringify([workspaceId, input, pendingOnly, viewer])
    const local = useLiveQuery(
        async () => ({
            scope: localScope,
            matches: enabled ? await readLocalBusinessPartnerDuplicates(workspaceId!, input, viewer, pendingOnly) : { name: false, phone: false },
        }),
        [enabled, localScope],
    )
    const remoteMatches = useRemote && !remote.isError ? remote.data : undefined
    return local?.scope !== localScope || (enabled && useRemote && !remote.data && !remote.isError)
        ? undefined
        : { name: local.matches.name || Boolean(remoteMatches?.name), phone: local.matches.phone || Boolean(remoteMatches?.phone) }
}
