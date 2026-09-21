import { getSupabaseClientForTable, getSupabaseRemoteTableName, getVisibilityScopedTableRpc } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { toCamelCase } from '@/lib/utils'
import { canReconcileCloudWorkspaceData } from '@/local-db/cloudReconciliation'
import { isBusinessPartnerAccessChangedError } from '@/sync/syncErrors'

import { db } from './database'
import type { OfflineMutation } from './models'

type RecoveryEntityTable = {
    get: (id: string) => Promise<Record<string, unknown> | undefined>
    put: (row: Record<string, unknown>) => Promise<unknown>
    delete: (id: string) => Promise<unknown>
}

export type OfflineMutationRecoveryFailure =
    | 'not_found'
    | 'not_recoverable'
    | 'cloud_authority_unavailable'
    | 'dependent_changes'
    | 'remote_missing'
    | 'changed_during_recovery'
    | 'remote_request_failed'

export type OfflineMutationRecoveryResult =
    | {
        status: 'discarded'
        action: 'restored' | 'removed' | 'removed_access_revoked'
        mutationId: string
        entityType: OfflineMutation['entityType']
        entityId: string
    }
    | {
        status: 'not_discarded'
        reason: OfflineMutationRecoveryFailure
    }

const RECOVERABLE_STATUSES = new Set<OfflineMutation['status']>(['pending', 'failed'])

/**
 * Recovery is intentionally opt-in. These tables have a single local row and
 * no derived payment, ledger, inventory, or aggregate effect. Every other
 * mutation type remains unavailable until it has a dedicated aggregate
 * recovery handler; a permissive fallback here could silently orphan data.
 */
const SINGLE_ROW_RECOVERY_TYPES = new Set<OfflineMutation['entityType']>([
    'products',
    'product_barcodes',
    'categories',
    'units',
    'product_discounts',
    'category_discounts',
    'reorder_transfer_rules',
    'storages',
    'storage_member_exclusions',
    'workspace_contacts',
    'employees',
    'business_partners',
    'customers',
    'suppliers',
    'agents',
    'agent_excluded_categories',
    'fleet_vehicles',
    'fleet_vehicle_assignments',
    'rental_vehicles',
    'activity_catalog',
    'exchange_pair_prices',
    'exchange_fee_rules',
    'clinical_presets',
    'manual_entry_templates',
    'restaurant_table_settings',
])

function getEntityTable(entityType: OfflineMutation['entityType']): RecoveryEntityTable | null {
    const table = (db as unknown as Record<string, unknown>)[entityType]
    if (!table || typeof (table as RecoveryEntityTable).get !== 'function') {
        return null
    }

    return table as RecoveryEntityTable
}

export function canRecoverOfflineMutation(mutation: OfflineMutation | null | undefined): boolean {
    return Boolean(
        mutation
        && RECOVERABLE_STATUSES.has(mutation.status)
        && SINGLE_ROW_RECOVERY_TYPES.has(mutation.entityType)
        && getEntityTable(mutation.entityType)
    )
}

function containsReference(value: unknown, entityId: string): boolean {
    if (value === entityId) return true
    if (Array.isArray(value)) return value.some((entry) => containsReference(entry, entityId))
    if (!value || typeof value !== 'object') return false

    return Object.values(value as Record<string, unknown>)
        .some((entry) => containsReference(entry, entityId))
}

async function hasDependentQueuedChanges(mutation: OfflineMutation): Promise<boolean> {
    const groups = await Promise.all(
        [...RECOVERABLE_STATUSES].map((status) =>
            db.offline_mutations.where('status').equals(status).toArray()
        )
    )

    return groups
        .flat()
        .some((candidate) => (
            candidate.id !== mutation.id
            && candidate.workspaceId === mutation.workspaceId
            && (
                (candidate.entityType === mutation.entityType && candidate.entityId === mutation.entityId)
                || containsReference(candidate.payload, mutation.entityId)
            )
        ))
}

function isAccessRevokedBusinessPartnerMutation(mutation: OfflineMutation): boolean {
    return mutation.entityType === 'business_partners'
        && isBusinessPartnerAccessChangedError(mutation.error)
}

async function fetchAuthoritativeRow(
    mutation: OfflineMutation
): Promise<Record<string, unknown> | null> {
    const client = getSupabaseClientForTable(mutation.entityType) as any
    const remoteTableName = getSupabaseRemoteTableName(mutation.entityType)
    const visibilityScopedRpc = getVisibilityScopedTableRpc(mutation.entityType)

    let query: any = visibilityScopedRpc
        ? client.rpc(visibilityScopedRpc, { p_workspace_id: mutation.workspaceId })
        : client.from(remoteTableName).select('*')

    query = query.eq('id', mutation.entityId)
    if (!visibilityScopedRpc && mutation.entityType !== 'workspaces') {
        query = query.eq('workspace_id', mutation.workspaceId)
    }

    const { data, error } = await runSupabaseAction(
        `syncRecovery.${mutation.entityType}.read`,
        () => query.maybeSingle(),
        { platform: 'all' }
    ) as { data: Record<string, unknown> | null, error: unknown }

    if (error) throw error
    return data
}

/**
 * Discards exactly one safe, non-aggregate queued mutation and replaces its
 * local row with Supabase's current state. It deliberately never starts a full
 * sync, so unrelated queued work cannot be uploaded as a side effect.
 */
export async function discardAndRestoreOfflineMutation(
    workspaceId: string,
    mutationId: string,
    userId: string
): Promise<OfflineMutationRecoveryResult> {
    const mutation = await db.offline_mutations.get(mutationId)
    if (!mutation || mutation.workspaceId !== workspaceId) {
        return { status: 'not_discarded', reason: 'not_found' }
    }

    if (!canRecoverOfflineMutation(mutation)) {
        return { status: 'not_discarded', reason: 'not_recoverable' }
    }

    if (await hasDependentQueuedChanges(mutation)) {
        return { status: 'not_discarded', reason: 'dependent_changes' }
    }

    const table = getEntityTable(mutation.entityType)
    if (!table) {
        return { status: 'not_discarded', reason: 'not_recoverable' }
    }

    const recoveredAt = new Date().toISOString()

    // An access-revoked partner cannot be fetched through the normal
    // visibility-scoped RPC. Retire only that mutation and local row so a
    // private record is not retained or retried after access was removed.
    if (isAccessRevokedBusinessPartnerMutation(mutation)) {
        try {
            await db.transaction('rw', db.offline_mutations, table as any, async () => {
                const currentMutation = await db.offline_mutations.get(mutationId)
                if (
                    !currentMutation
                    || currentMutation.workspaceId !== workspaceId
                    || currentMutation.status !== mutation.status
                    || currentMutation.createdAt !== mutation.createdAt
                ) {
                    throw new Error('mutation_changed_during_recovery')
                }

                await table.delete(mutation.entityId)
                await db.offline_mutations.update(mutationId, {
                    status: 'discarded',
                    error: undefined,
                    discardedAt: recoveredAt,
                    discardedBy: userId
                })
            })
        } catch (error) {
            if (error instanceof Error && error.message === 'mutation_changed_during_recovery') {
                return { status: 'not_discarded', reason: 'changed_during_recovery' }
            }

            console.warn('[SyncRecovery] Failed to remove inaccessible local partner:', error)
            return { status: 'not_discarded', reason: 'remote_request_failed' }
        }

        return {
            status: 'discarded',
            action: 'removed_access_revoked',
            mutationId,
            entityType: mutation.entityType,
            entityId: mutation.entityId
        }
    }

    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return { status: 'not_discarded', reason: 'cloud_authority_unavailable' }
    }

    let remoteRow: Record<string, unknown> | null
    try {
        remoteRow = await fetchAuthoritativeRow(mutation)
    } catch (error) {
        console.warn('[SyncRecovery] Failed to read the authoritative remote record:', error)
        return { status: 'not_discarded', reason: 'remote_request_failed' }
    }

    if (!remoteRow && mutation.operation === 'update') {
        return { status: 'not_discarded', reason: 'remote_missing' }
    }

    const action = remoteRow ? 'restored' as const : 'removed' as const

    try {
        await db.transaction('rw', db.offline_mutations, table as any, async () => {
            const currentMutation = await db.offline_mutations.get(mutationId)
            if (
                !currentMutation
                || currentMutation.workspaceId !== workspaceId
                || currentMutation.status !== mutation.status
                || currentMutation.createdAt !== mutation.createdAt
            ) {
                throw new Error('mutation_changed_during_recovery')
            }

            if (remoteRow) {
                await table.put({
                    ...toCamelCase(remoteRow),
                    syncStatus: 'synced',
                    lastSyncedAt: recoveredAt
                })
            } else {
                await table.delete(mutation.entityId)
            }

            await db.offline_mutations.update(mutationId, {
                status: 'discarded',
                error: undefined,
                discardedAt: recoveredAt,
                discardedBy: userId
            })
        })
    } catch (error) {
        if (error instanceof Error && error.message === 'mutation_changed_during_recovery') {
            return { status: 'not_discarded', reason: 'changed_during_recovery' }
        }

        console.warn('[SyncRecovery] Failed to apply local recovery:', error)
        return { status: 'not_discarded', reason: 'remote_request_failed' }
    }

    return {
        status: 'discarded',
        action,
        mutationId,
        entityType: mutation.entityType,
        entityId: mutation.entityId
    }
}
