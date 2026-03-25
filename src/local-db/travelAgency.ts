import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import type { TravelAgencySale } from './models'

const TABLE_NAME = 'travel_agency_sales'

type BaseEntityPayload = {
    id: string
    workspaceId: string
    createdAt: string
    updatedAt: string
    syncStatus: 'pending' | 'synced' | 'conflict'
    lastSyncedAt: string | null
    version: number
    isDeleted: boolean
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

async function runMutation<T>(label: string, promiseFactory: () => PromiseLike<T>): Promise<T> {
    return runSupabaseAction(label, promiseFactory)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return {
            syncStatus: 'synced' as const,
            lastSyncedAt: timestamp
        }
    }

    return {
        syncStatus: 'pending' as const,
        lastSyncedAt: null
    }
}

function sanitizeSyncPayload(entity: Record<string, unknown>) {
    const payload = { ...entity }
    delete payload.syncStatus
    delete payload.lastSyncedAt

    return Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
            value
        ])
    )
}

async function markEntitiesSynced(ids: string[]) {
    const syncedAt = new Date().toISOString()
    await Promise.all(ids.map((id) => db.travel_agency_sales.update(id, { syncStatus: 'synced', lastSyncedAt: syncedAt })))
}

async function queueOfflineUpserts(
    entities: Array<{ id: string; version: number } & Record<string, unknown>>,
    workspaceId: string
) {
    await Promise.all(entities.map((entity) =>
        addToOfflineMutations(
            TABLE_NAME,
            entity.id,
            entity.version > 1 ? 'update' : 'create',
            entity,
            workspaceId
        )
    ))
}

async function syncUpsertEntities(
    entities: Array<{ id: string; version: number } & Record<string, unknown>>,
    workspaceId: string
) {
    if (!entities.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline(workspaceId)) {
        await queueOfflineUpserts(entities, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(TABLE_NAME)
        const payload = entities.map((entity) => sanitizeSyncPayload(entity))
        const { error } = await runMutation(`${TABLE_NAME}.sync`, () => client.from(TABLE_NAME).upsert(payload))
        if (error) {
            throw error
        }

        await markEntitiesSynced(entities.map((entity) => entity.id))
    } catch (error) {
        console.error('[TravelAgency] Failed to sync sales:', error)
        await queueOfflineUpserts(entities, workspaceId)
    }
}

async function syncSoftDelete(entityId: string, workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline(workspaceId)) {
        await addToOfflineMutations(TABLE_NAME, entityId, 'delete', { id: entityId }, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(TABLE_NAME)
        const { error } = await runMutation(`${TABLE_NAME}.delete`, () =>
            client
                .from(TABLE_NAME)
                .update({ is_deleted: true, updated_at: new Date().toISOString() })
                .eq('id', entityId)
        )
        if (error) {
            throw error
        }

        await markEntitiesSynced([entityId])
    } catch (error) {
        console.error('[TravelAgency] Failed to delete sale:', error)
        await addToOfflineMutations(TABLE_NAME, entityId, 'delete', { id: entityId }, workspaceId)
    }
}

function buildBaseEntity<T extends Record<string, unknown>>(workspaceId: string, data: T): T & BaseEntityPayload {
    const now = new Date().toISOString()

    return {
        ...data,
        id: generateId(),
        workspaceId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }
}

async function generateSaleNumber(workspaceId: string, saleDate: string) {
    const year = (saleDate || new Date().toISOString().slice(0, 10)).slice(0, 4)
    const rows = await db.travel_agency_sales.where('workspaceId').equals(workspaceId).toArray()
    const sequence = rows.filter((row) => row.saleDate.startsWith(`${year}-`)).length + 1
    return `TA-${year}-${String(sequence).padStart(5, '0')}`
}

export function useTravelAgencySales(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const sales = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.travel_agency_sales.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
            return rows.sort((left, right) => {
                const dateDiff = right.saleDate.localeCompare(left.saleDate)
                if (dateDiff !== 0) {
                    return dateDiff
                }

                // Use saleNumber as a stable tie-breaker to prevent rows from moving on update
                return right.saleNumber.localeCompare(left.saleNumber)
            })
        },
        [workspaceId]
    )

    useEffect(() => {
        if (online && workspaceId && shouldUseCloudBusinessData(workspaceId)) {
            fetchTableFromSupabase(TABLE_NAME, db.travel_agency_sales, workspaceId)
        }
    }, [online, workspaceId])

    return sales ?? []
}

export function useTravelAgencySale(saleId: string | undefined) {
    return useLiveQuery(() => saleId ? db.travel_agency_sales.get(saleId) : undefined, [saleId])
}

function computeSnapshots(data: { groupRevenue: number; supplierCost: number; tourists: Array<{ revenue: number }> }) {
    const revenue = data.groupRevenue + data.tourists.reduce((sum, t) => sum + t.revenue, 0)
    const cost = data.supplierCost
    return { snapshotRevenue: revenue, snapshotCost: cost, snapshotProfit: revenue - cost }
}

export async function createTravelAgencySale(
    workspaceId: string,
    data: Omit<TravelAgencySale, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'saleNumber'>
) {
    const saleNumber = await generateSaleNumber(workspaceId, data.saleDate)
    const snapshots = computeSnapshots(data)
    const sale = buildBaseEntity(workspaceId, {
        ...data,
        ...snapshots,
        saleNumber
    }) as TravelAgencySale

    await db.travel_agency_sales.put(sale)
    await syncUpsertEntities([sale as unknown as Record<string, unknown> & { id: string; version: number }], workspaceId)
    return sale
}

export async function updateTravelAgencySale(id: string, data: Partial<TravelAgencySale>) {
    const existing = await db.travel_agency_sales.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Travel agency sale not found')
    }

    const now = new Date().toISOString()
    const nextIsPaid = data.isPaid ?? existing.isPaid
    const merged = { ...existing, ...data }
    const snapshots = computeSnapshots({
        groupRevenue: merged.groupRevenue,
        supplierCost: merged.supplierCost,
        tourists: merged.tourists
    })
    const updated: TravelAgencySale = {
        ...merged,
        ...snapshots,
        paidAt: nextIsPaid
            ? (data.paidAt ?? existing.paidAt ?? now)
            : null,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.travel_agency_sales.put(updated)
    await syncUpsertEntities([updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)
    return updated
}

export async function setTravelAgencySalePaymentStatus(
    id: string,
    input: {
        isPaid: boolean
        paidAt?: string | null
    }
) {
    const existing = await db.travel_agency_sales.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Travel agency sale not found')
    }

    const now = new Date().toISOString()
    const updated: TravelAgencySale = {
        ...existing,
        isPaid: input.isPaid,
        paidAt: input.isPaid ? (input.paidAt ?? now) : null,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.travel_agency_sales.put(updated)
    await syncUpsertEntities([updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)
    return updated
}

export async function setTravelAgencySaleStatus(
    id: string,
    status: TravelAgencySale['status']
) {
    const existing = await db.travel_agency_sales.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Travel agency sale not found')
    }

    const now = new Date().toISOString()
    const updated: TravelAgencySale = {
        ...existing,
        status,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.travel_agency_sales.put(updated)
    await syncUpsertEntities([updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)
    return updated
}

export async function deleteTravelAgencySale(id: string) {
    const existing = await db.travel_agency_sales.get(id)
    if (!existing || existing.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    await db.travel_agency_sales.put({
        ...existing,
        isDeleted: true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    })
    await syncSoftDelete(id, existing.workspaceId)
}

export async function lockTravelSale(id: string) {
    const existing = await db.travel_agency_sales.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Sale not found')
    }
    if (existing.isLocked) {
        throw new Error('Sale is already locked')
    }
    if (existing.status !== 'completed' || !existing.isPaid) {
        throw new Error('Sale must be completed and paid to be locked')
    }

    const now = new Date().toISOString()
    const updated: TravelAgencySale = {
        ...existing,
        isLocked: true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.travel_agency_sales.put(updated)
    await syncUpsertEntities([updated as unknown as Record<string, unknown> & { id: string; version: number }], existing.workspaceId)
    return updated
}
