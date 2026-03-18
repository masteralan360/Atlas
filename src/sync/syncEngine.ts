import { supabase, isSupabaseConfigured } from '@/auth/supabase'
import { db } from '@/local-db'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
// import { getPendingItems, removeFromQueue, incrementRetry } from './syncQueue'

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline'

export interface SyncResult {
    success: boolean
    pushed: number
    pulled: number
    errors: string[]
}

// Convert camelCase to snake_case
function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const key in obj) {
        const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
        result[snakeKey] = obj[key]
    }
    return result
}

// Convert snake_case to camelCase
function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const key in obj) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
        result[camelKey] = obj[key]
    }
    return result
}

// Get table name for entity type
function getTableName(entityType: string): string {
    return entityType
}

// Timeout helper
async function withTimeout<T>(promise: Promise<T>, ms: number = 15000): Promise<T> {
    return runSupabaseAction('sync.request', () => promise, { timeoutMs: ms, platform: 'all' })
}


// Process offline mutation queue
export async function processMutationQueue(userId: string): Promise<{ success: number; failed: number; error?: string }> {
    if (!isSupabaseConfigured) {
        return { success: 0, failed: 1, error: 'Supabase not configured' }
    }

    const mutations = await db.offline_mutations
        .where('status')
        .equals('pending')
        .sortBy('createdAt')

    console.log(`[Sync] processMutationQueue: Found ${mutations.length} pending mutations`)

    let successCount = 0

    for (const mutation of mutations) {
        // Update status to syncing
        await db.offline_mutations.update(mutation.id, { status: 'syncing' })

        try {
            const { entityType, operation, payload, entityId, workspaceId, id } = mutation
            const tableName = getTableName(entityType)
            const client = getSupabaseClientForTable(tableName)

            // Prepare payload
            const dbPayload = toSnakeCase(payload) as Record<string, unknown>
            // Ensure IDs and metadata
            dbPayload.user_id = userId
            dbPayload.workspace_id = workspaceId

            // Remove local metadata
            delete dbPayload.sync_status
            delete dbPayload.last_synced_at

            if (operation === 'create' || operation === 'update') {
                if (entityType === 'sales') {
                    const { data: serverResult, error } = await supabase.rpc('complete_sale', { payload: dbPayload })
                    if (error) throw error

                    // Capture sequence_id and update local records
                    const result = serverResult as any
                    if (result?.sequence_id) {
                        const sequenceId = result.sequence_id
                        const formattedInvoiceId = `#${String(sequenceId).padStart(5, '0')}`

                        // Update both sales and invoices tables locally
                        await db.sales.update(entityId, { sequenceId })
                        await db.invoices.update(entityId, {
                            sequenceId,
                            invoiceid: formattedInvoiceId
                        })
                    }
                } else if (entityType === 'workspaces') {
                    // Remove workspace_id from payload for workspace table update itself
                    delete dbPayload.workspace_id
                    delete dbPayload.user_id
                    const { error } = await client.from(tableName).update(dbPayload).eq('id', entityId)
                    if (error) throw error
                } else {
                    // Special handling for invoices to remove legacy fields
                    if (tableName === 'invoices') {
                        delete dbPayload.items
                        delete dbPayload.currency
                        delete dbPayload.subtotal
                        delete dbPayload.discount
                        delete dbPayload.print_metadata
                        delete dbPayload.is_snapshot
                    }

                    const { error } = await client.from(tableName).upsert(dbPayload)
                    if (error) throw error
                }
            } else if (operation === 'delete') {
                if (tableName === 'loans') {
                    const { error } = await client.from(tableName).delete().eq('id', entityId)
                    if (error) throw error
                } else {
                    const { error } = await client.from(tableName).update({ is_deleted: true, updated_at: new Date().toISOString() }).eq('id', entityId)
                    if (error) throw error
                }
            }

            // Success: Mark as synced
            await db.offline_mutations.update(id, { status: 'synced' }) // Or delete if preferred, but synced is good for history

            // Also update the actual entity sync status to 'synced'
            const table = (db as any)[entityType]
            if (table) {
                if (operation === 'delete' && entityType === 'loans') {
                    await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments], async () => {
                        await db.loans.delete(entityId)
                        await db.loan_installments.where('loanId').equals(entityId).delete()
                        await db.loan_payments.where('loanId').equals(entityId).delete()
                    })
                } else {
                    await table.update(entityId, { syncStatus: 'synced', lastSyncedAt: new Date().toISOString() })
                }
            }

            successCount++

        } catch (err: any) {
            console.error(`[Sync] Failed mutation ${mutation.id}:`, err)
            await db.offline_mutations.update(mutation.id, { status: 'failed', error: err.message || 'Unknown error' })
            // Stop processing on first error to maintain order integrity
            return { success: successCount, failed: 1, error: err.message }
        }
    }

    return { success: successCount, failed: 0 }
}

// Deprecated: Old pushChanges (kept for reference or fallback if needed during transition)
export async function pushChanges(_userId: string, _workspaceId: string): Promise<{ success: number; failed: number }> {
    // Redirect to new logic? Or just leave as legacy.
    // For now, let's leave it but maybe logs warning.
    console.warn('[Sync] pushChanges is deprecated. Use processMutationQueue.')
    return { success: 0, failed: 0 }
}

// Pull changes from Supabase
export async function pullChanges(workspaceId: string, lastSyncTime: string | null): Promise<{ pulled: number }> {
    if (isLocalWorkspaceMode(workspaceId)) {
        return { pulled: 0 }
    }

    if (!isSupabaseConfigured) {
        console.log('[Sync] pullChanges: Supabase not configured')
        return { pulled: 0 }
    }

    const since = lastSyncTime || '1970-01-01T00:00:00Z'
    console.log(`[Sync] pullChanges START: Workspace ${workspaceId}, since ${since}`)

    let totalPulled = 0

    const tables = [
        'products',
        'categories',
        'customers',
        'orders',
        'invoices',
        'workspaces',
        'sales',
        'budget_settings',
        'budget_allocations',
        'expense_series',
        'expense_items',
        'payroll_statuses',
        'dividend_statuses',
        'loans',
        'loan_installments',
        'loan_payments'
    ]

    for (const table of tables) {
        try {
            const client = getSupabaseClientForTable(table)
            // console.log(`[Sync] pullChanges: Fetching ${table}...`)
            const { data, error } = (await withTimeout(
                table === 'workspaces'
                    ? client.from(table).select('*').eq('id', workspaceId).gt('updated_at', since)
                    : client.from(table).select('*').eq('workspace_id', workspaceId).gt('updated_at', since) as any,
                30000
            )) as any

            if (error) {
                console.error(`[Sync] pullChanges: Error fetching ${table}:`, error)
                continue
            }

            if (data && data.length > 0) {
                console.log(`[Sync] pullChanges: Processing ${data.length} items for ${table}`)
                const dbTable = (db as any)[table]

                for (const remoteItem of data) {
                    const localItem = await dbTable.get(remoteItem.id)
                    const remoteData = toCamelCase(remoteItem)

                    // Version control: Last Write Wins based on updated_at
                    // If local has newer version/updatedAt pending sync, don't overwrite?
                    // But we are manual sync. If pulling, we assume server is truth.
                    // However, if we have pending local changes, we should probably NOT overwrite them until we push?
                    // Strategy: "Prioritize Supabase as single source of truth".
                    // If we have pending local changes for this ID, we might have a conflict.
                    // For V1, "Last Write Wins". If server is newer, taking server.
                    // But if local is pending, it might be newer than server (but not pushed).
                    // If we overwrite local pending with server (which matches old local state), we lose the mutation.
                    // BUT our mutation is stored in `offline_mutations`!
                    // So even if we overwrite the Entity table, the Mutation Queue still has the pending operation.
                    // When we push, we will re-apply the mutation to server and then server will send back the final state.
                    // So it is SAFE to overwrite Entity table because `offline_mutations` is the intent source of truth for "My Pending Changes".

                    if (!localItem || localItem.version < (remoteData as any).version) {
                        const localThermalPrinting = table === 'workspaces'
                            ? (localItem as any)?.thermal_printing
                            : undefined
                        const workspaceOverrides = table === 'workspaces' && typeof localThermalPrinting === 'boolean'
                            ? { thermal_printing: localThermalPrinting }
                            : {}

                        await dbTable.put({
                            ...remoteData,
                            ...workspaceOverrides,
                            syncStatus: 'synced',
                            lastSyncedAt: new Date().toISOString()
                        })
                        totalPulled++
                    }
                }
            }
        } catch (err: any) {
            console.error(`[Sync] pullChanges: Critical error fetching ${table}:`, err.message || err)
        }
    }

    console.log(`[Sync] pullChanges COMPLETE: Total items pulled: ${totalPulled}`)
    return { pulled: totalPulled }
}

// Full sync - Process queue then pull
export async function fullSync(userId: string, workspaceId: string, lastSyncTime: string | null): Promise<SyncResult> {
    if (isLocalWorkspaceMode(workspaceId)) {
        return {
            success: true,
            pushed: 0,
            pulled: 0,
            errors: []
        }
    }

    console.log(`[Sync] fullSync START for User ${userId}, Workspace ${workspaceId}`)

    // 1. Process Offline Mutations
    const { success, failed, error } = await processMutationQueue(userId)

    // 2. Pull Changes (Force pull to ensure consistency)
    const { pulled } = await pullChanges(workspaceId, lastSyncTime)

    return {
        success: failed === 0,
        pushed: success,
        pulled,
        errors: error ? [error] : []
    }
}
