import { useEffect, useState } from 'react'
import type { Table } from 'dexie'

import { isSupabaseConfigured, supabase } from '@/auth/supabase'
import { isOnline } from '@/lib/network'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'
import type { ManualEntry, ManualEntryTemplate, ManualEntryTemplateRow } from './models'
import { abandonOfflineMutations, addToOfflineMutations } from './offlineMutations'

const PAGE_SIZE = 1000

type ManualEntryTableName = 'manual_entry_templates' | 'manual_entries'

/**
 * Manual entry is server-authoritative for cloud and hybrid workspaces:
 * reads are hydrated from Supabase and writes go straight to Supabase while
 * online, falling back to the offline-mutation queue only when offline.
 * Local and demo workspaces keep using the local store exclusively.
 */
function shouldUseCloudData(workspaceId?: string | null) {
    return Boolean(workspaceId) && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    if (!shouldUseCloudData(workspaceId)) {
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

function toRemotePayload(entity: ManualEntryTemplate | ManualEntry) {
    return toSnakeCase({
        ...entity,
        syncStatus: undefined,
        lastSyncedAt: undefined
    } as unknown as Record<string, unknown>)
}

async function retireQueuedManualEntryMutations(
    entityType: 'manual_entry_templates' | 'manual_entries',
    entityId: string,
    throughTimestamp: string
) {
    const mutations = await db.offline_mutations
        .filter((mutation) => (
            mutation.entityType === entityType
            && mutation.entityId === entityId
            && (mutation.status === 'pending' || mutation.status === 'failed')
            && mutation.createdAt <= throughTimestamp
        ))
        .toArray()
    await abandonOfflineMutations(
        mutations,
        'Superseded by a successful direct remote write.',
    )
}

async function fetchRemoteRows(
    tableName: ManualEntryTableName,
    workspaceId: string
): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []

    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .eq('workspace_id', workspaceId)
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1)

        if (error) {
            throw normalizeSupabaseActionError(error)
        }

        const page = (data ?? []) as Record<string, unknown>[]
        rows.push(...page)
        if (page.length < PAGE_SIZE) {
            break
        }
    }

    return rows
}

async function hydrateTable(
    tableName: ManualEntryTableName,
    workspaceId: string
) {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return
    }

    const table: Table<any, string> = tableName === 'manual_entry_templates'
        ? db.manual_entry_templates
        : db.manual_entries

    const remoteRows = await fetchRemoteRows(tableName, workspaceId)

    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return
    }

    const syncedAt = new Date().toISOString()
    const remoteItems: Array<Record<string, unknown>> = remoteRows.map((row) => ({
        ...(toCamelCase(row) as Record<string, unknown>),
        syncStatus: 'synced' as const,
        lastSyncedAt: syncedAt
    }))

    const localItems = await table
        .where('workspaceId')
        .equals(workspaceId)
        .toArray()
    const pendingIds = new Set(
        localItems.filter((row) => row.syncStatus === 'pending').map((row) => row.id)
    )
    const applicableRemoteItems = remoteItems.filter((row) => !pendingIds.has(row.id))
    const remoteIds = new Set(remoteItems.map((row) => row.id))
    const deletedIds = localItems
        .filter((row) => row.syncStatus !== 'pending' && !remoteIds.has(row.id))
        .map((row) => row.id)

    await db.transaction('rw', table, async () => {
        if (deletedIds.length > 0) {
            await table.bulkDelete(deletedIds)
        }
        if (applicableRemoteItems.length > 0) {
            await table.bulkPut(applicableRemoteItems)
        }
    })
}

export async function hydrateManualEntryTables(workspaceId: string) {
    if (!workspaceId || !isSupabaseConfigured || !isOnline()
        || !await canReconcileCloudWorkspaceData(workspaceId)) {
        return
    }

    await Promise.all([
        hydrateTable('manual_entry_templates', workspaceId),
        hydrateTable('manual_entries', workspaceId)
    ])
}

export function useManualEntryCloudData(workspaceId?: string | null) {
    const [isReady, setIsReady] = useState(!shouldUseCloudData(workspaceId))

    useEffect(() => {
        if (!workspaceId || !shouldUseCloudData(workspaceId)) {
            setIsReady(true)
            return
        }

        let cancelled = false
        setIsReady(false)
        hydrateManualEntryTables(workspaceId)
            .catch((error) => {
                console.error('[ManualEntry] Failed to hydrate from Supabase:', error)
            })
            .finally(() => {
                if (!cancelled) {
                    setIsReady(true)
                }
            })

        return () => {
            cancelled = true
        }
    }, [workspaceId])

    return isReady
}

export interface ManualEntryTemplateInput {
    name: string
    headerName?: string
    headerPhone1?: string
    headerPhone2?: string
    detailsLabel1?: string
    detailsLabel2?: string
    detailsLabel3?: string
    rows: ManualEntryTemplateRow[]
    createdBy?: string | null
}

export async function createManualEntryTemplate(
    workspaceId: string,
    input: ManualEntryTemplateInput
): Promise<ManualEntryTemplate> {
    const now = new Date().toISOString()
    const template: ManualEntryTemplate = {
        id: generateId(),
        workspaceId,
        name: input.name,
        headerName: input.headerName || undefined,
        headerPhone1: input.headerPhone1 || undefined,
        headerPhone2: input.headerPhone2 || undefined,
        detailsLabel1: input.detailsLabel1 || undefined,
        detailsLabel2: input.detailsLabel2 || undefined,
        detailsLabel3: input.detailsLabel3 || undefined,
        rows: input.rows,
        status: 'active',
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    if (shouldUseCloudData(workspaceId) && isOnline(workspaceId)) {
        const { error } = await runSupabaseAction(
            'manualEntryTemplates.create',
            () => supabase.from('manual_entry_templates').upsert(toRemotePayload(template))
        )
        if (error) {
            throw normalizeSupabaseActionError(error)
        }
        await retireQueuedManualEntryMutations('manual_entry_templates', template.id, now)
        await db.manual_entry_templates.put({
            ...template,
            syncStatus: 'synced',
            lastSyncedAt: new Date().toISOString()
        })
    } else {
        await db.manual_entry_templates.add(template)
        if (shouldUseCloudData(workspaceId)) {
            await addToOfflineMutations(
                'manual_entry_templates',
                template.id,
                'create',
                template as unknown as Record<string, unknown>,
                workspaceId
            )
        }
    }

    return template
}

export async function updateManualEntryTemplate(
    id: string,
    input: Omit<ManualEntryTemplateInput, 'createdBy'>
): Promise<void> {
    const existing = await db.manual_entry_templates.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Template not found')
    }

    const now = new Date().toISOString()
    let updated: ManualEntryTemplate = {
        ...existing,
        name: input.name,
        headerName: input.headerName || undefined,
        headerPhone1: input.headerPhone1 || undefined,
        headerPhone2: input.headerPhone2 || undefined,
        detailsLabel1: input.detailsLabel1 || undefined,
        detailsLabel2: input.detailsLabel2 || undefined,
        detailsLabel3: input.detailsLabel3 || undefined,
        rows: input.rows,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }
    let wroteToCloud = false

    if (shouldUseCloudData(existing.workspaceId) && isOnline(existing.workspaceId)) {
        const { data: remoteData, error } = await runSupabaseAction(
            'manualEntryTemplates.update',
            () => supabase
                .from('manual_entry_templates')
                .upsert(toRemotePayload(updated))
                .select('*')
                .single()
        )
        if (error) {
            throw normalizeSupabaseActionError(error)
        }
        if (remoteData) {
            updated = {
                ...(toCamelCase(remoteData as Record<string, unknown>) as unknown as ManualEntryTemplate),
                syncStatus: 'synced',
                lastSyncedAt: new Date().toISOString()
            }
        }
        wroteToCloud = true
    }

    await db.manual_entry_templates.put(updated)
    if (wroteToCloud) {
        await retireQueuedManualEntryMutations('manual_entry_templates', id, now)
    }
    if (!wroteToCloud && shouldUseCloudData(existing.workspaceId)) {
        await addToOfflineMutations(
            'manual_entry_templates',
            id,
            'update',
            updated as unknown as Record<string, unknown>,
            existing.workspaceId
        )
    }
}

export async function deleteManualEntryTemplate(id: string): Promise<void> {
    const existing = await db.manual_entry_templates.get(id)
    if (!existing || existing.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    const updated: ManualEntryTemplate = {
        ...existing,
        isDeleted: true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    if (shouldUseCloudData(existing.workspaceId) && isOnline(existing.workspaceId)) {
        const { error } = await runSupabaseAction(
            'manualEntryTemplates.delete',
            () => supabase
                .from('manual_entry_templates')
                .update({ is_deleted: true, updated_at: now })
                .eq('id', id)
        )
        if (error) {
            throw normalizeSupabaseActionError(error)
        }
        await retireQueuedManualEntryMutations('manual_entry_templates', id, now)
        await db.manual_entry_templates.put({
            ...updated,
            syncStatus: 'synced',
            lastSyncedAt: new Date().toISOString()
        })
    } else {
        await db.manual_entry_templates.put(updated)
        if (shouldUseCloudData(existing.workspaceId)) {
            await addToOfflineMutations(
                'manual_entry_templates',
                id,
                'delete',
                { id },
                existing.workspaceId
            )
        }
    }
}

export interface ManualEntryInput {
    workspaceId: string
    templateId: string
    templateName: string
    rows: ManualEntryTemplateRow[]
    data: Record<string, string[]>
    detailValues: Record<string, string>
}

export async function saveManualEntry(input: ManualEntryInput): Promise<string> {
    const now = new Date().toISOString()
    const id = generateId()
    const entry: ManualEntry = {
        id,
        workspaceId: input.workspaceId,
        templateId: input.templateId,
        templateName: input.templateName,
        rows: input.rows,
        data: input.data,
        detailValues: input.detailValues,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(input.workspaceId, now)
    }

    if (shouldUseCloudData(input.workspaceId) && isOnline(input.workspaceId)) {
        const { error } = await runSupabaseAction(
            'manualEntries.create',
            () => supabase.from('manual_entries').insert(toRemotePayload(entry))
        )
        if (error) {
            throw normalizeSupabaseActionError(error)
        }
        await retireQueuedManualEntryMutations('manual_entries', id, now)
        await db.manual_entries.put({
            ...entry,
            syncStatus: 'synced',
            lastSyncedAt: new Date().toISOString()
        })
    } else {
        await db.manual_entries.add(entry)
        if (shouldUseCloudData(input.workspaceId)) {
            await addToOfflineMutations(
                'manual_entries',
                id,
                'create',
                entry as unknown as Record<string, unknown>,
                input.workspaceId
            )
        }
    }

    return id
}
