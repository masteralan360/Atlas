import { isOrderArchiveEligible, type OrderArchiveKind } from '@/lib/orderArchiving'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { isOnline } from '@/lib/network'
import { getWorkspaceDataMode, isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { isCrudDebuggerEnabled, runCrudOperation, type CrudTraceHandle } from '@/dev/crud-debugger/trace'
import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import { invalidateOrdersList } from '@/query/invalidateOrdersList'
import type { PurchaseOrder, SalesOrder } from './models'

type OrderTableName = 'sales_orders' | 'purchase_orders'

/** Change only the archive flag; the database independently checks eligibility and the one-field update. */
async function setOrderArchivedInternal(orderId: string, kind: OrderArchiveKind, isArchived: boolean, trace?: CrudTraceHandle) {
    const tableName: OrderTableName = kind === 'sales' ? 'sales_orders' : 'purchase_orders'
    const table = (db as unknown as Record<OrderTableName, any>)[tableName]
    const existing = await (trace
        ? trace.measure('crudDebugger.stages.salesOrderLocalRead', 'data', () => table.get(orderId), 'crudDebugger.details.dexiePersistence')
        : table.get(orderId)) as SalesOrder | PurchaseOrder | undefined
    if (!existing || existing.isDeleted) {
        throw new Error('order_archive_not_found')
    }
    trace?.setEntityId(existing.id)
    trace?.setWorkspaceMode(getWorkspaceDataMode(existing.workspaceId))

    const wasArchived = existing.isArchived === true
    if (wasArchived === isArchived) {
        return { ...existing, isArchived }
    }
    if (isArchived && !isOrderArchiveEligible(existing, kind)) {
        throw new Error('order_archive_not_allowed')
    }

    const usesCloud = !isLocalWorkspaceMode(existing.workspaceId)
    if (usesCloud && existing.syncStatus !== 'synced') {
        throw new Error('order_archive_wait_for_sync')
    }
    let queueForSync = usesCloud && !isOnline(existing.workspaceId)
    if (usesCloud && !queueForSync) {
        try {
            const client = getSupabaseClientForTable(tableName)
            const { data, error } = await (trace
                ? trace.measure('crudDebugger.stages.salesOrderRemote', 'network', () => runSupabaseAction(`${tableName}.archive`, () => client
                    .from(tableName)
                    .update({ is_archived: isArchived })
                    .eq('id', orderId)
                    .eq('workspace_id', existing.workspaceId)
                    .eq('is_archived', wasArchived)
                    .select('id, is_archived')
                    .maybeSingle()
                ), 'crudDebugger.details.salesOrderRemoteRoundTrip')
                : runSupabaseAction(`${tableName}.archive`, () => client
                    .from(tableName)
                    .update({ is_archived: isArchived })
                    .eq('id', orderId)
                    .eq('workspace_id', existing.workspaceId)
                    .eq('is_archived', wasArchived)
                    .select('id, is_archived')
                    .maybeSingle()
                ))
            if (error) throw error
            if (data?.id !== orderId || data.is_archived !== isArchived) {
                throw new Error('order_archive_conflict')
            }

            const syncedAt = new Date().toISOString()
            await (trace
                ? trace.measure('crudDebugger.stages.salesOrderResponse', 'response', () => table.update(orderId, {
                    isArchived,
                    syncStatus: 'synced',
                    lastSyncedAt: syncedAt
                }))
                : table.update(orderId, {
                    isArchived,
                    syncStatus: 'synced',
                    lastSyncedAt: syncedAt
                }))
            invalidateOrdersList(existing.workspaceId, kind)
            return { ...existing, isArchived, syncStatus: 'synced' as const, lastSyncedAt: syncedAt }
        } catch (error) {
            if (!isRetriableWebRequestError(error)) {
                throw normalizeSupabaseActionError(error)
            }
            queueForSync = true
        }
    }

    if (queueForSync) {
        const queuedOrder = {
            ...existing,
            isArchived,
            syncStatus: 'pending' as const,
            lastSyncedAt: null
        }
        const queue = () => db.transaction('rw', [table, db.offline_mutations], async () => {
            await table.put(queuedOrder)
            await addToOfflineMutations(
                tableName,
                orderId,
                'update',
                queuedOrder as unknown as Record<string, unknown>,
                existing.workspaceId
            )
        })
        await (trace
            ? trace.measure('crudDebugger.stages.salesOrderOfflineQueue', 'data', queue, 'crudDebugger.details.queuedForSync')
            : queue())
        trace?.addPendingStage('crudDebugger.stages.remoteSyncQueued', 'network', 'crudDebugger.details.queuedForSync')
        invalidateOrdersList(existing.workspaceId, kind)
        return queuedOrder
    }

    // Local mode persists the flag through the existing Dexie / SQLite mirror only.
    await (trace
        ? trace.measure('crudDebugger.stages.salesOrderLocalWrite', 'persistence', () => table.update(orderId, { isArchived }), 'crudDebugger.details.dexiePersistence')
        : table.update(orderId, { isArchived }))
    invalidateOrdersList(existing.workspaceId, kind)
    return { ...existing, isArchived }
}

export function setOrderArchived(orderId: string, kind: OrderArchiveKind, isArchived: boolean) {
    if (kind !== 'sales' || !isCrudDebuggerEnabled()) {
        return setOrderArchivedInternal(orderId, kind, isArchived)
    }
    return runCrudOperation({ action: 'update', entityKey: 'salesOrder', entityId: orderId }, (trace) =>
        setOrderArchivedInternal(orderId, kind, isArchived, trace)
    )
}
