import { isSaleFullyReturned } from '@/lib/saleArchiving'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import type { Sale } from './models'

/** Persist only the archive flag; sale items, returns, inventory and payments are untouched. */
export async function setSaleArchived(saleId: string, isArchived: boolean) {
    const existing = await db.sales.get(saleId) as Sale | undefined
    if (!existing || existing.isDeleted) throw new Error('sale_archive_not_found')

    const wasArchived = existing.isArchived === true
    if (wasArchived === isArchived) return { ...existing, isArchived }
    if (isArchived && !isSaleFullyReturned(existing)) throw new Error('sale_archive_not_allowed')

    const usesCloud = !isLocalWorkspaceMode(existing.workspaceId)
    if (usesCloud && existing.syncStatus !== 'synced') {
        throw new Error('sale_archive_wait_for_sync')
    }

    let queueForSync = usesCloud && !isOnline(existing.workspaceId)
    if (usesCloud && !queueForSync) {
        try {
            const client = getSupabaseClientForTable('sales')
            const { data, error } = await runSupabaseAction('sales.archive', () => client
                .from('sales')
                .update({ is_archived: isArchived })
                .eq('id', saleId)
                .eq('workspace_id', existing.workspaceId)
                .eq('is_archived', wasArchived)
                .select('id,is_archived')
                .maybeSingle()
            )
            if (error) throw error
            if (data?.id !== saleId || data.is_archived !== isArchived) {
                throw new Error('sale_archive_conflict')
            }

            const syncedAt = new Date().toISOString()
            await db.sales.update(saleId, {
                isArchived,
                syncStatus: 'synced',
                lastSyncedAt: syncedAt
            })
            return { ...existing, isArchived, syncStatus: 'synced' as const, lastSyncedAt: syncedAt }
        } catch (error) {
            if (!isRetriableWebRequestError(error)) throw normalizeSupabaseActionError(error)
            queueForSync = true
        }
    }

    if (queueForSync) {
        await db.transaction('rw', [db.sales, db.offline_mutations], async () => {
            await db.sales.update(saleId, { isArchived, syncStatus: 'pending', lastSyncedAt: null })
            await addToOfflineMutations('sales', saleId, 'update', { isArchived }, existing.workspaceId)
        })
        return { ...existing, isArchived, syncStatus: 'pending' as const, lastSyncedAt: null }
    }

    await db.sales.update(saleId, { isArchived })
    return { ...existing, isArchived }
}
