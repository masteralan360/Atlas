import { isOrderArchiveEligible, type OrderArchiveKind } from '@/lib/orderArchiving'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import type { PurchaseOrder, SalesOrder } from './models'

type OrderTableName = 'sales_orders' | 'purchase_orders'

/** Change only the archive flag; the database independently checks eligibility and the one-field update. */
export async function setOrderArchived(orderId: string, kind: OrderArchiveKind, isArchived: boolean) {
    const tableName: OrderTableName = kind === 'sales' ? 'sales_orders' : 'purchase_orders'
    const table = (db as unknown as Record<OrderTableName, any>)[tableName]
    const existing = await table.get(orderId) as SalesOrder | PurchaseOrder | undefined
    if (!existing || existing.isDeleted) {
        throw new Error('order_archive_not_found')
    }

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
            const { data, error } = await runSupabaseAction(`${tableName}.archive`, () => client
                .from(tableName)
                .update({ is_archived: isArchived })
                .eq('id', orderId)
                .eq('workspace_id', existing.workspaceId)
                .eq('is_archived', wasArchived)
                .select('id, is_archived')
                .maybeSingle()
            )
            if (error) throw error
            if (data?.id !== orderId || data.is_archived !== isArchived) {
                throw new Error('order_archive_conflict')
            }

            const syncedAt = new Date().toISOString()
            await table.update(orderId, {
                isArchived,
                syncStatus: 'synced',
                lastSyncedAt: syncedAt
            })
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
        await db.transaction('rw', [table, db.offline_mutations], async () => {
            await table.put(queuedOrder)
            await addToOfflineMutations(
                tableName,
                orderId,
                'update',
                queuedOrder as unknown as Record<string, unknown>,
                existing.workspaceId
            )
        })
        return queuedOrder
    }

    // Local mode persists the flag through the existing Dexie / SQLite mirror only.
    await table.update(orderId, { isArchived })
    return { ...existing, isArchived }
}
