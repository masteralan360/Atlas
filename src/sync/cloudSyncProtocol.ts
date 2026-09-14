import { supabase } from '@/auth/supabase'
import {
  acknowledgeCloudSyncMutation,
  applyCloudSyncPullPage,
  canonicalJson,
  durableMutationToOfflineMutation,
  finalizeCloudSyncSnapshot,
  getRetryAt,
  leaseCloudSyncOutbox,
  readCloudSyncCursor,
  rebuildDexieOutboxProjection,
  stageCloudSyncSnapshotPage,
  transitionCloudSyncMutation,
  type CloudSyncPullChange,
  type CloudSyncReplicaProjectionRow,
  type CloudSyncSnapshotRow,
  type DurableOutboxMutation,
} from '@/local-db/cloudSyncOutbox'
import { db } from '@/local-db/database'
import { projectDexieFromSqlite } from '@/local-db/localModeSqlite'
import type { OfflineMutationEntityType } from '@/local-db/models'
import { setWorkspaceSyncProtocolVersion } from '@/lib/network'
import { toCamelCase } from '@/lib/utils'

import { SYNC_REGISTRY } from './syncRegistry'

const PROTOCOL_PULL_PAGE_SIZE = 500
const OUTBOX_LEASE_SIZE = 64
const OUTBOX_LEASE_MS = 60_000
const PROTOCOL_V1_SNAPSHOT_ENTITY_TYPES = [
  'categories',
  'category_discounts',
  'price_book_items',
  'price_books',
  'product_barcodes',
  'product_discounts',
  'reorder_transfer_rules',
  'units',
] as const satisfies readonly OfflineMutationEntityType[]

type ProtocolError = {
  code?: string
  message?: string
  retryable?: boolean
}

type ApplyMutationResponse = {
  status?: 'acknowledged' | 'conflict' | 'rejected'
  mutation_id?: string
  server_version?: number | null
  change_seq?: number | null
  result?: { entity?: Record<string, unknown> | null } | null
  error?: ProtocolError | null
}

type PullChangesResponse = {
  status?: 'ok' | 'snapshot_required'
  snapshot_required?: boolean
  protocol_version?: number
  watermark?: number
  snapshot_watermark?: number
  next_cursor?: number
  has_more?: boolean
  changes?: Array<{
    change_seq?: number
    entity_type?: string
    entity_id?: string
    operation?: 'upsert' | 'delete'
    entity_version?: number | null
    payload?: Record<string, unknown> | null
    changed_at?: string
    mutation_id?: string | null
  }>
  error?: ProtocolError | null
}

type SnapshotResponse = {
  status?: 'ok' | 'rejected'
  protocol_version?: number
  snapshot_watermark?: number
  next_entity_type?: string | null
  next_entity_id?: string | null
  has_more?: boolean
  entity_types?: string[]
  rows?: Array<{
    entity_type?: string
    entity_id?: string
    operation?: 'upsert' | 'delete'
    entity_version?: number | null
    payload?: Record<string, unknown> | null
    changed_at?: string
  }>
  error?: ProtocolError | null
}

export interface ProtocolPushResult {
  success: number
  failed: number
  errors: string[]
}

export interface ProtocolPullResult {
  pulled: number
  errors: string[]
  snapshotRequired: boolean
  snapshotWatermark: number | null
}

export interface ProtocolSnapshotResult {
  pulled: number
  errors: string[]
  snapshotWatermark: number | null
}

function isRegisteredEntityType(value: string): value is OfflineMutationEntityType {
  return Object.prototype.hasOwnProperty.call(SYNC_REGISTRY, value)
}

function normalizeApplyResponse(value: unknown): ApplyMutationResponse {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ApplyMutationResponse
    : {}
}

function normalizePullResponse(value: unknown): PullChangesResponse {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as PullChangesResponse
    : {}
}

function normalizeSnapshotResponse(value: unknown): SnapshotResponse {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SnapshotResponse
    : {}
}

function buildPullRequest(
  workspaceId: string,
  changeSeq: number,
  snapshotWatermark: number | null,
) {
  return {
    p_workspace_id: workspaceId,
    p_after_change_seq: changeSeq,
    p_limit: PROTOCOL_PULL_PAGE_SIZE,
    // Numeric zero is ambiguous: it may mean either a fresh SQLite database
    // or a completed baseline taken before the first server change. The
    // watermark is committed atomically with the snapshot and is the durable
    // proof that this replica has installed its baseline.
    p_has_baseline: snapshotWatermark !== null,
  }
}

async function updateDexieOutboxProjection(mutation: DurableOutboxMutation | null) {
  if (!mutation) return
  await db.offline_mutations.put(durableMutationToOfflineMutation(mutation))
}

async function updateDexieEntityAfterAck(
  mutation: DurableOutboxMutation,
  serverEntity: Record<string, unknown> | null | undefined,
) {
  const table = (db as unknown as Record<string, {
    get?: (key: string) => Promise<Record<string, unknown> | undefined>
    put?: (row: Record<string, unknown>) => Promise<unknown>
    update?: (key: string, changes: Record<string, unknown>) => Promise<unknown>
  }>)[mutation.entityType]
  if (!table) return

  await projectDexieFromSqlite(async () => {
    const syncedAt = new Date().toISOString()
    if (serverEntity && table.put) {
      const local = await table.get?.(mutation.entityId)
      await table.put({
        ...local,
        ...toCamelCase(serverEntity),
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
      })
      return
    }
    await table.update?.(mutation.entityId, {
      syncStatus: 'synced',
      lastSyncedAt: syncedAt,
    })
  })
}

function buildEnvelope(mutation: DurableOutboxMutation, actorId: string) {
  return {
    protocol_version: 1,
    mutation_id: mutation.mutationId,
    workspace_id: mutation.workspaceId,
    actor_id: actorId,
    mutation_type: mutation.mutationType,
    entity_type: mutation.entityType,
    entity_id: mutation.entityId,
    payload_schema_version: mutation.payloadSchemaVersion,
    payload_hash: mutation.payloadHash,
    payload_canonical: canonicalJson(mutation.payload),
    base_version: mutation.baseVersion,
    payload: mutation.payload,
  }
}

async function pushOneMutation(
  mutation: DurableOutboxMutation,
  actorId: string,
): Promise<{ acknowledged: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('atlas_apply_sync_mutation', {
      p_envelope: buildEnvelope(mutation, actorId),
    })
    if (error) throw error

    const response = normalizeApplyResponse(data)
    if (response.status === 'acknowledged') {
      const serverEntity = response.result?.entity ?? null
      const acknowledged = await acknowledgeCloudSyncMutation(mutation.mutationId, {
        serverVersion: response.server_version,
        changeSeq: response.change_seq,
        entity: serverEntity,
        workspaceId: mutation.workspaceId,
        userId: actorId,
      })
      await updateDexieOutboxProjection(acknowledged)
      await updateDexieEntityAfterAck(mutation, serverEntity)
      return { acknowledged: true }
    }

    const errorCode = response.error?.code ?? 'invalid_protocol_response'
    const errorMessage = response.error?.message ?? 'Cloud Sync rejected the mutation.'
    const state = response.status === 'conflict' ? 'conflict' : 'rejected'
    const updated = await transitionCloudSyncMutation(mutation.mutationId, state, {
      errorCode,
      errorMessage,
      workspaceId: mutation.workspaceId,
      userId: actorId,
    })
    await updateDexieOutboxProjection(updated)
    const table = (db as unknown as Record<string, {
      update?: (key: string, changes: Record<string, unknown>) => PromiseLike<unknown> | unknown
    }>)[mutation.entityType]
    await table?.update?.(mutation.entityId, { syncStatus: 'conflict' })
    return { acknowledged: false, error: errorMessage }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const updated = await transitionCloudSyncMutation(mutation.mutationId, 'retry_wait', {
      errorCode: 'transport_error',
      errorMessage: message,
      nextAttemptAt: getRetryAt(mutation.attemptCount),
      workspaceId: mutation.workspaceId,
      userId: actorId,
    })
    await updateDexieOutboxProjection(updated)
    return { acknowledged: false, error: message }
  }
}

export async function pushCloudSyncOutbox(
  actorId: string,
  workspaceId: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<ProtocolPushResult> {
  const leaseOwner = `${actorId}:${crypto.randomUUID()}`
  let success = 0
  let failed = 0
  const errors: string[] = []

  while (true) {
    const leased = await leaseCloudSyncOutbox(workspaceId, leaseOwner, {
      limit: OUTBOX_LEASE_SIZE,
      leaseMs: OUTBOX_LEASE_MS,
      userId: actorId,
    })
    if (leased.length === 0) break
    onProgress?.(success + failed, success + failed + leased.length)

    // The lease query returns at most one item for each aggregate/group. Those
    // independent streams can proceed concurrently without violating order.
    const results = await Promise.all(
      leased.map((mutation) => pushOneMutation(mutation, actorId)),
    )
    results.forEach((result) => {
      if (result.acknowledged) success += 1
      else {
        failed += 1
        if (result.error) errors.push(result.error)
      }
      onProgress?.(success + failed, success + failed + Math.max(0, leased.length - results.length))
    })

    // Transport errors enter retry_wait and should not spin in this run.
    if (results.some((result) => !result.acknowledged)) break
  }

  await rebuildDexieOutboxProjection(db, workspaceId, actorId)
  return { success, failed, errors }
}

function normalizePullChanges(response: PullChangesResponse): CloudSyncPullChange[] {
  const changes: CloudSyncPullChange[] = []
  for (const row of response.changes ?? []) {
    if (
      typeof row.change_seq !== 'number' ||
      typeof row.entity_type !== 'string' ||
      !isRegisteredEntityType(row.entity_type) ||
      typeof row.entity_id !== 'string' ||
      (row.operation !== 'upsert' && row.operation !== 'delete')
    ) {
      throw new Error('Cloud Sync returned an invalid change record.')
    }
    changes.push({
      changeSeq: row.change_seq,
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      entityVersion: typeof row.entity_version === 'number' ? row.entity_version : null,
      payload: row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? row.payload
        : null,
      changedAt: typeof row.changed_at === 'string' ? row.changed_at : new Date().toISOString(),
      mutationId: typeof row.mutation_id === 'string' ? row.mutation_id : null,
    })
  }
  return changes
}

async function projectPullChangesToDexie(changes: readonly CloudSyncPullChange[]) {
  await projectDexieFromSqlite(async () => {
    const syncedAt = new Date().toISOString()
    for (const change of changes) {
      const table = (db as unknown as Record<string, {
        put?: (row: Record<string, unknown>) => Promise<unknown>
        delete?: (key: string) => Promise<unknown>
      }>)[change.entityType]
      if (!table) continue
      if (change.operation === 'delete' || !change.payload) {
        await table.delete?.(change.entityId)
        continue
      }
      await table.put?.({
        ...toCamelCase(change.payload),
        id: change.entityId,
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
      })
    }
  })
}

async function projectCloudSyncSnapshotToDexie(
  workspaceId: string,
  entityTypes: readonly OfflineMutationEntityType[],
  projection: readonly CloudSyncReplicaProjectionRow[],
) {
  await projectDexieFromSqlite(async () => {
    for (const entityType of entityTypes) {
      const table = (db as unknown as Record<string, {
        where: (index: string) => {
          equals: (value: string) => { primaryKeys: () => Promise<unknown[]> }
        }
        bulkDelete: (keys: unknown[]) => Promise<unknown>
        bulkPut: (rows: Record<string, unknown>[]) => Promise<unknown>
      }>)[entityType]
      if (!table) throw new Error(`Cloud Sync has no Dexie projection for ${entityType}.`)

      const existingKeys = await table.where('workspaceId').equals(workspaceId).primaryKeys()
      const rows = projection
        .filter((row) => row.entityType === entityType)
        .map((row) => ({ ...row.payload, id: row.entityId, workspaceId }))
      await db.transaction('rw', table as never, async () => {
        if (existingKeys.length > 0) await table.bulkDelete(existingKeys)
        if (rows.length > 0) await table.bulkPut(rows)
      })
    }
  })
}

function normalizeSnapshotRows(response: SnapshotResponse): CloudSyncSnapshotRow[] {
  const rows: CloudSyncSnapshotRow[] = []
  for (const row of response.rows ?? []) {
    if (
      typeof row.entity_type !== 'string' ||
      !isRegisteredEntityType(row.entity_type) ||
      !PROTOCOL_V1_SNAPSHOT_ENTITY_TYPES.includes(
        row.entity_type as (typeof PROTOCOL_V1_SNAPSHOT_ENTITY_TYPES)[number],
      ) ||
      typeof row.entity_id !== 'string' ||
      (row.operation !== 'upsert' && row.operation !== 'delete') ||
      (row.operation === 'upsert' && (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)))
    ) {
      throw new Error('Cloud Sync returned an invalid snapshot row.')
    }
    rows.push({
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      entityVersion: typeof row.entity_version === 'number' ? row.entity_version : null,
      payload: row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? row.payload
        : null,
      changedAt: typeof row.changed_at === 'string' ? row.changed_at : new Date().toISOString(),
    })
  }
  return rows
}

/**
 * Rebuilds the durable replica exclusively through the protocol-v1 snapshot
 * gateway. Pages are staged first; SQLite and its cursor switch atomically only
 * after the final page, then Dexie is rebuilt as a disposable projection.
 */
export async function pullCloudSyncSnapshot(
  workspaceId: string,
  requestedWatermark: number | null,
  onProgress?: (completed: number, total: number) => void,
  userId?: string | null,
): Promise<ProtocolSnapshotResult> {
  let snapshotWatermark = requestedWatermark
  let afterEntityType: string | null = null
  let afterEntityId: string | null = null
  let entityTypes: OfflineMutationEntityType[] | null = null
  let pulled = 0
  let page = 0
  const errors: string[] = []

  try {
    while (true) {
      const { data, error } = await supabase.rpc('atlas_get_workspace_sync_snapshot', {
        p_workspace_id: workspaceId,
        p_snapshot_watermark: snapshotWatermark,
        p_after_entity_type: afterEntityType ?? '',
        p_after_entity_id: afterEntityId,
        p_limit: PROTOCOL_PULL_PAGE_SIZE,
      })
      if (error) throw error
      const response = normalizeSnapshotResponse(data)
      if (response.status !== 'ok') {
        throw new Error(response.error?.message ?? 'Cloud Sync returned an invalid snapshot response.')
      }
      if (typeof response.snapshot_watermark !== 'number') {
        throw new Error('Cloud Sync snapshot did not include a watermark.')
      }
      if (snapshotWatermark !== null && response.snapshot_watermark !== snapshotWatermark) {
        throw new Error('Cloud Sync snapshot watermark changed while paging.')
      }
      snapshotWatermark = response.snapshot_watermark

      const responseEntityTypes = Array.isArray(response.entity_types)
        ? response.entity_types
        : []
      const expected = [...PROTOCOL_V1_SNAPSHOT_ENTITY_TYPES]
      if (
        responseEntityTypes.length !== expected.length ||
        expected.some((entityType, index) => responseEntityTypes[index] !== entityType)
      ) {
        throw new Error('Cloud Sync snapshot entity contract does not match this client.')
      }
      entityTypes ??= responseEntityTypes as OfflineMutationEntityType[]

      const rows = normalizeSnapshotRows(response)
      await stageCloudSyncSnapshotPage(
        workspaceId,
        snapshotWatermark,
        rows,
        page === 0,
        userId,
      )
      pulled += rows.length
      onProgress?.(pulled, Math.max(pulled, pulled + (response.has_more ? 1 : 0)))

      if (!response.has_more) break
      const nextEntityType = response.next_entity_type
      const nextEntityId = response.next_entity_id
      if (
        typeof nextEntityType !== 'string' ||
        typeof nextEntityId !== 'string' ||
        (nextEntityType === afterEntityType && nextEntityId === afterEntityId) ||
        rows.length === 0
      ) {
        throw new Error('Cloud Sync snapshot pagination did not advance.')
      }
      afterEntityType = nextEntityType
      afterEntityId = nextEntityId
      page += 1
      if (page > 10_000) throw new Error('Cloud Sync snapshot exceeded the safe page limit.')
    }

    if (snapshotWatermark === null || !entityTypes) {
      throw new Error('Cloud Sync snapshot was incomplete.')
    }
    const projection = await finalizeCloudSyncSnapshot(
      workspaceId,
      snapshotWatermark,
      entityTypes,
      userId,
    )
    await projectCloudSyncSnapshotToDexie(workspaceId, entityTypes, projection)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  return { pulled, errors, snapshotWatermark }
}

export async function pullCloudSyncChanges(
  workspaceId: string,
  onProgress?: (completed: number, total: number) => void,
  userId?: string | null,
): Promise<ProtocolPullResult> {
  const cursorState = await readCloudSyncCursor(workspaceId, userId)
  let cursor = cursorState.changeSeq
  let snapshotWatermark = cursorState.snapshotWatermark
  let pulled = 0
  let page = 0
  const errors: string[] = []

  while (true) {
    const { data, error } = await supabase.rpc(
      'atlas_pull_workspace_changes',
      buildPullRequest(workspaceId, cursor, snapshotWatermark),
    )
    if (error) {
      errors.push(error.message)
      break
    }
    const response = normalizePullResponse(data)
    if (response.snapshot_required || response.status === 'snapshot_required') {
      return {
        pulled,
        errors,
        snapshotRequired: true,
        snapshotWatermark: typeof response.snapshot_watermark === 'number'
          ? response.snapshot_watermark
          : null,
      }
    }
    if (response.status !== 'ok') {
      errors.push(response.error?.message ?? 'Cloud Sync returned an invalid pull response.')
      break
    }

    const changes = normalizePullChanges(response)
    const nextCursor = typeof response.next_cursor === 'number'
      ? response.next_cursor
      : changes.at(-1)?.changeSeq ?? cursor
    // Page rows and its cursor commit atomically to SQLite. Dexie is updated
    // only after that durable transaction succeeds.
    const committed = await applyCloudSyncPullPage(
      workspaceId,
      changes,
      nextCursor,
      typeof response.watermark === 'number' ? response.watermark : null,
      userId,
    )
    await projectPullChangesToDexie(committed.applied)
    pulled += committed.applied.length
    cursor = nextCursor
    if (snapshotWatermark === null && typeof response.watermark === 'number') {
      // This branch is defensive for a future server that can bootstrap via a
      // complete change stream. Protocol v1 currently requires a snapshot and
      // therefore reaches here only with a pre-existing durable marker.
      snapshotWatermark = response.watermark
    }
    page += 1
    onProgress?.(pulled, Math.max(pulled, pulled + (response.has_more ? 1 : 0)))

    if (!response.has_more || changes.length === 0) break
    if (page > 10_000) {
      errors.push('Cloud Sync pull exceeded the safe page limit.')
      break
    }
  }

  return {
    pulled,
    errors,
    snapshotRequired: false,
    snapshotWatermark: null,
  }
}

export async function getWorkspaceSyncProtocolVersion(workspaceId: string) {
  const localWorkspace = await db.workspaces.get(workspaceId) as ({
    syncProtocolVersion?: number
    sync_protocol_version?: number
  } | undefined)
  const cached = localWorkspace?.syncProtocolVersion ?? localWorkspace?.sync_protocol_version
  if (typeof cached === 'number') {
    setWorkspaceSyncProtocolVersion(workspaceId, cached)
    return cached
  }

  const { data, error } = await supabase
    .from('workspaces')
    .select('sync_protocol_version')
    .eq('id', workspaceId)
    .maybeSingle()
  if (error) throw error
  const value = data && typeof (data as { sync_protocol_version?: unknown }).sync_protocol_version === 'number'
    ? Number((data as { sync_protocol_version: number }).sync_protocol_version)
    : 0
  if (localWorkspace) {
    await db.workspaces.update(workspaceId, { syncProtocolVersion: value } as never)
  }
  setWorkspaceSyncProtocolVersion(workspaceId, value)
  return value
}

export const cloudSyncProtocolInternals = {
  buildEnvelope,
  buildPullRequest,
  normalizeApplyResponse,
  normalizePullResponse,
  normalizeSnapshotResponse,
  normalizeSnapshotRows,
  protocolV1SnapshotEntityTypes: PROTOCOL_V1_SNAPSHOT_ENTITY_TYPES,
}
