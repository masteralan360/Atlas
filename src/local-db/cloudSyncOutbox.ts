import type Dexie from 'dexie'

import { getActiveBusinessUserId } from '@/lib/network'
import { toCamelCase } from '@/lib/utils'
import { prepareRemoteMutationPayload } from '@/sync/syncPayloadContract'
import { getSyncRegistration } from '@/sync/syncRegistry'

import type {
  MutationStatus,
  OfflineMutation,
  OfflineMutationEntityType,
} from './models'
import {
  getLocalModeSqliteConnection,
  runLocalModeSqliteTransaction,
  type LocalModeSqliteScope,
  type SqliteConnection,
} from './localModeSqlite'

export const CLOUD_SYNC_PROTOCOL_VERSION = 1
export const CLOUD_SYNC_OUTBOX_RETENTION_DAYS = 30
export const CLOUD_SYNC_CHANGE_RETENTION_DAYS = 180

export type DurableMutationState =
  | 'pending'
  | 'leased'
  | 'retry_wait'
  | 'blocked'
  | 'conflict'
  | 'rejected'
  | 'acknowledged'
  | 'abandoned'

export interface DurableOutboxMutation {
  mutationId: string
  localSequence: number
  workspaceId: string
  actorId: string | null
  entityType: OfflineMutationEntityType
  entityId: string
  operation: OfflineMutation['operation']
  mutationKind: 'entity' | 'command'
  mutationType: string
  aggregateKey: string
  groupId: string | null
  dependencies: string[]
  payloadSchemaVersion: number
  payloadHash: string
  payload: Record<string, unknown>
  baseVersion: number | null
  state: DurableMutationState
  attemptCount: number
  leaseOwner: string | null
  leaseExpiresAt: string | null
  nextAttemptAt: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  acknowledgedAt: string | null
}

interface DurableOutboxRow {
  mutation_id: string
  local_sequence: number
  workspace_id: string
  actor_id: string | null
  entity_type: OfflineMutationEntityType
  entity_id: string
  operation: OfflineMutation['operation']
  mutation_kind: 'entity' | 'command'
  mutation_type: string
  aggregate_key: string
  group_id: string | null
  dependencies_json: string
  payload_schema_version: number
  payload_hash: string
  payload_json: string
  base_version: number | null
  state: DurableMutationState
  attempt_count: number
  lease_owner: string | null
  lease_expires_at: string | null
  next_attempt_at: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  acknowledged_at: string | null
}

export interface EnqueueCloudSyncMutationInput {
  mutationId: string
  workspaceId: string
  entityType: OfflineMutationEntityType
  entityId: string
  operation: OfflineMutation['operation']
  payload: Record<string, unknown>
  actorId?: string | null
  aggregateKey?: string
  groupId?: string | null
  dependencies?: readonly string[]
  baseVersion?: number | null
  createdAt?: string
}

export interface EnqueueCloudSyncMutationResult {
  mutation: DurableOutboxMutation | null
  removedMutationIds: string[]
  ignoredDerived: boolean
}

export interface CloudSyncPullChange {
  changeSeq: number
  entityType: OfflineMutationEntityType
  entityId: string
  operation: 'upsert' | 'delete'
  entityVersion: number | null
  payload: Record<string, unknown> | null
  changedAt: string
  mutationId: string | null
}

export interface CloudSyncSnapshotRow {
  entityType: OfflineMutationEntityType
  entityId: string
  operation: 'upsert' | 'delete'
  entityVersion: number | null
  payload: Record<string, unknown> | null
  changedAt: string
}

export interface CloudSyncReplicaProjectionRow {
  entityType: OfflineMutationEntityType
  entityId: string
  payload: Record<string, unknown>
}

const initializedConnections = new WeakSet<object>()

function scopeForWorkspace(
  workspaceId: string,
  userId?: string | null,
): LocalModeSqliteScope {
  const resolvedUserId = userId ?? getActiveBusinessUserId()
  if (!resolvedUserId) {
    throw new Error('Cloud Sync requires an explicit authenticated user scope.')
  }
  return { workspaceId, userId: resolvedUserId }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isObject(value)) return value

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value))
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256CanonicalJson(value: unknown) {
  const input = new TextEncoder().encode(canonicalJson(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input)
  return bytesToHex(new Uint8Array(digest))
}

function parseJsonObject(value: string, label: string) {
  const parsed = JSON.parse(value) as unknown
  if (!isObject(parsed)) throw new Error(`${label} is not a JSON object.`)
  return parsed
}

function parseDependencies(value: string) {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

function toDurableMutation(row: DurableOutboxRow): DurableOutboxMutation {
  return {
    mutationId: row.mutation_id,
    localSequence: Number(row.local_sequence),
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    mutationKind: row.mutation_kind,
    mutationType: row.mutation_type,
    aggregateKey: row.aggregate_key,
    groupId: row.group_id,
    dependencies: parseDependencies(row.dependencies_json),
    payloadSchemaVersion: Number(row.payload_schema_version),
    payloadHash: row.payload_hash,
    payload: parseJsonObject(row.payload_json, 'Outbox payload'),
    baseVersion: row.base_version === null ? null : Number(row.base_version),
    state: row.state,
    attemptCount: Number(row.attempt_count),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at,
  }
}

function inferBaseVersion(
  operation: OfflineMutation['operation'],
  payload: Record<string, unknown>,
) {
  if (operation === 'create') return 0
  const explicitBaseVersion = payload.baseVersion ?? payload.base_version
  if (typeof explicitBaseVersion === 'number' && Number.isFinite(explicitBaseVersion)) {
    return Math.max(0, Math.trunc(explicitBaseVersion))
  }

  const version = payload.version
  if (typeof version !== 'number' || !Number.isFinite(version)) return null

  // Update payloads and already-materialized delete tombstones carry the next
  // local version. A delete payload representing the current live server row
  // carries the version it intends to compare-and-set without subtraction.
  const isMaterializedDelete = operation === 'delete'
    && (payload.isDeleted === true || payload.is_deleted === true)
  if (operation === 'delete' && !isMaterializedDelete) {
    return Math.max(0, Math.trunc(version))
  }
  return Math.max(0, Math.trunc(version) - 1)
}

function durableToDexieStatus(state: DurableMutationState): MutationStatus {
  if (state === 'leased') return 'leased'
  return state
}

export function durableMutationToOfflineMutation(
  mutation: DurableOutboxMutation,
): OfflineMutation {
  return {
    id: mutation.mutationId,
    workspaceId: mutation.workspaceId,
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    operation: mutation.operation,
    payload: mutation.payload,
    createdAt: mutation.createdAt,
    status: durableToDexieStatus(mutation.state),
    error: mutation.errorMessage ?? undefined,
    localSequence: mutation.localSequence,
    mutationKind: mutation.mutationKind,
    aggregateKey: mutation.aggregateKey,
    groupId: mutation.groupId,
    dependencies: mutation.dependencies,
    payloadSchemaVersion: mutation.payloadSchemaVersion,
    payloadHash: mutation.payloadHash,
    baseVersion: mutation.baseVersion,
    actorId: mutation.actorId,
    leaseOwner: mutation.leaseOwner,
    leaseExpiresAt: mutation.leaseExpiresAt,
    nextAttemptAt: mutation.nextAttemptAt,
    attemptCount: mutation.attemptCount,
    errorCode: mutation.errorCode,
    updatedAt: mutation.updatedAt,
    acknowledgedAt: mutation.acknowledgedAt,
  }
}

export async function ensureCloudSyncOutboxSchema(
  connection?: SqliteConnection,
  scope?: LocalModeSqliteScope,
) {
  const resolved = connection ?? await getLocalModeSqliteConnection(scope)
  if (!resolved) {
    throw new Error('Cloud Sync SQLite is unavailable; the mutation was not saved.')
  }
  if (initializedConnections.has(resolved as object)) return resolved

  await resolved.execute(`
    CREATE TABLE IF NOT EXISTS local_entities (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      workspace_id TEXT,
      current_workspace TEXT,
      payload TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (entity_type, entity_id)
    )
  `)
  await resolved.execute(`
    CREATE INDEX IF NOT EXISTS idx_local_entities_type_workspace
    ON local_entities (entity_type, workspace_id)
  `)
  await resolved.execute(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      mutation_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      actor_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
      mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('entity', 'command')),
      mutation_type TEXT NOT NULL,
      aggregate_key TEXT NOT NULL,
      group_id TEXT,
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      payload_schema_version INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      base_version INTEGER,
      state TEXT NOT NULL CHECK (state IN (
        'pending', 'leased', 'retry_wait', 'blocked', 'conflict',
        'rejected', 'acknowledged', 'abandoned'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      next_attempt_at TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT
    )
  `)
  await resolved.execute(`
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_workspace_state_sequence
    ON sync_outbox (workspace_id, state, local_sequence)
  `)
  await resolved.execute(`
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_workspace_aggregate_sequence
    ON sync_outbox (workspace_id, aggregate_key, local_sequence)
  `)
  await resolved.execute(`
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_lease_expiry
    ON sync_outbox (lease_expires_at)
    WHERE state = 'leased'
  `)
  await resolved.execute(`
    CREATE TABLE IF NOT EXISTS sync_server_snapshots (
      workspace_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      server_version INTEGER,
      change_seq INTEGER,
      payload_json TEXT,
      acknowledged_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, entity_type, entity_id)
    )
  `)
  await resolved.execute(`
    CREATE INDEX IF NOT EXISTS idx_sync_server_snapshots_workspace_change
    ON sync_server_snapshots (workspace_id, change_seq)
  `)
  await resolved.execute(`
    CREATE TABLE IF NOT EXISTS sync_cursors (
      workspace_id TEXT PRIMARY KEY,
      change_seq INTEGER NOT NULL DEFAULT 0,
      snapshot_watermark INTEGER,
      updated_at TEXT NOT NULL
    )
  `)
  await resolved.execute(`
    CREATE TABLE IF NOT EXISTS sync_asset_metadata (
      workspace_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      mime_type TEXT,
      upload_state TEXT NOT NULL DEFAULT 'pending',
      remote_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, content_hash)
    )
  `)
  await resolved.execute(`
    CREATE INDEX IF NOT EXISTS idx_sync_asset_metadata_upload
    ON sync_asset_metadata (workspace_id, upload_state, updated_at)
  `)
  await resolved.execute(`
    CREATE TABLE IF NOT EXISTS sync_runtime_metadata (
      workspace_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, key)
    )
  `)
  await resolved.execute(`
    CREATE TABLE IF NOT EXISTS sync_snapshot_stage (
      workspace_id TEXT NOT NULL,
      snapshot_watermark INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      server_version INTEGER,
      payload_json TEXT,
      changed_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, snapshot_watermark, entity_type, entity_id)
    )
  `)
  await resolved.execute(`
    CREATE INDEX IF NOT EXISTS idx_sync_snapshot_stage_workspace
    ON sync_snapshot_stage (workspace_id, snapshot_watermark, entity_type, entity_id)
  `)

  initializedConnections.add(resolved as object)
  return resolved
}

async function readExistingReplicaPayload(
  connection: SqliteConnection,
  entityType: string,
  entityId: string,
) {
  const rows = await connection.select<Array<{ payload: string }>>(
    `SELECT payload FROM local_entities WHERE entity_type = $1 AND entity_id = $2 LIMIT 1`,
    [entityType, entityId],
  )
  if (!rows[0]?.payload) return {}
  try {
    return parseJsonObject(rows[0].payload, 'Local entity payload')
  } catch {
    return {}
  }
}

async function resolveDeleteBaseVersion(
  connection: SqliteConnection,
  input: EnqueueCloudSyncMutationInput,
  inferredBaseVersion: number | null,
) {
  if (inferredBaseVersion !== null || input.operation !== 'delete') {
    return inferredBaseVersion
  }

  const snapshots = await connection.select<Array<{ server_version: number | null }>>(
    `
      SELECT server_version
      FROM sync_server_snapshots
      WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3
      LIMIT 1
    `,
    [input.workspaceId, input.entityType, input.entityId],
  )
  const snapshotVersion = snapshots[0]?.server_version
  if (typeof snapshotVersion === 'number' && Number.isFinite(snapshotVersion)) {
    return Math.max(0, Math.trunc(snapshotVersion))
  }

  return inferBaseVersion(
    'delete',
    await readExistingReplicaPayload(connection, input.entityType, input.entityId),
  )
}

async function materializeEntityPayload(
  connection: SqliteConnection,
  input: EnqueueCloudSyncMutationInput,
  updatedAt: string,
) {
  const existing = await readExistingReplicaPayload(
    connection,
    input.entityType,
    input.entityId,
  )
  const inputPayload = { ...input.payload }
  delete inputPayload.hardDelete
  delete inputPayload.hard_delete

  const payload = {
    ...existing,
    ...inputPayload,
    id: input.entityId,
    workspaceId: input.workspaceId,
    syncStatus: 'pending',
    lastSyncedAt: null,
    ...(input.operation === 'delete' ? { isDeleted: true } : {}),
  }

  await connection.execute(
    `
      INSERT INTO local_entities (
        entity_type, entity_id, workspace_id, current_workspace, payload, updated_at
      ) VALUES ($1, $2, $3, NULL, $4, $5)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `,
    [
      input.entityType,
      input.entityId,
      input.workspaceId,
      canonicalJson(payload),
      updatedAt,
    ],
  )
}

function serverEntityToReplicaPayload(
  payload: Record<string, unknown>,
  entityId: string,
  workspaceId: string,
  syncedAt: string,
) {
  return {
    ...toCamelCase(payload),
    id: entityId,
    workspaceId,
    syncStatus: 'synced',
    lastSyncedAt: syncedAt,
  }
}

async function replaceMaterializedEntityFromServer(
  connection: SqliteConnection,
  entityType: OfflineMutationEntityType,
  entityId: string,
  workspaceId: string,
  payload: Record<string, unknown>,
  syncedAt: string,
  updatedAt = syncedAt,
) {
  await connection.execute(
    `
      INSERT INTO local_entities (
        entity_type, entity_id, workspace_id, current_workspace, payload, updated_at
      ) VALUES ($1, $2, $3, NULL, $4, $5)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `,
    [
      entityType,
      entityId,
      workspaceId,
      canonicalJson(serverEntityToReplicaPayload(
        payload,
        entityId,
        workspaceId,
        syncedAt,
      )),
      updatedAt,
    ],
  )
}

async function selectMutationById(
  connection: SqliteConnection,
  mutationId: string,
) {
  const rows = await connection.select<DurableOutboxRow[]>(
    `SELECT * FROM sync_outbox WHERE mutation_id = $1 LIMIT 1`,
    [mutationId],
  )
  return rows[0] ? toDurableMutation(rows[0]) : null
}

function mergeOperations(
  previous: OfflineMutation['operation'],
  next: OfflineMutation['operation'],
): OfflineMutation['operation'] | 'cancel' {
  if (previous === 'create' && next === 'delete') return 'cancel'
  if (previous === 'create') return 'create'
  if (next === 'delete') return 'delete'
  if (previous === 'delete' && next === 'create') return 'update'
  return next
}

export async function enqueueCloudSyncMutation(
  input: EnqueueCloudSyncMutationInput,
  transactionConnection?: SqliteConnection,
): Promise<EnqueueCloudSyncMutationResult> {
  const registration = getSyncRegistration(input.entityType)
  if (registration.kind === 'derived') {
    return { mutation: null, removedMutationIds: [], ignoredDerived: true }
  }
  if (registration.onlineOnly) {
    throw new Error(`${input.entityType} is an online-only control-plane mutation.`)
  }

  // This deliberately fails for Blobs/functions/cycles. Assets must be written
  // to the content-addressed sidecar and referenced by hash/path in JSON.
  const remotePayload = prepareRemoteMutationPayload(input.entityType, input.payload)
  if (registration.kind === 'entity' && input.operation === 'delete') {
    // Protocol entity deletes are recoverable tombstones. Legacy hard-delete
    // flags were local projection hints, not server columns or authorization
    // to physically remove an authoritative row.
    delete remotePayload.hard_delete
    remotePayload.id = input.entityId
  }
  const payloadJson = canonicalJson(remotePayload)
  const payload = parseJsonObject(payloadJson, 'Mutation payload')
  const payloadHash = await sha256CanonicalJson(payload)
  const now = input.createdAt ?? new Date().toISOString()
  const aggregateKey = input.aggregateKey ?? `${input.entityType}:${input.entityId}`
  const actorId = input.actorId ?? getActiveBusinessUserId()
  const inferredBaseVersion = input.baseVersion
    ?? inferBaseVersion(input.operation, input.payload)
  const dependencies = [...new Set(input.dependencies ?? [])]
  const mutationKind = registration.kind
  const mutationType = mutationKind === 'entity'
    ? input.operation === 'delete' ? 'entity.delete' : 'entity.upsert'
    : `command.${input.entityType}`

  const enqueue = async (connection: SqliteConnection) => {
    await ensureCloudSyncOutboxSchema(connection)
    const removedMutationIds: string[] = []
    const baseVersion = registration.kind === 'entity'
      ? await resolveDeleteBaseVersion(connection, input, inferredBaseVersion)
      : inferredBaseVersion

    if (registration.materializePayload) {
      await materializeEntityPayload(connection, input, now)
    }

    if (registration.compact) {
      const existingRows = await connection.select<DurableOutboxRow[]>(
        `
          SELECT *
          FROM sync_outbox
          WHERE workspace_id = $1
            AND aggregate_key = $2
            AND mutation_kind = 'entity'
            AND state IN ('pending', 'retry_wait')
          ORDER BY local_sequence DESC
          LIMIT 1
        `,
        [input.workspaceId, aggregateKey],
      )
      const existing = existingRows[0] ? toDurableMutation(existingRows[0]) : null
      if (existing) {
        const operation = mergeOperations(existing.operation, input.operation)
        if (operation === 'cancel') {
          await connection.execute(
            `DELETE FROM sync_outbox WHERE mutation_id = $1`,
            [existing.mutationId],
          )
          await connection.execute(
            `DELETE FROM local_entities WHERE entity_type = $1 AND entity_id = $2`,
            [input.entityType, input.entityId],
          )
          removedMutationIds.push(existing.mutationId)
          return { mutation: null, removedMutationIds, ignoredDerived: false }
        }

        const mergedPayload = operation === 'delete'
          ? { ...existing.payload, ...payload, id: input.entityId }
          : { ...existing.payload, ...payload }
        const mergedHash = await sha256CanonicalJson(mergedPayload)
        const mergedDependencies = [...new Set([
          ...existing.dependencies,
          ...dependencies,
        ])]
        await connection.execute(
          `
            UPDATE sync_outbox
            SET operation = $1,
                mutation_type = $2,
                dependencies_json = $3,
                payload_hash = $4,
                payload_json = $5,
                state = 'pending',
                next_attempt_at = NULL,
                error_code = NULL,
                error_message = NULL,
                updated_at = $6
            WHERE mutation_id = $7
          `,
          [
            operation,
            operation === 'delete' ? 'entity.delete' : 'entity.upsert',
            canonicalJson(mergedDependencies),
            mergedHash,
            canonicalJson(mergedPayload),
            now,
            existing.mutationId,
          ],
        )
        return {
          mutation: await selectMutationById(connection, existing.mutationId),
          removedMutationIds,
          ignoredDerived: false,
        }
      }
    }

    const earlierRows = await connection.select<Array<{ mutation_id: string }>>(
      `
        SELECT mutation_id
        FROM sync_outbox
        WHERE workspace_id = $1
          AND (aggregate_key = $2 OR ($3 IS NOT NULL AND group_id = $3))
          AND state NOT IN ('acknowledged', 'abandoned')
        ORDER BY local_sequence DESC
        LIMIT 1
      `,
      [input.workspaceId, aggregateKey, input.groupId ?? null],
    )
    if (earlierRows[0]?.mutation_id) dependencies.push(earlierRows[0].mutation_id)

    await connection.execute(
      `
        INSERT INTO sync_outbox (
          mutation_id, workspace_id, actor_id, entity_type, entity_id,
          operation, mutation_kind, mutation_type, aggregate_key, group_id,
          dependencies_json, payload_schema_version, payload_hash, payload_json,
          base_version, state, attempt_count, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, 'pending', 0, $16, $16
        )
      `,
      [
        input.mutationId,
        input.workspaceId,
        actorId,
        input.entityType,
        input.entityId,
        input.operation,
        mutationKind,
        mutationType,
        aggregateKey,
        input.groupId ?? null,
        canonicalJson([...new Set(dependencies)]),
        registration.payloadSchemaVersion,
        payloadHash,
        payloadJson,
        baseVersion,
        now,
      ],
    )

    return {
      mutation: await selectMutationById(connection, input.mutationId),
      removedMutationIds,
      ignoredDerived: false,
    }
  }

  if (!actorId) {
    throw new Error('Cloud Sync requires an explicit authenticated user scope.')
  }
  if (transactionConnection) {
    return enqueue(transactionConnection)
  }
  return runLocalModeSqliteTransaction(
    enqueue,
    { workspaceId: input.workspaceId, userId: actorId },
  )
}

/**
 * Reads the durable result of the database middleware's atomic entity write.
 * This lets the legacy Dexie queue call site refresh its projection without
 * enqueuing the same intent a second time.
 */
export async function readAtomicCloudSyncEntityMutation(
  workspaceId: string,
  entityType: OfflineMutationEntityType,
  entityId: string,
  userId?: string | null,
) {
  const connection = await ensureCloudSyncOutboxSchema(
    undefined,
    scopeForWorkspace(workspaceId, userId),
  )
  const rows = await connection.select<DurableOutboxRow[]>(
    `
      SELECT *
      FROM sync_outbox
      WHERE workspace_id = $1
        AND aggregate_key = $2
        AND mutation_kind = 'entity'
        AND state IN ('pending', 'retry_wait')
      ORDER BY local_sequence DESC
      LIMIT 1
    `,
    [workspaceId, `${entityType}:${entityId}`],
  )
  const localRows = await connection.select<Array<{ present: number }>>(
    `
      SELECT 1 AS present
      FROM local_entities
      WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3
      LIMIT 1
    `,
    [workspaceId, entityType, entityId],
  )
  return {
    mutation: rows[0] ? toDurableMutation(rows[0]) : null,
    localEntityPresent: localRows.length > 0,
  }
}

export async function listCloudSyncOutbox(
  workspaceId: string,
  states?: readonly DurableMutationState[],
  userId?: string | null,
) {
  const connection = await ensureCloudSyncOutboxSchema(
    undefined,
    scopeForWorkspace(workspaceId, userId),
  )
  const rows = states?.length
    ? await connection.select<DurableOutboxRow[]>(
      `
        SELECT * FROM sync_outbox
        WHERE workspace_id = $1
          AND state IN (${states.map((_state, index) => `$${index + 2}`).join(', ')})
        ORDER BY local_sequence
      `,
      [workspaceId, ...states],
    )
    : await connection.select<DurableOutboxRow[]>(
      `SELECT * FROM sync_outbox WHERE workspace_id = $1 ORDER BY local_sequence`,
      [workspaceId],
    )
  return rows.map(toDurableMutation)
}

export async function leaseCloudSyncOutbox(
  workspaceId: string,
  leaseOwner: string,
  options: { limit?: number; leaseMs?: number; now?: Date; userId?: string | null } = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
  const now = options.now ?? new Date()
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? 60_000)).toISOString()

  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    await connection.execute(
      `
        UPDATE sync_outbox
        SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = $1
        WHERE workspace_id = $2
          AND state = 'leased'
          AND lease_expires_at <= $1
      `,
      [nowIso, workspaceId],
    )

    const rows = await connection.select<DurableOutboxRow[]>(
      `
        SELECT * FROM sync_outbox
        WHERE workspace_id = $1
          AND state NOT IN ('acknowledged', 'abandoned')
        ORDER BY local_sequence
      `,
      [workspaceId],
    )
    const mutations = rows.map(toDurableMutation)
    const stateById = new Map(mutations.map((mutation) => [mutation.mutationId, mutation.state]))
    const seenOrderingKeys = new Set<string>()
    const selected: DurableOutboxMutation[] = []

    for (const mutation of mutations) {
      const orderingKey = mutation.groupId ?? mutation.aggregateKey
      if (seenOrderingKeys.has(orderingKey)) continue
      seenOrderingKeys.add(orderingKey)

      const runnable = mutation.state === 'pending' || (
        mutation.state === 'retry_wait' &&
        (!mutation.nextAttemptAt || mutation.nextAttemptAt <= nowIso)
      )
      if (!runnable) continue

      const dependencyBlocked = mutation.dependencies.some((dependencyId) => {
        const state = stateById.get(dependencyId)
        return state !== undefined && state !== 'acknowledged' && state !== 'abandoned'
      })
      if (dependencyBlocked) continue

      selected.push(mutation)
      if (selected.length >= limit) break
    }

    for (const mutation of selected) {
      await connection.execute(
        `
          UPDATE sync_outbox
          SET state = 'leased', lease_owner = $1, lease_expires_at = $2,
              attempt_count = attempt_count + 1, error_code = NULL,
              error_message = NULL, updated_at = $3
          WHERE mutation_id = $4 AND state IN ('pending', 'retry_wait')
        `,
        [leaseOwner, leaseExpiresAt, nowIso, mutation.mutationId],
      )
    }

    const leased: DurableOutboxMutation[] = []
    for (const mutation of selected) {
      const refreshed = await selectMutationById(connection, mutation.mutationId)
      if (refreshed?.state === 'leased' && refreshed.leaseOwner === leaseOwner) {
        leased.push(refreshed)
      }
    }
    return leased
  }, scopeForWorkspace(workspaceId, options.userId))
}

export async function transitionCloudSyncMutation(
  mutationId: string,
  state: DurableMutationState,
  options: {
    errorCode?: string | null
    errorMessage?: string | null
    nextAttemptAt?: string | null
    acknowledgedAt?: string | null
    workspaceId: string
    userId?: string | null
  },
) {
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    const now = new Date().toISOString()
    await connection.execute(
      `
        UPDATE sync_outbox
        SET state = $1,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_attempt_at = $2,
            error_code = $3,
            error_message = $4,
            acknowledged_at = $5,
            updated_at = $6
        WHERE mutation_id = $7
      `,
      [
        state,
        options.nextAttemptAt ?? null,
        options.errorCode ?? null,
        options.errorMessage ?? null,
        options.acknowledgedAt ?? (state === 'acknowledged' ? now : null),
        now,
        mutationId,
      ],
    )
    const mutation = await selectMutationById(connection, mutationId)
    if (
      mutation
      && mutation.mutationKind === 'entity'
      && (state === 'acknowledged' || state === 'abandoned')
    ) {
      const remaining = await connection.select<Array<{ present: number }>>(
        `
          SELECT 1 AS present
          FROM sync_outbox
          WHERE workspace_id = $1
            AND aggregate_key = $2
            AND state NOT IN ('acknowledged', 'abandoned')
          LIMIT 1
        `,
        [mutation.workspaceId, mutation.aggregateKey],
      )
      if (remaining.length === 0) {
        const snapshots = await connection.select<Array<{
          payload_json: string | null
          acknowledged_at: string
        }>>(
          `
            SELECT payload_json, acknowledged_at
            FROM sync_server_snapshots
            WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3
            LIMIT 1
          `,
          [mutation.workspaceId, mutation.entityType, mutation.entityId],
        )
        const snapshot = snapshots[0]
        if (!snapshot?.payload_json) {
          if (snapshot || mutation.operation === 'create') {
            await connection.execute(
              `DELETE FROM local_entities WHERE entity_type = $1 AND entity_id = $2`,
              [mutation.entityType, mutation.entityId],
            )
          }
        } else {
          await replaceMaterializedEntityFromServer(
            connection,
            mutation.entityType,
            mutation.entityId,
            mutation.workspaceId,
            parseJsonObject(snapshot.payload_json, 'Withheld server snapshot'),
            snapshot.acknowledged_at || now,
          )
        }
      }
    }
    return mutation
  }, scopeForWorkspace(options.workspaceId, options.userId))
}

export async function updateCloudSyncMutationPayload(
  mutationId: string,
  payload: Record<string, unknown>,
  options: { workspaceId: string; resetToPending?: boolean; userId?: string | null },
) {
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    const mutation = await selectMutationById(connection, mutationId)
    if (!mutation) return null
    const remotePayload = prepareRemoteMutationPayload(mutation.entityType, payload)
    if (mutation.mutationKind === 'entity' && mutation.operation === 'delete') {
      delete remotePayload.hard_delete
      remotePayload.id = mutation.entityId
    }
    const payloadHash = await sha256CanonicalJson(remotePayload)
    const now = new Date().toISOString()
    await connection.execute(
      `
        UPDATE sync_outbox
        SET workspace_id = $1,
            payload_json = $2,
            payload_hash = $3,
            state = CASE WHEN $4 = 1 THEN 'pending' ELSE state END,
            lease_owner = CASE WHEN $4 = 1 THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN $4 = 1 THEN NULL ELSE lease_expires_at END,
            next_attempt_at = CASE WHEN $4 = 1 THEN NULL ELSE next_attempt_at END,
            error_code = CASE WHEN $4 = 1 THEN NULL ELSE error_code END,
            error_message = CASE WHEN $4 = 1 THEN NULL ELSE error_message END,
            updated_at = $5
        WHERE mutation_id = $6
      `,
      [
        options.workspaceId ?? mutation.workspaceId,
        canonicalJson(remotePayload),
        payloadHash,
        options.resetToPending === false ? 0 : 1,
        now,
        mutationId,
      ],
    )
    return selectMutationById(connection, mutationId)
  }, scopeForWorkspace(options.workspaceId, options.userId))
}

export function getRetryAt(attemptCount: number, now = Date.now()) {
  const cappedAttempt = Math.max(0, Math.min(attemptCount, 8))
  const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** cappedAttempt)
  return new Date(now + delayMs).toISOString()
}

export async function acknowledgeCloudSyncMutation(
  mutationId: string,
  result: {
    serverVersion?: number | null
    changeSeq?: number | null
    entity?: Record<string, unknown> | null
    workspaceId: string
    userId?: string | null
  },
) {
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    const mutation = await selectMutationById(connection, mutationId)
    if (!mutation) return null
    const now = new Date().toISOString()
    const serverEntity = result.entity === undefined ? mutation.payload : result.entity

    await connection.execute(
      `
        UPDATE sync_outbox
        SET state = 'acknowledged', lease_owner = NULL, lease_expires_at = NULL,
            next_attempt_at = NULL, error_code = NULL, error_message = NULL,
            acknowledged_at = $1, updated_at = $1
        WHERE mutation_id = $2
      `,
      [now, mutationId],
    )
    await connection.execute(
      `
        INSERT INTO sync_server_snapshots (
          workspace_id, entity_type, entity_id, server_version, change_seq,
          payload_json, acknowledged_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(workspace_id, entity_type, entity_id) DO UPDATE SET
          server_version = excluded.server_version,
          change_seq = excluded.change_seq,
          payload_json = excluded.payload_json,
          acknowledged_at = excluded.acknowledged_at
      `,
      [
        mutation.workspaceId,
        mutation.entityType,
        mutation.entityId,
        result.serverVersion ?? null,
        result.changeSeq ?? null,
        serverEntity ? canonicalJson(serverEntity) : null,
        now,
      ],
    )
    if (mutation.mutationKind === 'entity') {
      if (result.entity) {
        // The snapshot intentionally remains the raw server representation.
        // The durable local replica is the UI-ready camelCase projection so a
        // restart between this commit and Dexie projection cannot regress it.
        await replaceMaterializedEntityFromServer(
          connection,
          mutation.entityType,
          mutation.entityId,
          mutation.workspaceId,
          result.entity,
          now,
        )
      } else {
        const existing = await readExistingReplicaPayload(
          connection,
          mutation.entityType,
          mutation.entityId,
        )
        await replaceMaterializedEntityFromServer(
          connection,
          mutation.entityType,
          mutation.entityId,
          mutation.workspaceId,
          Object.keys(existing).length > 0 ? existing : mutation.payload,
          now,
        )
      }
    }
    // A push receipt proves only that this mutation committed; it does not
    // prove that every earlier change was pulled. Keep its change sequence on
    // the per-entity server snapshot, but advance sync_cursors exclusively in
    // applyCloudSyncPullPage/finalizeCloudSyncSnapshot.
    return selectMutationById(connection, mutationId)
  }, scopeForWorkspace(result.workspaceId, result.userId))
}

async function writeCursor(
  connection: SqliteConnection,
  workspaceId: string,
  changeSeq: number,
  snapshotWatermark: number | null,
  updatedAt: string,
) {
  await connection.execute(
    `
      INSERT INTO sync_cursors (workspace_id, change_seq, snapshot_watermark, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(workspace_id) DO UPDATE SET
        change_seq = CASE
          WHEN excluded.change_seq > sync_cursors.change_seq
          THEN excluded.change_seq ELSE sync_cursors.change_seq END,
        snapshot_watermark = COALESCE(excluded.snapshot_watermark, sync_cursors.snapshot_watermark),
        updated_at = excluded.updated_at
    `,
    [workspaceId, changeSeq, snapshotWatermark, updatedAt],
  )
}

export async function readCloudSyncCursor(workspaceId: string, userId?: string | null) {
  const connection = await ensureCloudSyncOutboxSchema(
    undefined,
    scopeForWorkspace(workspaceId, userId),
  )
  const rows = await connection.select<Array<{
    change_seq: number
    snapshot_watermark: number | null
  }>>(
    `SELECT change_seq, snapshot_watermark FROM sync_cursors WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
  )
  return {
    changeSeq: Number(rows[0]?.change_seq ?? 0),
    snapshotWatermark: rows[0]?.snapshot_watermark === null || rows[0]?.snapshot_watermark === undefined
      ? null
      : Number(rows[0].snapshot_watermark),
  }
}

export async function setCloudSyncCursor(
  workspaceId: string,
  changeSeq: number,
  snapshotWatermark: number | null = null,
  userId?: string | null,
) {
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    await writeCursor(
      connection,
      workspaceId,
      changeSeq,
      snapshotWatermark,
      new Date().toISOString(),
    )
  }, scopeForWorkspace(workspaceId, userId))
}

export async function validateCloudSyncOutboxAgainstSnapshots(
  workspaceId: string,
  userId?: string | null,
) {
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    const now = new Date().toISOString()

    // ID-only deletes cannot infer a compare-and-set version from their
    // payload. Once a baseline is durably installed, the authoritative
    // snapshot supplies that version; absence at a complete baseline means
    // base zero and remains safe because an unexpected server row conflicts.
    await connection.execute(
      `
        UPDATE sync_outbox
        SET base_version = COALESCE((
              SELECT snapshot.server_version
              FROM sync_server_snapshots AS snapshot
              WHERE snapshot.workspace_id = sync_outbox.workspace_id
                AND snapshot.entity_type = sync_outbox.entity_type
                AND snapshot.entity_id = sync_outbox.entity_id
              LIMIT 1
            ), 0),
            updated_at = $2
        WHERE workspace_id = $1
          AND mutation_kind = 'entity'
          AND mutation_type = 'entity.delete'
          AND base_version IS NULL
          AND state IN ('pending', 'retry_wait', 'blocked')
          AND EXISTS (
            SELECT 1
            FROM sync_cursors AS cursor
            WHERE cursor.workspace_id = sync_outbox.workspace_id
              AND cursor.snapshot_watermark IS NOT NULL
          )
      `,
      [workspaceId, now],
    )
    const rows = await connection.select<Array<{
      mutation_id: string
      base_version: number
      server_version: number
    }>>(
      `
        SELECT outbox.mutation_id, outbox.base_version, snapshot.server_version
        FROM sync_outbox AS outbox
        JOIN sync_server_snapshots AS snapshot
          ON snapshot.workspace_id = outbox.workspace_id
         AND snapshot.entity_type = outbox.entity_type
         AND snapshot.entity_id = outbox.entity_id
        WHERE outbox.workspace_id = $1
          AND outbox.mutation_kind = 'entity'
          AND outbox.state IN ('pending', 'retry_wait', 'blocked')
          AND outbox.base_version IS NOT NULL
          AND snapshot.server_version IS NOT NULL
          AND outbox.base_version <> snapshot.server_version
      `,
      [workspaceId],
    )
    for (const row of rows) {
      await connection.execute(
        `
          UPDATE sync_outbox
          SET state = 'conflict',
              error_code = 'version_conflict',
              error_message = $1,
              next_attempt_at = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = $2
          WHERE mutation_id = $3
        `,
        [
          `Server version ${row.server_version} differs from local base version ${row.base_version}.`,
          now,
          row.mutation_id,
        ],
      )
    }
    return rows.map((row) => row.mutation_id)
  }, scopeForWorkspace(workspaceId, userId))
}

export async function applyCloudSyncPullPage(
  workspaceId: string,
  changes: readonly CloudSyncPullChange[],
  nextCursor: number,
  snapshotWatermark: number | null = null,
  userId?: string | null,
) {
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    const now = new Date().toISOString()
    const applied: CloudSyncPullChange[] = []
    const withheld: CloudSyncPullChange[] = []

    for (const change of changes) {
      const pending = await connection.select<Array<{ present: number }>>(
        `
          SELECT 1 AS present
          FROM sync_outbox
          WHERE workspace_id = $1
            AND aggregate_key = $2
            AND state NOT IN ('acknowledged', 'abandoned')
          LIMIT 1
        `,
        [workspaceId, `${change.entityType}:${change.entityId}`],
      )
      const payloadJson = change.payload ? canonicalJson(change.payload) : null
      await connection.execute(
        `
          INSERT INTO sync_server_snapshots (
            workspace_id, entity_type, entity_id, server_version, change_seq,
            payload_json, acknowledged_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT(workspace_id, entity_type, entity_id) DO UPDATE SET
            server_version = excluded.server_version,
            change_seq = excluded.change_seq,
            payload_json = excluded.payload_json,
            acknowledged_at = excluded.acknowledged_at
        `,
        [
          workspaceId,
          change.entityType,
          change.entityId,
          change.entityVersion,
          change.changeSeq,
          payloadJson,
          now,
        ],
      )

      if (pending.length > 0) {
        withheld.push(change)
        continue
      }

      if (change.operation === 'delete' || !change.payload) {
        await connection.execute(
          `DELETE FROM local_entities WHERE entity_type = $1 AND entity_id = $2`,
          [change.entityType, change.entityId],
        )
      } else {
        await replaceMaterializedEntityFromServer(
          connection,
          change.entityType,
          change.entityId,
          workspaceId,
          change.payload,
          now,
          change.changedAt,
        )
      }
      applied.push(change)
    }

    await writeCursor(connection, workspaceId, nextCursor, snapshotWatermark, now)
    return { applied, withheld }
  }, scopeForWorkspace(workspaceId, userId))
}

/**
 * Durably stages one server snapshot page. Network pagination never mutates the
 * active replica: the staged snapshot becomes visible only in the final SQLite
 * transaction after every page has been received and validated.
 */
export async function stageCloudSyncSnapshotPage(
  workspaceId: string,
  snapshotWatermark: number,
  rows: readonly CloudSyncSnapshotRow[],
  reset: boolean,
  userId?: string | null,
) {
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    if (reset) {
      await connection.execute(
        `DELETE FROM sync_snapshot_stage WHERE workspace_id = $1`,
        [workspaceId],
      )
    }

    for (const row of rows) {
      await connection.execute(
        `
          INSERT INTO sync_snapshot_stage (
            workspace_id, snapshot_watermark, entity_type, entity_id,
            operation, server_version, payload_json, changed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT(workspace_id, snapshot_watermark, entity_type, entity_id)
          DO UPDATE SET
            operation = excluded.operation,
            server_version = excluded.server_version,
            payload_json = excluded.payload_json,
            changed_at = excluded.changed_at
        `,
        [
          workspaceId,
          snapshotWatermark,
          row.entityType,
          row.entityId,
          row.operation,
          row.entityVersion,
          row.payload ? canonicalJson(row.payload) : null,
          row.changedAt,
        ],
      )
    }
  }, scopeForWorkspace(workspaceId, userId))
}

/**
 * Atomically swaps a fully staged RPC snapshot into SQLite and advances the
 * cursor to its captured watermark. Optimistic entities with live outbox
 * intents are deliberately retained; the following pull/rebase resolves them
 * against changes that happened after the snapshot watermark.
 */
export async function finalizeCloudSyncSnapshot(
  workspaceId: string,
  snapshotWatermark: number,
  entityTypes: readonly OfflineMutationEntityType[],
  userId?: string | null,
): Promise<CloudSyncReplicaProjectionRow[]> {
  const uniqueEntityTypes = [...new Set(entityTypes)]
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    const now = new Date().toISOString()

    for (const entityType of uniqueEntityTypes) {
      // Clear only confirmed server state. Local entities with a live intent
      // remain materialized and will be validated/rebased after this commit.
      await connection.execute(
        `DELETE FROM sync_server_snapshots WHERE workspace_id = $1 AND entity_type = $2`,
        [workspaceId, entityType],
      )
      await connection.execute(
        `
          DELETE FROM local_entities
          WHERE workspace_id = $1
            AND entity_type = $2
            AND NOT EXISTS (
              SELECT 1
              FROM sync_outbox AS outbox
              WHERE outbox.workspace_id = $1
                AND outbox.aggregate_key = local_entities.entity_type || ':' || local_entities.entity_id
                AND outbox.state NOT IN ('acknowledged', 'abandoned')
            )
        `,
        [workspaceId, entityType],
      )

      const staged = await connection.select<Array<{
        entity_id: string
        operation: 'upsert' | 'delete'
        server_version: number | null
        payload_json: string | null
        changed_at: string
      }>>(
        `
          SELECT entity_id, operation, server_version, payload_json, changed_at
          FROM sync_snapshot_stage
          WHERE workspace_id = $1
            AND snapshot_watermark = $2
            AND entity_type = $3
          ORDER BY entity_id
        `,
        [workspaceId, snapshotWatermark, entityType],
      )

      for (const row of staged) {
        await connection.execute(
          `
            INSERT INTO sync_server_snapshots (
              workspace_id, entity_type, entity_id, server_version, change_seq,
              payload_json, acknowledged_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT(workspace_id, entity_type, entity_id) DO UPDATE SET
              server_version = excluded.server_version,
              change_seq = excluded.change_seq,
              payload_json = excluded.payload_json,
              acknowledged_at = excluded.acknowledged_at
          `,
          [
            workspaceId,
            entityType,
            row.entity_id,
            row.server_version,
            snapshotWatermark,
            row.payload_json,
            now,
          ],
        )

        const pending = await connection.select<Array<{ present: number }>>(
          `
            SELECT 1 AS present
            FROM sync_outbox
            WHERE workspace_id = $1
              AND aggregate_key = $2
              AND state NOT IN ('acknowledged', 'abandoned')
            LIMIT 1
          `,
          [workspaceId, `${entityType}:${row.entity_id}`],
        )
        if (pending.length > 0) continue

        if (row.operation === 'delete' || !row.payload_json) {
          await connection.execute(
            `DELETE FROM local_entities WHERE entity_type = $1 AND entity_id = $2`,
            [entityType, row.entity_id],
          )
          continue
        }
        await replaceMaterializedEntityFromServer(
          connection,
          entityType,
          row.entity_id,
          workspaceId,
          parseJsonObject(row.payload_json, 'Snapshot entity payload'),
          now,
          row.changed_at,
        )
      }
    }

    await writeCursor(connection, workspaceId, snapshotWatermark, snapshotWatermark, now)
    await connection.execute(
      `DELETE FROM sync_snapshot_stage WHERE workspace_id = $1`,
      [workspaceId],
    )

    const projection: CloudSyncReplicaProjectionRow[] = []
    for (const entityType of uniqueEntityTypes) {
      const rows = await connection.select<Array<{ entity_id: string; payload: string }>>(
        `
          SELECT entity_id, payload
          FROM local_entities
          WHERE workspace_id = $1 AND entity_type = $2
          ORDER BY entity_id
        `,
        [workspaceId, entityType],
      )
      for (const row of rows) {
        projection.push({
          entityType,
          entityId: row.entity_id,
          payload: parseJsonObject(row.payload, 'Snapshot replica payload'),
        })
      }
    }
    return projection
  }, scopeForWorkspace(workspaceId, userId))
}

export async function rebuildDexieOutboxProjection(
  cacheDb: Dexie,
  workspaceId: string,
  userId?: string | null,
) {
  const mutations = await listCloudSyncOutbox(workspaceId, undefined, userId)
  const table = cacheDb.table('offline_mutations')
  const existingKeys = await table.where('workspaceId').equals(workspaceId).primaryKeys()
  await cacheDb.transaction('rw', table, async () => {
    if (existingKeys.length > 0) await table.bulkDelete(existingKeys)
    if (mutations.length > 0) {
      await table.bulkPut(mutations.map(durableMutationToOfflineMutation))
    }
  })
  return mutations.length
}

function legacyState(status: MutationStatus): DurableMutationState {
  if (status === 'syncing' || status === 'leased') return 'pending'
  if (status === 'failed') return 'rejected'
  if (status === 'synced') return 'acknowledged'
  if (status === 'acknowledged' || status === 'abandoned' || status === 'blocked' ||
      status === 'conflict' || status === 'rejected' || status === 'retry_wait') {
    return status
  }
  return 'pending'
}

export async function importLegacyDexieOutbox(
  cacheDb: Dexie,
  workspaceId: string,
  userId?: string | null,
) {
  const rows = await cacheDb.table('offline_mutations')
    .where('workspaceId')
    .equals(workspaceId)
    .toArray() as OfflineMutation[]
  if (rows.length === 0) return 0

  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    const existing = await connection.select<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM sync_outbox WHERE workspace_id = $1`,
      [workspaceId],
    )
    if (Number(existing[0]?.count ?? 0) > 0) return 0

    let imported = 0
    for (const row of [...rows].sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    ))) {
      const registration = getSyncRegistration(row.entityType)
      if (registration.kind === 'derived' || registration.onlineOnly) continue
      const payload = prepareRemoteMutationPayload(row.entityType, row.payload)
      const mutationKind = registration.kind
      if (mutationKind === 'entity' && row.operation === 'delete') {
        delete payload.hard_delete
        payload.id = row.entityId
      }
      const payloadHash = await sha256CanonicalJson(payload)
      await connection.execute(
        `
          INSERT OR IGNORE INTO sync_outbox (
            mutation_id, workspace_id, actor_id, entity_type, entity_id,
            operation, mutation_kind, mutation_type, aggregate_key, group_id,
            dependencies_json, payload_schema_version, payload_hash, payload_json,
            base_version, state, attempt_count, error_message, created_at, updated_at,
            acknowledged_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21
          )
        `,
        [
          row.id,
          row.workspaceId,
          row.actorId ?? getActiveBusinessUserId(),
          row.entityType,
          row.entityId,
          row.operation,
          mutationKind,
          mutationKind === 'entity'
            ? row.operation === 'delete' ? 'entity.delete' : 'entity.upsert'
            : `command.${row.entityType}`,
          row.aggregateKey ?? `${row.entityType}:${row.entityId}`,
          row.groupId ?? null,
          canonicalJson(row.dependencies ?? []),
          row.payloadSchemaVersion ?? registration.payloadSchemaVersion,
          payloadHash,
          canonicalJson(payload),
          row.baseVersion ?? inferBaseVersion(row.operation, row.payload),
          legacyState(row.status),
          row.attemptCount ?? 0,
          row.error ?? null,
          row.createdAt,
          row.updatedAt ?? row.createdAt,
          row.acknowledgedAt ?? (row.status === 'synced' ? row.updatedAt ?? row.createdAt : null),
        ],
      )
      imported += 1
    }

    const verified = await connection.select<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM sync_outbox WHERE workspace_id = $1`,
      [workspaceId],
    )
    if (Number(verified[0]?.count ?? 0) !== imported) {
      throw new Error('Cloud Sync outbox migration verification failed.')
    }
    return imported
  }, scopeForWorkspace(workspaceId, userId))
}

export async function pruneAcknowledgedCloudSyncMutations(
  workspaceId: string,
  now = new Date(),
  userId?: string | null,
) {
  const cutoff = new Date(
    now.getTime() - CLOUD_SYNC_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  return runLocalModeSqliteTransaction(async (connection) => {
    await ensureCloudSyncOutboxSchema(connection)
    await connection.execute(
      `
        DELETE FROM sync_outbox
        WHERE workspace_id = $1
          AND (
            (state = 'acknowledged' AND acknowledged_at < $2)
            OR (state = 'abandoned' AND updated_at < $2)
          )
      `,
      [workspaceId, cutoff],
    )
  }, scopeForWorkspace(workspaceId, userId))
}
