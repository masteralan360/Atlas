import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { supabase } from '@/auth/supabase'
import { isOnline } from '@/lib/network'
import { generateId } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations } from './offlineMutations'
import type {
    RestaurantPosTicket,
    RestaurantPosTicketItem,
    RestaurantPosTicketStatus,
    RestaurantTableSettings,
    SyncStatus,
} from './models'

type RemoteRow = Record<string, unknown>
type RestaurantMutationRow = (RestaurantTableSettings | RestaurantPosTicket) & { hardDelete?: boolean }

const now = () => new Date().toISOString()
let restaurantRealtimeSubscriptionSequence = 0

function stringValue(value: unknown, fallback = '') {
    return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown, fallback = 0) {
    const numeric = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(numeric) ? numeric : fallback
}

function booleanValue(value: unknown, fallback = false) {
    return typeof value === 'boolean' ? value : fallback
}

function toSnakeCase(row: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(row)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]))
}

function ticketItems(value: unknown): RestaurantPosTicketItem[] {
    return Array.isArray(value) ? value as RestaurantPosTicketItem[] : []
}

export function restaurantTableSettingsFromRemote(row: RemoteRow): RestaurantTableSettings {
    const createdAt = stringValue(row.created_at ?? row.createdAt, now())
    const vipTableNumbers = row.vip_table_numbers ?? row.vipTableNumbers
    return {
        id: stringValue(row.id),
        workspaceId: stringValue(row.workspace_id ?? row.workspaceId),
        enabled: booleanValue(row.enabled),
        liveSyncEnabled: booleanValue(row.live_sync_enabled ?? row.liveSyncEnabled),
        tableCount: numberValue(row.table_count ?? row.tableCount, 20),
        vipTableNumbers: Array.isArray(vipTableNumbers)
            ? vipTableNumbers.map((value: unknown) => numberValue(value)).filter((value) => value > 0)
            : [],
        createdAt,
        updatedAt: stringValue(row.updated_at ?? row.updatedAt, createdAt),
        version: numberValue(row.version, 1),
        isDeleted: booleanValue(row.is_deleted ?? row.isDeleted),
        syncStatus: 'synced',
        lastSyncedAt: now(),
    }
}

export function restaurantPosTicketFromRemote(row: RemoteRow): RestaurantPosTicket {
    const createdAt = stringValue(row.created_at ?? row.createdAt, now())
    const status = stringValue(row.status, 'pending') as RestaurantPosTicketStatus
    return {
        id: stringValue(row.id),
        workspaceId: stringValue(row.workspace_id ?? row.workspaceId),
        tableNumber: numberValue(row.table_number ?? row.tableNumber),
        number: stringValue(row.number),
        status: ['pending', 'preparing', 'ready', 'served'].includes(status) ? status : 'pending',
        items: ticketItems(row.items),
        note: stringValue(row.note) || undefined,
        kitchenRoutedAt: stringValue(row.kitchen_routed_at ?? row.kitchenRoutedAt) || undefined,
        createdBy: stringValue(row.created_by ?? row.createdBy) || null,
        createdAt,
        updatedAt: stringValue(row.updated_at ?? row.updatedAt, createdAt),
        version: numberValue(row.version, 1),
        isDeleted: booleanValue(row.is_deleted ?? row.isDeleted),
        syncStatus: 'synced',
        lastSyncedAt: now(),
    }
}

function toRemotePayload(row: RestaurantTableSettings | RestaurantPosTicket) {
    const { syncStatus: _syncStatus, lastSyncedAt: _lastSyncedAt, ...persisted } = row
    return toSnakeCase(persisted)
}

async function queueRestaurantMutation(
    entityType: 'restaurant_table_settings' | 'restaurant_pos_tickets',
    row: RestaurantMutationRow,
    operation: 'create' | 'update' | 'delete',
) {
    await addToOfflineMutations(entityType, row.id, operation, row as unknown as Record<string, unknown>, row.workspaceId)
}

export async function refreshRestaurantTableSettingsFromSupabase(workspaceId?: string | null) {
    if (!workspaceId || isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) return
    const { data, error } = await supabase
        .from('restaurant_table_settings')
        .select('*')
        .eq('workspace_id', workspaceId)
        .maybeSingle()
    if (error) throw error
    const existing = await db.restaurant_table_settings.where('workspaceId').equals(workspaceId).first()
    if (!data) {
        // A remotely deleted configuration means Restaurant Table View is off.
        // Retain only an unsynced local create so it can still be uploaded later.
        if (existing && existing.syncStatus !== 'pending') {
            await db.restaurant_table_settings.delete(existing.id)
        }
        return
    }
    const incoming = restaurantTableSettingsFromRemote(data as RemoteRow)
    // A request started before a save can return the previous settings
    // row afterwards. It must not overwrite the newer local selection.
    if (existing && (
        existing.version > incoming.version
        || (existing.syncStatus === 'pending' && existing.updatedAt >= incoming.updatedAt)
    )) return
    await db.restaurant_table_settings.put(incoming)
}

export async function refreshRestaurantPosTicketsFromSupabase(workspaceId?: string | null) {
    if (!workspaceId || isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) return
    const { data, error } = await supabase
        .from('restaurant_pos_tickets')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('is_deleted', false)
        .order('updated_at', { ascending: false })
    if (error) throw error
    const pendingHardDeleteIds = new Set((await db.offline_mutations
        .where('workspaceId')
        .equals(workspaceId)
        .toArray())
        .filter((mutation) => (
            mutation.entityType === 'restaurant_pos_tickets'
            && mutation.operation === 'delete'
            && mutation.payload.hardDelete === true
            && mutation.status !== 'synced'
            && mutation.status !== 'acknowledged'
            && mutation.status !== 'abandoned'
        ))
        .map((mutation) => mutation.entityId))
    const tickets = (data ?? [])
        .map((row) => restaurantPosTicketFromRemote(row as RemoteRow))
        .filter((ticket) => !pendingHardDeleteIds.has(ticket.id))
    await db.transaction('rw', db.restaurant_pos_tickets, async () => {
        const local = await db.restaurant_pos_tickets.where('workspaceId').equals(workspaceId).toArray()
        const remoteIds = new Set(tickets.map((ticket) => ticket.id))
        const staleIds = local.filter((ticket) => !ticket.isDeleted && ticket.syncStatus === 'synced' && !remoteIds.has(ticket.id)).map((ticket) => ticket.id)
        if (staleIds.length) await db.restaurant_pos_tickets.bulkDelete(staleIds)
        if (tickets.length) await db.restaurant_pos_tickets.bulkPut(tickets)
    })
}

function subscribeToRestaurantTableSettings(workspaceId: string) {
    if (isLocalWorkspaceMode(workspaceId)) return () => undefined
    const channel = supabase
        .channel(`restaurant-table-settings:${workspaceId}:${++restaurantRealtimeSubscriptionSequence}`)
        .on('postgres_changes', {
            event: '*', schema: 'public', table: 'restaurant_table_settings', filter: `workspace_id=eq.${workspaceId}`
        }, () => {
            void refreshRestaurantTableSettingsFromSupabase(workspaceId)
        })
        .subscribe()
    return () => { void supabase.removeChannel(channel) }
}

function subscribeToRestaurantPosTickets(workspaceId: string) {
    if (isLocalWorkspaceMode(workspaceId)) return () => undefined
    const channel = supabase
        .channel(`restaurant-pos-tickets:${workspaceId}:${++restaurantRealtimeSubscriptionSequence}`)
        .on('postgres_changes', {
            event: '*', schema: 'public', table: 'restaurant_pos_tickets', filter: `workspace_id=eq.${workspaceId}`
        }, () => {
            void refreshRestaurantPosTicketsFromSupabase(workspaceId)
        })
        .subscribe()
    return () => { void supabase.removeChannel(channel) }
}

export function useRestaurantTableSettings(workspaceId?: string | null) {
    const settings = useLiveQuery(async () => {
        if (!workspaceId) return undefined
        return db.restaurant_table_settings.where('workspaceId').equals(workspaceId).filter((row) => !row.isDeleted).first()
    }, [workspaceId])

    useEffect(() => {
        if (!workspaceId) return
        void refreshRestaurantTableSettingsFromSupabase(workspaceId).catch(console.error)
        return subscribeToRestaurantTableSettings(workspaceId)
    }, [workspaceId])

    return settings
}

export function useRestaurantPosTickets(workspaceId?: string | null, liveSyncEnabled = false) {
    const tickets = useLiveQuery(async () => {
        if (!workspaceId) return []
        const rows = await db.restaurant_pos_tickets.where('workspaceId').equals(workspaceId).toArray()
        return rows.filter((ticket) => !ticket.isDeleted).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    }, [workspaceId]) ?? []

    useEffect(() => {
        if (!workspaceId || !liveSyncEnabled) return
        void refreshRestaurantPosTicketsFromSupabase(workspaceId).catch(console.error)
        return subscribeToRestaurantPosTickets(workspaceId)
    }, [liveSyncEnabled, workspaceId])

    return tickets
}

async function saveRestaurantRow<T extends RestaurantTableSettings | RestaurantPosTicket>(
    table: 'restaurant_table_settings' | 'restaurant_pos_tickets',
    row: T,
    operation: 'create' | 'update' | 'delete',
    options?: { requireRemote?: boolean, onConflict?: string, hardDelete?: boolean, liveSyncEnabled?: boolean }
) {
    const localTable = table === 'restaurant_table_settings'
        ? db.restaurant_table_settings
        : db.restaurant_pos_tickets
    const shouldUseLiveSync = options?.liveSyncEnabled === true && !isLocalWorkspaceMode(row.workspaceId)
    const pendingRow = {
        ...row,
        syncStatus: shouldUseLiveSync ? 'pending' as SyncStatus : 'synced' as SyncStatus,
        lastSyncedAt: shouldUseLiveSync ? null : now(),
    }
    const shouldHardDelete = options?.hardDelete === true
    const mutationRow: RestaurantMutationRow = shouldHardDelete
        ? { ...pendingRow, hardDelete: true }
        : pendingRow

    if (shouldHardDelete) {
        await localTable.delete(row.id)
    } else {
        await localTable.put(pendingRow as never)
    }

    if (!shouldUseLiveSync || !isOnline(row.workspaceId)) {
        if (shouldUseLiveSync) await queueRestaurantMutation(table, mutationRow, operation)
        return pendingRow
    }

    const request = operation === 'delete'
        ? shouldHardDelete
            // Restaurant Table View is a one-row-per-workspace setting. Use the
            // workspace key rather than a cached id so an administrator can
            // always turn it off after the remote row was recreated or the
            // local cache was cleared.
            ? table === 'restaurant_table_settings'
                ? supabase.from(table).delete().eq('workspace_id', row.workspaceId)
                : supabase.from(table).delete().eq('id', row.id)
            : supabase.from(table).update({ is_deleted: true, updated_at: now() }).eq('id', row.id).select('*').single()
        : supabase.from(table).upsert(toRemotePayload(pendingRow), options?.onConflict ? { onConflict: options.onConflict } : undefined).select('*').single()
    const { data, error } = await request
    if (error) {
        await queueRestaurantMutation(table, mutationRow, operation)
        if (options?.requireRemote) throw error
        return pendingRow
    }

    if (shouldHardDelete) return pendingRow

    const synced = table === 'restaurant_table_settings'
        ? restaurantTableSettingsFromRemote(data as RemoteRow)
        : restaurantPosTicketFromRemote(data as RemoteRow)
    await localTable.put(synced as never)
    return synced as T
}

export async function saveRestaurantTableSettings(input: Omit<RestaurantTableSettings, keyof import('./models').BaseEntity> & {
    id?: string
    createdAt?: string
    version?: number
}, workspaceId: string) {
    const existing = await db.restaurant_table_settings.where('workspaceId').equals(workspaceId).first()
    if (!input.enabled) {
        if (!existing) {
            // The server owns the workspace configuration in cloud and hybrid
            // modes. A missing/stale local cache must never prevent the admin
            // from deleting a remote settings row.
            if (!isLocalWorkspaceMode(workspaceId) && isOnline(workspaceId)) {
                const { error } = await supabase
                    .from('restaurant_table_settings')
                    .delete()
                    .eq('workspace_id', workspaceId)
                if (error) throw error
            }
            return undefined
        }
        return saveRestaurantRow('restaurant_table_settings', existing, 'delete', {
            hardDelete: true,
            requireRemote: !isLocalWorkspaceMode(workspaceId),
            liveSyncEnabled: !isLocalWorkspaceMode(workspaceId)
        })
    }
    const timestamp = now()
    const row: RestaurantTableSettings = {
        id: existing?.id ?? input.id ?? generateId(),
        workspaceId,
        enabled: input.enabled,
        liveSyncEnabled: input.liveSyncEnabled,
        tableCount: input.tableCount,
        vipTableNumbers: input.vipTableNumbers,
        createdAt: existing?.createdAt ?? input.createdAt ?? timestamp,
        updatedAt: timestamp,
        version: existing?.version ?? input.version ?? 1,
        isDeleted: false,
        syncStatus: existing?.syncStatus ?? 'pending',
        lastSyncedAt: existing?.lastSyncedAt ?? null,
    }
    return saveRestaurantRow('restaurant_table_settings', row, existing ? 'update' : 'create', {
        requireRemote: !isLocalWorkspaceMode(workspaceId),
        onConflict: 'workspace_id',
        liveSyncEnabled: !isLocalWorkspaceMode(workspaceId)
    })
}

export async function createRestaurantPosTicket(ticket: RestaurantPosTicket, liveSyncEnabled = false) {
    return saveRestaurantRow('restaurant_pos_tickets', ticket, 'create', {
        requireRemote: liveSyncEnabled && !isLocalWorkspaceMode(ticket.workspaceId),
        liveSyncEnabled
    })
}

export async function saveRestaurantPosTicket(ticket: RestaurantPosTicket, liveSyncEnabled = false) {
    return saveRestaurantRow('restaurant_pos_tickets', ticket, 'update', { liveSyncEnabled })
}

export async function closeRestaurantPosTicket(ticket: RestaurantPosTicket, liveSyncEnabled = false) {
    const timestamp = now()
    return saveRestaurantRow('restaurant_pos_tickets', {
        ...ticket,
        isDeleted: true,
        updatedAt: timestamp,
        version: ticket.version + 1,
    }, 'delete', { liveSyncEnabled })
}

export async function hardDeleteRestaurantPosTicket(ticket: RestaurantPosTicket, liveSyncEnabled = false) {
    return saveRestaurantRow('restaurant_pos_tickets', ticket, 'delete', { hardDelete: true, liveSyncEnabled })
}

export async function moveRestaurantPosTicket(ticket: RestaurantPosTicket, destinationTableNumber: number, liveSyncEnabled = false) {
    if (!liveSyncEnabled || isLocalWorkspaceMode(ticket.workspaceId) || !isOnline(ticket.workspaceId)) {
        return saveRestaurantPosTicket({
            ...ticket,
            tableNumber: destinationTableNumber,
            updatedAt: now(),
            version: ticket.version + 1,
        }, liveSyncEnabled)
    }

    const { data, error } = await supabase.rpc('move_restaurant_pos_ticket', {
        p_ticket_id: ticket.id,
        p_destination_table_number: destinationTableNumber,
    })
    if (error) throw error
    const moved = restaurantPosTicketFromRemote(data as RemoteRow)
    await db.restaurant_pos_tickets.put(moved)
    return moved
}
