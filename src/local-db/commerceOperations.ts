import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isOnline } from '@/lib/network'
import { generateId, toSnakeCase } from '@/lib/utils'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import type { CommerceOperationRecord, CommerceOperationRecordType } from './models'
import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'

export const COMMERCE_OPERATIONS_TABLE = 'commerce_operations_records' as const

function makeRecord(
  workspaceId: string,
  input: Pick<CommerceOperationRecord, 'recordType' | 'recordDate' | 'title' | 'payload'>
    & Partial<Pick<CommerceOperationRecord, 'relatedOrderId' | 'relatedPartnerId' | 'createdBy'>>,
): CommerceOperationRecord {
  const now = new Date().toISOString()
  const localOnly = isLocalWorkspaceMode(workspaceId)
  return {
    id: generateId(),
    workspaceId,
    ...input,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    syncStatus: localOnly ? 'synced' : 'pending',
    lastSyncedAt: localOnly ? now : null,
  }
}

async function persistRecord(record: CommerceOperationRecord, operation: 'create' | 'update') {
  if (isLocalWorkspaceMode(record.workspaceId)) {
    await db.commerce_operations_records.put(record)
    return record
  }

  const client = getSupabaseClientForTable(COMMERCE_OPERATIONS_TABLE)
  if (isOnline(record.workspaceId)) {
    const payload = toSnakeCase({ ...record, syncStatus: undefined, lastSyncedAt: undefined })
    const { error } = await runSupabaseAction(`${COMMERCE_OPERATIONS_TABLE}.${operation}`, () =>
      client.from(COMMERCE_OPERATIONS_TABLE).upsert(payload),
    )
    if (error) throw error
    const synced = { ...record, syncStatus: 'synced' as const, lastSyncedAt: new Date().toISOString() }
    await db.commerce_operations_records.put(synced)
    return synced
  }

  await db.commerce_operations_records.put(record)
  await addToOfflineMutations(
    COMMERCE_OPERATIONS_TABLE,
    record.id,
    operation,
    record as unknown as Record<string, unknown>,
    record.workspaceId,
  )
  return record
}

export async function createCommerceOperationRecord(
  workspaceId: string,
  input: Pick<CommerceOperationRecord, 'recordType' | 'recordDate' | 'title' | 'payload'>
    & Partial<Pick<CommerceOperationRecord, 'relatedOrderId' | 'relatedPartnerId' | 'createdBy'>>,
) {
  return persistRecord(makeRecord(workspaceId, input), 'create')
}

export async function updateCommerceOperationRecord(
  workspaceId: string,
  id: string,
  changes: Partial<Pick<CommerceOperationRecord, 'recordDate' | 'title' | 'payload' | 'relatedOrderId' | 'relatedPartnerId' | 'isDeleted'>>,
) {
  const existing = await db.commerce_operations_records.get(id)
  if (!existing || existing.workspaceId !== workspaceId || existing.isDeleted) {
    throw new Error('Commerce record not found')
  }
  const now = new Date().toISOString()
  const localOnly = isLocalWorkspaceMode(workspaceId)
  const updated: CommerceOperationRecord = {
    ...existing,
    ...changes,
    updatedAt: now,
    version: existing.version + 1,
    syncStatus: localOnly ? 'synced' : 'pending',
    lastSyncedAt: localOnly ? now : existing.lastSyncedAt,
  }
  return persistRecord(updated, 'update')
}

export async function refreshCommerceOperationRecords(workspaceId: string, force = false) {
  if (isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) return true
  return fetchTableFromSupabase(COMMERCE_OPERATIONS_TABLE, db.commerce_operations_records, workspaceId, { force })
}

export type CommerceRecordKind = CommerceOperationRecordType

