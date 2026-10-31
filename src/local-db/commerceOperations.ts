import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isOnline } from '@/lib/network'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import type { CommerceOperationRecord, CommerceOperationRecordType } from './models'
import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'

export const COMMERCE_OPERATIONS_TABLE = 'commerce_operations_records' as const

export type CommerceOrderAttribution = {
  channel: string | null
  platform: string | null
  agentId: string | null
  agentName: string | null
}

function isCommerceOrderDetail(record: CommerceOperationRecord) {
  return record.recordType === 'order_details' && !record.isDeleted
}

function latestCommerceOrderDetails(records: CommerceOperationRecord[]) {
  return records
    .filter(isCommerceOrderDetail)
    .sort((left, right) => (right.updatedAt || right.recordDate).localeCompare(left.updatedAt || left.recordDate))[0]
}

function toCommerceOrderAttribution(record?: CommerceOperationRecord | null): CommerceOrderAttribution | null {
  if (!record) return null
  const payload = record.payload || {}
  const value = (key: string) => typeof payload[key] === 'string' && payload[key].trim()
    ? (payload[key] as string).trim()
    : null
  const channel = value('channel')
  const platform = channel === 'wholesale' ? null : value('platform')
  const agentId = value('agentId')
  const agentName = value('agentNameSnapshot')
  if (!platform && !agentId && !agentName) return null
  return { channel, platform, agentId, agentName }
}

function mapCommerceOrderAttributions(records: CommerceOperationRecord[]) {
  const latestByOrderId = new Map<string, CommerceOperationRecord>()
  for (const record of records) {
    if (!record.relatedOrderId || !isCommerceOrderDetail(record)) continue
    const current = latestByOrderId.get(record.relatedOrderId)
    if (!current || (record.updatedAt || record.recordDate).localeCompare(current.updatedAt || current.recordDate) > 0) {
      latestByOrderId.set(record.relatedOrderId, record)
    }
  }
  const result: Record<string, CommerceOrderAttribution> = {}
  for (const [orderId, record] of latestByOrderId) {
    const attribution = toCommerceOrderAttribution(record)
    if (attribution) result[orderId] = attribution
  }
  return result
}

async function readCommerceOrderDetailsFromCache(workspaceId: string, orderIds: readonly string[]) {
  if (orderIds.length === 0) return []
  const keys = [...new Set(orderIds)].map((orderId) => [workspaceId, orderId])
  return db.commerce_operations_records
    .where('[workspaceId+relatedOrderId]')
    .anyOf(keys)
    .and(isCommerceOrderDetail)
    .toArray()
}

/** Load Coach/platform attribution only for the sales orders on the current page. */
export async function fetchCommerceOrderAttributions(
  workspaceId: string,
  orderIds: readonly string[],
  options: { signal?: AbortSignal; online?: boolean } = {},
) {
  const distinctOrderIds = [...new Set(orderIds.filter(Boolean))]
  if (distinctOrderIds.length === 0) return {} as Record<string, CommerceOrderAttribution>

  const cachedRecords = await readCommerceOrderDetailsFromCache(workspaceId, distinctOrderIds)
  const cachedById = new Map(cachedRecords.map((record) => [record.id, record]))
  if (isLocalWorkspaceMode(workspaceId) || options.online === false || !isOnline(workspaceId)) {
    return mapCommerceOrderAttributions(cachedRecords)
  }

  const request = getSupabaseClientForTable(COMMERCE_OPERATIONS_TABLE)
    .from(COMMERCE_OPERATIONS_TABLE)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('record_type', 'order_details')
    .eq('is_deleted', false)
    .in('related_order_id', distinctOrderIds)
    .order('updated_at', { ascending: false })
  const { data, error } = await runSupabaseAction(`${COMMERCE_OPERATIONS_TABLE}.orderAttribution`, () => (
    options.signal ? request.abortSignal(options.signal) : request
  )) as { data?: Array<Record<string, unknown>> | null; error?: unknown }
  if (error || !Array.isArray(data)) return mapCommerceOrderAttributions(cachedRecords)

  const fetchedAt = new Date().toISOString()
  const remoteRecords = data.map((row) => ({
    ...(toCamelCase(row) as unknown as CommerceOperationRecord),
    syncStatus: 'synced' as const,
    lastSyncedAt: fetchedAt,
  }))
  const currentRemoteRows = await db.commerce_operations_records.bulkGet(remoteRecords.map((record) => record.id))
  const rowsToCache = remoteRecords.filter((record, index) => {
    const existing = currentRemoteRows[index]
    if (!existing || existing.syncStatus === 'pending' || existing.syncStatus === 'conflict') return !existing
    const existingUpdatedAt = Date.parse(existing.updatedAt || '')
    const remoteUpdatedAt = Date.parse(record.updatedAt || '')
    return !Number.isFinite(existingUpdatedAt) || !Number.isFinite(remoteUpdatedAt) || remoteUpdatedAt >= existingUpdatedAt
  })
  if (rowsToCache.length > 0) await db.commerce_operations_records.bulkPut(rowsToCache)

  const preferredRecords = remoteRecords.map((record, index) => {
    const existing = currentRemoteRows[index]
    if (existing && (existing.syncStatus === 'pending' || existing.syncStatus === 'conflict')) return existing
    return record
  })
  const mergedById = new Map([...cachedById, ...preferredRecords.map((record) => [record.id, record] as const)])
  return mapCommerceOrderAttributions([...mergedById.values()])
}

/** Search indexed local order-detail records for matching platform or agent snapshots. */
export async function findCommerceOrderIdsMatchingSearch(workspaceId: string, search: string) {
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const orderIds = new Set<string>()
  if (!normalizedSearch) return orderIds

  await db.commerce_operations_records
    .where('[workspaceId+recordType]')
    .equals([workspaceId, 'order_details'])
    .and((record) => !record.isDeleted)
    .each((record) => {
      if (!record.relatedOrderId) return
      const attribution = toCommerceOrderAttribution(record)
      if (attribution && (
        attribution.agentName?.toLocaleLowerCase().includes(normalizedSearch)
        || attribution.platform?.toLocaleLowerCase().includes(normalizedSearch)
        || attribution.channel?.toLocaleLowerCase().includes(normalizedSearch)
      )) orderIds.add(record.relatedOrderId)
    })

  return orderIds
}

/** Reactive detail lookup with a targeted remote refresh when Commerce Operations is available. */
export function useCommerceOrderAttribution(workspaceId: string | undefined, orderId: string | undefined, enabled: boolean) {
  const online = useNetworkStatus()
  const record = useLiveQuery(async () => {
    if (!enabled || !workspaceId || !orderId) return null
    const records = await db.commerce_operations_records
      .where('[workspaceId+relatedOrderId]')
      .equals([workspaceId, orderId])
      .and(isCommerceOrderDetail)
      .toArray()
    return latestCommerceOrderDetails(records) ?? null
  }, [enabled, workspaceId, orderId], null)

  useEffect(() => {
    if (!enabled || !workspaceId || !orderId || !online || isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) return
    const controller = new AbortController()
    void fetchCommerceOrderAttributions(workspaceId, [orderId], { signal: controller.signal, online })
      .catch(() => undefined)
    return () => controller.abort()
  }, [enabled, online, orderId, workspaceId])

  return toCommerceOrderAttribution(record)
}

/** Finds sales orders explicitly attributed to an agent by Commerce Operations. */
export function useCommerceAttributedSalesOrderIds(
  workspaceId: string | undefined,
  agentId: string | undefined,
  enabled: boolean,
) {
  const online = useNetworkStatus()
  const requestKey = `${workspaceId ?? ''}:${agentId ?? ''}:${enabled ? 'enabled' : 'disabled'}`
  const localOrderIds = useLiveQuery(async () => {
    if (!enabled || !workspaceId || !agentId) return []
    const matchingOrderIds = new Set<string>()
    await db.commerce_operations_records
      .where('[workspaceId+recordType]')
      .equals([workspaceId, 'order_details'])
      .and((record) => !record.isDeleted && record.payload.agentId === agentId)
      .each((record) => {
        if (record.relatedOrderId) matchingOrderIds.add(record.relatedOrderId)
      })
    return [...matchingOrderIds]
  }, [agentId, enabled, workspaceId], [])
  const [remoteOrderIds, setRemoteOrderIds] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] })

  useEffect(() => {
    if (!enabled || !workspaceId || !agentId || !online || isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) {
      setRemoteOrderIds({ key: requestKey, ids: [] })
      return
    }

    const controller = new AbortController()
    const request = getSupabaseClientForTable(COMMERCE_OPERATIONS_TABLE)
      .from(COMMERCE_OPERATIONS_TABLE)
      .select('related_order_id')
      .eq('workspace_id', workspaceId)
      .eq('record_type', 'order_details')
      .eq('is_deleted', false)
      .eq('payload->>agentId', agentId)
    void runSupabaseAction(`${COMMERCE_OPERATIONS_TABLE}.agentSalesOrderIds`, () => (
      request.abortSignal(controller.signal)
    )).then(({ data, error }) => {
      if (controller.signal.aborted) return
      if (error || !Array.isArray(data)) {
        setRemoteOrderIds({ key: requestKey, ids: [] })
        return
      }
      const ids = [...new Set(data.flatMap((row) => (
        typeof row.related_order_id === 'string' && row.related_order_id
          ? [row.related_order_id]
          : []
      )))]
      setRemoteOrderIds({ key: requestKey, ids })
    }).catch(() => {
      if (!controller.signal.aborted) setRemoteOrderIds({ key: requestKey, ids: [] })
    })

    return () => controller.abort()
  }, [agentId, enabled, online, requestKey, workspaceId])

  const currentRemoteOrderIds = remoteOrderIds.key === requestKey ? remoteOrderIds.ids : []
  return useMemo(
    () => new Set([...localOrderIds, ...currentRemoteOrderIds]),
    [currentRemoteOrderIds, localOrderIds],
  )
}

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

