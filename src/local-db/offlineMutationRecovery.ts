import { getSupabaseClientForTable, getSupabaseRemoteTableName, getWorkspaceScopedPartnerReadRpc } from '@/lib/supabaseSchema'
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
    toArray?: () => Promise<Record<string, unknown>[]>
}

type RecoveryFilter = {
    remoteColumn: string
    localField: string
    value: string
}

type RecoveryTarget = {
    tableName: string
    ids: Set<string>
    filters: RecoveryFilter[][]
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
const DISCARDABLE_STATUSES = new Set<OfflineMutation['status']>(['pending', 'syncing', 'failed'])
const CUSTOM_RECOVERY_TYPES = new Set<OfflineMutation['entityType']>([
    'stock_operations',
    'loan_commands',
    'order_cancellation_commands',
    'sales_agent_commission_reconciliation',
    'business_partner_merge_candidates',
    'workspace_branches'
])

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
    'beauty3_appointments',
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

async function getQueuedBusinessPartnerEdits(
    workspaceId: string,
    businessPartnerId: string
): Promise<OfflineMutation[]> {
    const groups = await Promise.all(
        [...RECOVERABLE_STATUSES].map((status) =>
            db.offline_mutations.where('status').equals(status).toArray()
        )
    )

    return groups
        .flat()
        .filter((mutation) => (
            mutation.workspaceId === workspaceId
            && mutation.entityType === 'business_partners'
            && mutation.entityId === businessPartnerId
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
    const workspaceScopedRpc = getWorkspaceScopedPartnerReadRpc(mutation.entityType)

    let query: any = workspaceScopedRpc
        ? client.rpc(workspaceScopedRpc, { p_workspace_id: mutation.workspaceId })
        : client.from(remoteTableName).select('*')

    query = query.eq('id', mutation.entityId)
    if (!workspaceScopedRpc && mutation.entityType !== 'workspaces') {
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

function getRecoveryTable(tableName: string): RecoveryEntityTable | null {
    return getEntityTable(tableName as OfflineMutation['entityType'])
}

function addRecoveryIdTarget(
    targets: Map<string, RecoveryTarget>,
    tableName: string,
    id: unknown
) {
    if (typeof id !== 'string' || !id || (!getRecoveryTable(tableName) && tableName !== 'workspace_branches')) return
    const target = targets.get(tableName) ?? { tableName, ids: new Set<string>(), filters: [] }
    target.ids.add(id)
    targets.set(tableName, target)
}

function addRecoveryFilterTarget(
    targets: Map<string, RecoveryTarget>,
    tableName: string,
    filters: RecoveryFilter[]
) {
    if (filters.length === 0 || !getRecoveryTable(tableName)) return
    const target = targets.get(tableName) ?? { tableName, ids: new Set<string>(), filters: [] }
    const key = filters.map(filter => `${filter.remoteColumn}:${filter.value}`).join('|')
    if (!target.filters.some(existing => existing.map(filter => `${filter.remoteColumn}:${filter.value}`).join('|') === key)) {
        target.filters.push(filters)
    }
    targets.set(tableName, target)
}

function addPaymentTransactionProjections(
    targets: Map<string, RecoveryTarget>,
    transaction: Record<string, unknown>,
    workspaceId: string
) {
    const accountId = transaction.accountId ?? transaction.account_id
    const transactionId = transaction.id
    if (typeof transactionId === 'string') {
        addRecoveryFilterTarget(targets, 'payment_account_movements', [
            { remoteColumn: 'payment_transaction_id', localField: 'paymentTransactionId', value: transactionId }
        ])
    }
    if (typeof accountId === 'string') {
        addRecoveryFilterTarget(targets, 'payment_account_balances', [
            { remoteColumn: 'account_id', localField: 'accountId', value: accountId }
        ])
    }

    const sourceRecordId = transaction.sourceRecordId ?? transaction.source_record_id
    const sourceType = transaction.sourceType ?? transaction.source_type
    if (typeof sourceRecordId !== 'string') return
    if (sourceType === 'sales_order') addRecoveryIdTarget(targets, 'sales_orders', sourceRecordId)
    if (sourceType === 'purchase_order') addRecoveryIdTarget(targets, 'purchase_orders', sourceRecordId)

    // Loan rows and their payment projections are an aggregate written by an
    // RPC. Refresh the whole loan aggregate when a payment or loan command is
    // discarded so balances and installment states converge together.
    if (['loan_origination', 'loan_payment', 'simple_loan', 'loan_installment'].includes(String(sourceType))) {
        addLoanAggregateTargets(targets, sourceRecordId, workspaceId)
    }
}

function addLoanAggregateTargets(
    targets: Map<string, RecoveryTarget>,
    loanId: string,
    _workspaceId: string
) {
    addRecoveryIdTarget(targets, 'loans', loanId)
    for (const tableName of ['loan_installments', 'loan_payments']) {
        addRecoveryFilterTarget(targets, tableName, [
            { remoteColumn: 'loan_id', localField: 'loanId', value: loanId }
        ])
    }
    addRecoveryFilterTarget(targets, 'payment_transactions', [
        { remoteColumn: 'source_record_id', localField: 'sourceRecordId', value: loanId },
        { remoteColumn: 'source_module', localField: 'sourceModule', value: 'loans' }
    ])
}

function addMutationRecoveryTargets(
    mutation: OfflineMutation,
    targets: Map<string, RecoveryTarget>,
    localOnlyRemovals: Map<string, Set<string>>
) {
    const payload = mutation.payload
    if (mutation.entityType === 'business_partner_merge_candidates') {
        const ids = localOnlyRemovals.get(mutation.entityType) ?? new Set<string>()
        ids.add(mutation.entityId)
        localOnlyRemovals.set(mutation.entityType, ids)
        return
    }

    if (mutation.entityType === 'stock_operations') {
        const effects = Array.isArray(payload.effects) ? payload.effects as Array<Record<string, unknown>> : []
        for (const effect of effects) {
            const tableName = effect.table
            if (typeof tableName !== 'string') continue
            addRecoveryIdTarget(targets, tableName, effect.id)
            const row = (effect.after ?? effect.before) as Record<string, unknown> | undefined
            if (tableName === 'inventory' && row) {
                const productId = row.productId ?? row.product_id
                const storageId = row.storageId ?? row.storage_id
                if (typeof productId === 'string' && typeof storageId === 'string') {
                    addRecoveryFilterTarget(targets, 'inventory', [
                        { remoteColumn: 'product_id', localField: 'productId', value: productId },
                        { remoteColumn: 'storage_id', localField: 'storageId', value: storageId }
                    ])
                }
                addRecoveryIdTarget(targets, 'products', productId)
            }
            if (tableName === 'payment_transactions' && row) addPaymentTransactionProjections(targets, row, mutation.workspaceId)
        }
        return
    }

    if (mutation.entityType === 'loan_commands') {
        const command = payload.payload && typeof payload.payload === 'object'
            ? payload.payload as Record<string, unknown>
            : {}
        const loanId = command.loan_id ?? (payload.action === 'create' ? mutation.entityId : undefined)
        if (typeof loanId === 'string') addLoanAggregateTargets(targets, loanId, mutation.workspaceId)
        for (const id of [command.payment_transaction_id, command.reversal_transaction_id, command.original_transaction_id]) {
            addRecoveryIdTarget(targets, 'payment_transactions', id)
        }
        for (const id of [command.account_id]) addRecoveryIdTarget(targets, 'payment_accounts', id)
        addRecoveryIdTarget(targets, 'business_partners', command.linked_party_id)
        const orderId = command.order_id
        if (typeof orderId === 'string') {
            if (command.order_type === 'purchase') addRecoveryIdTarget(targets, 'purchase_orders', orderId)
            if (command.order_type === 'sales') addRecoveryIdTarget(targets, 'sales_orders', orderId)
        }
        return
    }

    if (mutation.entityType === 'order_cancellation_commands') {
        const tableName = payload.orderType === 'purchase' ? 'purchase_orders' : 'sales_orders'
        addRecoveryIdTarget(targets, tableName, payload.orderId ?? mutation.entityId)
        return
    }

    if (mutation.entityType === 'sales_agent_commission_reconciliation') {
        const orderId = payload.orderId ?? payload.order_id ?? mutation.entityId
        for (const tableName of ['agent_commission_entries', 'agent_product_commission_entries']) {
            addRecoveryFilterTarget(targets, tableName, [
                { remoteColumn: 'order_id', localField: 'orderId', value: String(orderId) }
            ])
        }
        return
    }

    addRecoveryIdTarget(targets, mutation.entityType, mutation.entityId)

    if (mutation.entityType === 'payment_transactions') {
        addPaymentTransactionProjections(targets, { ...payload, id: mutation.entityId }, mutation.workspaceId)
    }
    if (mutation.entityType === 'financial_transaction_voids') {
        const transactionIds = payload.affectedTransactionIds ?? payload.affected_transaction_ids
        if (Array.isArray(transactionIds)) {
            for (const id of transactionIds) addRecoveryIdTarget(targets, 'payment_transactions', id)
        }
        const sourceTransactionId = payload.rootPaymentTransactionId ?? payload.root_payment_transaction_id
        addRecoveryIdTarget(targets, 'payment_transactions', sourceTransactionId)
    }
    if (mutation.entityType === 'inventory_transactions') {
        const productId = payload.productId ?? payload.product_id
        const storageId = payload.storageId ?? payload.storage_id
        if (typeof productId === 'string') addRecoveryIdTarget(targets, 'products', productId)
        if (typeof productId === 'string' && typeof storageId === 'string') {
            addRecoveryFilterTarget(targets, 'inventory', [
                { remoteColumn: 'product_id', localField: 'productId', value: productId },
                { remoteColumn: 'storage_id', localField: 'storageId', value: storageId }
            ])
        }
    }
}

async function fetchRecoveryTargetRows(
    target: RecoveryTarget,
    workspaceId: string
): Promise<{ rows: Record<string, unknown>[]; requestedIds: Set<string>; localFilterRows: Record<string, unknown>[] }> {
    const client = getSupabaseClientForTable(target.tableName) as any
    const remoteTableName = getSupabaseRemoteTableName(target.tableName)
    const workspaceScopedRpc = getWorkspaceScopedPartnerReadRpc(target.tableName)
    const rows: Record<string, unknown>[] = []
    const localFilterRows: Record<string, unknown>[] = []
    const requestedIds = new Set(target.ids)

    for (const id of target.ids) {
        let query: any
        if (target.tableName === 'products') {
            const { data, error } = await runSupabaseAction(
                'syncRecovery.products.read',
                () => client.rpc('get_visible_products_for_current_user', {
                    p_workspace_id: workspaceId,
                    p_product_ids: [id],
                    p_offset: 0,
                    p_limit: 1
                }),
                { platform: 'all' }
            ) as { data: Array<Record<string, unknown>> | null; error: unknown }
            if (error) throw error
            const product = data?.[0]?.product
            if (product && typeof product === 'object' && !Array.isArray(product)) {
                rows.push(product as Record<string, unknown>)
            }
            continue
        }

        query = workspaceScopedRpc
            ? client.rpc(workspaceScopedRpc, { p_workspace_id: workspaceId }).eq('id', id)
            : client.from(remoteTableName).select('*')
        if (!workspaceScopedRpc) {
            query = query.eq('id', id)
            if (target.tableName !== 'workspaces' && target.tableName !== 'workspace_branches') {
                query = query.eq('workspace_id', workspaceId)
            }
        }
        const { data, error } = await runSupabaseAction(
            `syncRecovery.${target.tableName}.read`,
            () => query.maybeSingle(),
            { platform: 'all' }
        ) as { data: Record<string, unknown> | null; error: unknown }
        if (error) throw error
        if (data && data.id === id) {
            if (target.tableName === 'workspace_branches'
                && data.source_workspace_id !== workspaceId
                && data.branch_workspace_id !== workspaceId) {
                throw new Error('workspace_branch_outside_authorized_workspace')
            }
            rows.push(data)
        }
    }

    const localTable = getRecoveryTable(target.tableName)
    const localRows = target.filters.length > 0 && localTable?.toArray ? await localTable.toArray() : []
    for (const filters of target.filters) {
        const matchingLocal = localRows.filter(row => row.workspaceId === workspaceId
            && filters.every(filter => String(row[filter.localField] ?? '') === filter.value))
        localFilterRows.push(...matchingLocal)

        let query: any = client.from(remoteTableName).select('*').eq('workspace_id', workspaceId)
        for (const filter of filters) query = query.eq(filter.remoteColumn, filter.value)
        query = query.order('id', { ascending: true })
        for (let from = 0; ; from += 1000) {
            const { data, error } = await runSupabaseAction(
                `syncRecovery.${target.tableName}.readRelated`,
                () => query.range(from, from + 999),
                { platform: 'all' }
            ) as { data: Record<string, unknown>[] | null; error: unknown }
            if (error) throw error
            const page = data ?? []
            rows.push(...page)
            if (page.length < 1000) break
        }
    }

    return { rows, requestedIds, localFilterRows }
}

/**
 * Replaces every discarded mutation's optimistic local projection with the
 * current Supabase record before retiring its queue row. Related financial,
 * inventory, stock-operation, and loan projections are refreshed as a group.
 */
export async function discardAndRestoreOfflineMutations(
    workspaceId: string,
    mutations: OfflineMutation[],
    userId: string
): Promise<{ status: 'discarded'; count: number } | { status: 'not_discarded'; reason: OfflineMutationRecoveryFailure }> {
    if (mutations.length === 0) return { status: 'not_discarded', reason: 'not_found' }
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return { status: 'not_discarded', reason: 'cloud_authority_unavailable' }
    }

    const targets = new Map<string, RecoveryTarget>()
    const localOnlyRemovals = new Map<string, Set<string>>()
    for (const mutation of mutations) {
        if (mutation.workspaceId !== workspaceId || !DISCARDABLE_STATUSES.has(mutation.status)) {
            return { status: 'not_discarded', reason: 'not_found' }
        }
        if (!getRecoveryTable(mutation.entityType) && !CUSTOM_RECOVERY_TYPES.has(mutation.entityType)) {
            return { status: 'not_discarded', reason: 'not_recoverable' }
        }
        addMutationRecoveryTargets(mutation, targets, localOnlyRemovals)

        const referencedPaymentIds: unknown[] = []
        if (mutation.entityType === 'loan_commands') {
            const command = mutation.payload.payload && typeof mutation.payload.payload === 'object'
                ? mutation.payload.payload as Record<string, unknown>
                : {}
            referencedPaymentIds.push(
                command.payment_transaction_id,
                command.origination_transaction_id,
                command.reversal_transaction_id,
                command.original_transaction_id,
            )
        }
        if (mutation.entityType === 'financial_transaction_voids') {
            const affectedIds = mutation.payload.affectedTransactionIds ?? mutation.payload.affected_transaction_ids
            if (Array.isArray(affectedIds)) referencedPaymentIds.push(...affectedIds)
            referencedPaymentIds.push(mutation.payload.rootPaymentTransactionId ?? mutation.payload.root_payment_transaction_id)
        }
        for (const id of referencedPaymentIds) {
            if (typeof id !== 'string') continue
            const transaction = await db.payment_transactions.get(id)
            if (transaction?.workspaceId === workspaceId) {
                addPaymentTransactionProjections(targets, transaction as unknown as Record<string, unknown>, workspaceId)
            }
        }
    }

    const fetched = new Map<string, Awaited<ReturnType<typeof fetchRecoveryTargetRows>>>()
    try {
        for (const target of targets.values()) {
            fetched.set(target.tableName, await fetchRecoveryTargetRows(target, workspaceId))
        }
    } catch (error) {
        console.warn('[SyncRecovery] Failed to read authoritative records before discarding:', error)
        return { status: 'not_discarded', reason: 'remote_request_failed' }
    }

    const tables = [...new Set([
        db.offline_mutations,
        ...[...targets.keys(), ...localOnlyRemovals.keys()]
            .map(tableName => getRecoveryTable(tableName))
            .filter((table): table is RecoveryEntityTable => Boolean(table))
    ])]
    const recoveredAt = new Date().toISOString()

    try {
        await db.transaction('rw', tables as any, async () => {
            const selectedIds = new Set(mutations.map(mutation => mutation.id))
            const activeMutations = await db.offline_mutations.where('workspaceId').equals(workspaceId).toArray()
            const protectedEntities = new Set(activeMutations
                .filter(mutation => !selectedIds.has(mutation.id)
                    && (mutation.status === 'pending' || mutation.status === 'syncing' || mutation.status === 'failed'))
                .map(mutation => `${mutation.entityType}:${mutation.entityId}`))

            for (const mutation of mutations) {
                const current = await db.offline_mutations.get(mutation.id)
                if (!current || current.workspaceId !== workspaceId || current.status !== mutation.status || current.createdAt !== mutation.createdAt) {
                    throw new Error('mutation_changed_during_recovery')
                }
            }

            for (const mutation of mutations) {
                if (mutation.entityType === 'stock_operations' && mutation.payload.effects && Array.isArray(mutation.payload.effects)) {
                    for (const effect of mutation.payload.effects as Array<Record<string, unknown>>) {
                        if (typeof effect.table === 'string' && typeof effect.id === 'string'
                            && !protectedEntities.has(`${effect.table}:${effect.id}`)) {
                            await getRecoveryTable(effect.table)?.delete(effect.id)
                        }
                    }
                }
            }

            for (const [tableName, result] of fetched) {
                const table = getRecoveryTable(tableName)
                if (!table) continue
                const remoteById = new Map<string, Record<string, unknown>>()
                for (const row of result.rows) {
                    if (typeof row.id === 'string') remoteById.set(row.id, row)
                }
                const touchedIds = new Set(result.requestedIds)
                for (const row of result.localFilterRows) touchedIds.add(String(row.id))
                for (const row of remoteById.values()) touchedIds.add(String(row.id))

                for (const id of touchedIds) {
                    if (protectedEntities.has(`${tableName}:${id}`)) continue
                    const remoteRow = remoteById.get(id)
                    if (!remoteRow) {
                        await table.delete(id)
                        continue
                    }
                    await table.put({
                        ...toCamelCase(remoteRow),
                        syncStatus: 'synced',
                        lastSyncedAt: recoveredAt
                    })
                }
            }

            for (const [tableName, ids] of localOnlyRemovals) {
                const table = getRecoveryTable(tableName)
                for (const id of ids) await table?.delete(id)
            }

            for (const mutation of mutations) {
                await db.offline_mutations.update(mutation.id, {
                    status: 'discarded',
                    error: undefined,
                    discardedAt: recoveredAt,
                    discardedBy: userId,
                    syncLeaseId: undefined,
                    syncLeaseUntil: undefined
                })
            }
        })
    } catch (error) {
        if (error instanceof Error && error.message === 'mutation_changed_during_recovery') {
            return { status: 'not_discarded', reason: 'changed_during_recovery' }
        }
        console.warn('[SyncRecovery] Failed to apply authoritative local recovery:', error)
        return { status: 'not_discarded', reason: 'remote_request_failed' }
    }

    return { status: 'discarded', count: mutations.length }
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

    const isRevokedPartnerMutation = isAccessRevokedBusinessPartnerMutation(mutation)
    if (!isRevokedPartnerMutation && await hasDependentQueuedChanges(mutation)) {
        return { status: 'not_discarded', reason: 'dependent_changes' }
    }

    const table = getEntityTable(mutation.entityType)
    if (!table) {
        return { status: 'not_discarded', reason: 'not_recoverable' }
    }

    const recoveredAt = new Date().toISOString()

    // An access-revoked partner cannot be fetched through the normal
    // workspace-scoped RPC. Retire edits to that partner and remove its local
    // row so private data is neither retained nor retried after access changes.
    if (isRevokedPartnerMutation) {
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

                // A permission-revoked partner cannot be reconciled from the
                // server. Retire every queued edit to this same partner so a
                // newer pending copy cannot recreate the same integrity issue.
                // Other queued entities that reference the partner stay intact.
                const partnerEdits = await getQueuedBusinessPartnerEdits(workspaceId, mutation.entityId)
                await table.delete(mutation.entityId)
                for (const partnerEdit of partnerEdits) {
                    await db.offline_mutations.update(partnerEdit.id, {
                        status: 'discarded',
                        error: undefined,
                        discardedAt: recoveredAt,
                        discardedBy: userId
                    })
                }
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
