import { useQuery } from '@tanstack/react-query'
import type { InsertType, Table } from 'dexie'
import { useOptionalAuth } from '@/auth'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import i18n from '@/i18n/config'
import { getSupabaseClientForTable, getSupabaseRemoteTableName } from '@/lib/supabaseSchema'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { toCamelCase } from '@/lib/utils'
import { useOptionalWorkspacePermissions } from '@/permissions/workspacePermissionsState'
import { queryKeys } from '@/query/queryKeys'
import { useWorkspace } from '@/workspace'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'
import { db } from './database'
import type { OrderType, PurchaseOrder, SalesOrder } from './models'
import { useStorageAccess } from './storagePermissions'

async function refreshOrder<T extends SalesOrder | PurchaseOrder>(
    workspaceId: string,
    orderId: string,
    tableName: 'sales_orders' | 'purchase_orders',
    table: Table<T, string, InsertType<T, 'id'>>,
    signal?: AbortSignal
) {
    const cachedAtStart = await table.get(orderId)
    const client = getSupabaseClientForTable(tableName)
    const { data, error } = await runSupabaseAction(`orders.detail.${tableName}`, () => {
        const request = client.from(getSupabaseRemoteTableName(tableName)).select('*')
            .eq('workspace_id', workspaceId).eq('id', orderId)
        return (signal ? request.abortSignal(signal) : request).maybeSingle()
    })
    signal?.throwIfAborted()
    if (error) throw normalizeSupabaseActionError(error)

    const remote = data ? {
        ...(toCamelCase(data) as unknown as T),
        syncStatus: 'synced' as const,
        lastSyncedAt: new Date().toISOString()
    } : null
    if (remote) {
        if (remote.id !== orderId || remote.workspaceId !== workspaceId || !Number.isSafeInteger(remote.version)
            || Number.isNaN(Date.parse(remote.updatedAt)) || !Array.isArray(remote.items)) {
            throw new Error(i18n.t('orders.details.loadErrorDescription'))
        }
        remote.isArchived = remote.isArchived === true
    }

    if (await canReconcileCloudWorkspaceData(workspaceId)) {
        await db.transaction('rw', table, async () => {
            const local = await table.get(orderId)
            signal?.throwIfAborted()
            if (local && (local.workspaceId !== workspaceId || (local.syncStatus && local.syncStatus !== 'synced'))) return
            if (remote && (!local || remote.version > local.version
                || (remote.version === local.version && (Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)
                    || (remote.isDeleted && !local.isDeleted))))) {
                await table.put(remote)
            } else if (!remote && local && cachedAtStart?.version === local.version && cachedAtStart.updatedAt === local.updatedAt) {
                await table.delete(orderId)
            }
        })
    }

    return remote?.isDeleted ? null : remote
}

export function refreshOrderDetails(workspaceId: string, orderId: string, kind: OrderType, signal?: AbortSignal) {
    return kind === 'sales'
        ? refreshOrder(workspaceId, orderId, 'sales_orders', db.sales_orders, signal)
        : refreshOrder(workspaceId, orderId, 'purchase_orders', db.purchase_orders, signal)
}

export function useOrderDetailsRemoteLookup(workspaceId: string, orderId: string) {
    const online = useNetworkStatus()
    const { isLocalMode, isHybridMode } = useWorkspace()
    const user = useOptionalAuth()?.user
    const permissions = useOptionalWorkspacePermissions()
    const storageAccess = useStorageAccess(workspaceId)
    const scope = JSON.stringify([user?.id, user?.role, permissions?.permissionKeys, storageAccess.signature, isHybridMode])
    return useQuery({
        queryKey: queryKeys.orders.detail(workspaceId, orderId, scope),
        queryFn: async ({ signal }) => {
            await Promise.all([
                refreshOrderDetails(workspaceId, orderId, 'sales', signal),
                refreshOrderDetails(workspaceId, orderId, 'purchase', signal)
            ])
            return true
        },
        enabled: !!workspaceId && !!orderId && online && !isLocalMode,
        refetchOnMount: 'always',
        refetchOnReconnect: 'always',
        refetchOnWindowFocus: 'always',
        refetchInterval: 15_000
    })
}
