import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    },
  })
})

import type { SqliteConnection } from './localModeSqlite'
import { setLocalModeSqliteConnectionForTests } from './localModeSqlite'
import { setActiveBusinessUser } from '@/lib/network'
import {
  acknowledgeCloudSyncMutation,
  applyCloudSyncPullPage,
  enqueueCloudSyncMutation,
  finalizeCloudSyncSnapshot,
  leaseCloudSyncOutbox,
  listCloudSyncOutbox,
  pruneAcknowledgedCloudSyncMutations,
  readCloudSyncCursor,
  stageCloudSyncSnapshotPage,
  transitionCloudSyncMutation,
} from './cloudSyncOutbox'

type WasmDb = {
  exec: (options: string | {
    sql: string
    bind?: unknown[]
    returnValue?: string
    rowMode?: string
  }) => unknown
  close: () => void
}

function createConnection(database: WasmDb): SqliteConnection {
  const connection: SqliteConnection = {
    async execute(query, bindValues) {
      database.exec({ sql: query, bind: bindValues ?? [] })
      return { rowsAffected: 0 }
    },
    async select<T>(query: string, bindValues?: unknown[]) {
      return database.exec({
        sql: query,
        bind: bindValues ?? [],
        returnValue: 'resultRows',
        rowMode: 'object',
      }) as T
    },
    async transaction<T>(task: (transactionConnection: SqliteConnection) => Promise<T>) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = await task(connection)
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
  return connection
}

describe('Cloud Sync SQLite outbox', () => {
  let database: WasmDb

  beforeEach(async () => {
    setActiveBusinessUser('user-1')
    const sqlite3 = await sqlite3InitModule()
    database = new sqlite3.oo1.DB(':memory:', 'ct') as WasmDb
    setLocalModeSqliteConnectionForTests(createConnection(database))
  })

  afterEach(() => {
    setActiveBusinessUser(null)
    setLocalModeSqliteConnectionForTests(undefined)
    database.close()
  })

  it('commits the local post-state and outbox intent together', async () => {
    await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'workspace-1',
      actorId: 'user-1',
      entityType: 'categories',
      entityId: 'category-1',
      operation: 'create',
      payload: { id: 'category-1', workspaceId: 'workspace-1', name: 'Food', version: 1 },
    })

    const outbox = await listCloudSyncOutbox('workspace-1')
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({
      localSequence: 1,
      state: 'pending',
      mutationKind: 'entity',
      mutationType: 'entity.upsert',
      baseVersion: 0,
    })
    expect(outbox[0].payloadHash).toMatch(/^[a-f0-9]{64}$/)

    const replica = database.exec({
      sql: `SELECT payload FROM local_entities WHERE entity_type = 'categories' AND entity_id = 'category-1'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload: string }>
    expect(JSON.parse(replica[0].payload)).toMatchObject({
      id: 'category-1',
      workspaceId: 'workspace-1',
      name: 'Food',
      syncStatus: 'pending',
    })
  })

  it('compacts unleased entity edits and cancels an unacknowledged create-delete pair', async () => {
    await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000002',
      workspaceId: 'workspace-1',
      entityType: 'units',
      entityId: 'unit-1',
      operation: 'create',
      payload: { name: 'Box', version: 1 },
    })
    const compacted = await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000003',
      workspaceId: 'workspace-1',
      entityType: 'units',
      entityId: 'unit-1',
      operation: 'update',
      payload: { symbol: 'bx', version: 2 },
    })

    expect(compacted.mutation).toMatchObject({
      mutationId: '00000000-0000-4000-8000-000000000002',
      operation: 'create',
      payload: { name: 'Box', symbol: 'bx' },
    })
    expect(await listCloudSyncOutbox('workspace-1')).toHaveLength(1)

    const cancelled = await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000004',
      workspaceId: 'workspace-1',
      entityType: 'units',
      entityId: 'unit-1',
      operation: 'delete',
      payload: { id: 'unit-1' },
    })
    expect(cancelled.mutation).toBeNull()
    expect(cancelled.removedMutationIds).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ])
    expect(await listCloudSyncOutbox('workspace-1')).toEqual([])
  })

  it('normalizes legacy hard-delete hints and resolves ID-only delete versions from server state', async () => {
    await applyCloudSyncPullPage('workspace-1', [{
      changeSeq: 7,
      entityType: 'units',
      entityId: 'unit-delete',
      operation: 'upsert',
      entityVersion: 4,
      payload: {
        id: 'unit-delete',
        workspace_id: 'workspace-1',
        code: 'box',
        version: 4,
        is_deleted: false,
      },
      changedAt: '2026-01-01T00:00:00.000Z',
      mutationId: null,
    }], 7)

    const result = await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000005',
      workspaceId: 'workspace-1',
      entityType: 'units',
      entityId: 'unit-delete',
      operation: 'delete',
      payload: { id: 'unit-delete', hardDelete: true },
    })

    expect(result.mutation).toMatchObject({
      mutationType: 'entity.delete',
      baseVersion: 4,
      payload: { id: 'unit-delete' },
    })
    expect(result.mutation?.payload).not.toHaveProperty('hard_delete')

    const replica = database.exec({
      sql: `SELECT payload FROM local_entities WHERE entity_type = 'units' AND entity_id = 'unit-delete'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload: string }>
    expect(JSON.parse(replica[0].payload)).toMatchObject({
      id: 'unit-delete',
      isDeleted: true,
      version: 4,
    })

    await acknowledgeCloudSyncMutation(result.mutation!.mutationId, {
      workspaceId: 'workspace-1',
      serverVersion: 5,
      changeSeq: 8,
      entity: {
        id: 'unit-delete',
        workspace_id: 'workspace-1',
        code: 'box',
        version: 5,
        is_deleted: true,
      },
    })
    const acknowledgedReplica = database.exec({
      sql: `SELECT payload FROM local_entities WHERE entity_type = 'units' AND entity_id = 'unit-delete'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload: string }>
    expect(JSON.parse(acknowledgedReplica[0].payload)).toMatchObject({
      id: 'unit-delete',
      isDeleted: true,
      syncStatus: 'synced',
      version: 5,
    })
  })

  it('infers delete bases explicitly for live rows and incremented tombstones', async () => {
    const live = await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000006',
      workspaceId: 'workspace-1',
      entityType: 'categories',
      entityId: 'category-live-delete',
      operation: 'delete',
      payload: { id: 'category-live-delete', version: 4, isDeleted: false },
    })
    const tombstone = await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000007',
      workspaceId: 'workspace-1',
      entityType: 'categories',
      entityId: 'category-tombstone-delete',
      operation: 'delete',
      payload: { id: 'category-tombstone-delete', version: 5, isDeleted: true },
    })

    expect(live.mutation?.baseVersion).toBe(4)
    expect(tombstone.mutation?.baseVersion).toBe(4)
  })

  it('keeps commands immutable and leases independent groups without global blocking', async () => {
    const command = (id: string, aggregateKey: string) => enqueueCloudSyncMutation({
      mutationId: id,
      workspaceId: 'workspace-1',
      actorId: 'user-1',
      entityType: 'loan_commands',
      entityId: id,
      operation: 'create',
      aggregateKey,
      payload: { action: 'payment', payload: { operation_id: id } },
    })
    await command('00000000-0000-4000-8000-000000000010', 'loan:1')
    await command('00000000-0000-4000-8000-000000000011', 'loan:1')
    await command('00000000-0000-4000-8000-000000000012', 'loan:2')

    const firstLease = await leaseCloudSyncOutbox('workspace-1', 'worker-a')
    expect(firstLease.map((row) => row.mutationId)).toEqual([
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000012',
    ])

    await transitionCloudSyncMutation(firstLease[0].mutationId, 'rejected', {
      workspaceId: 'workspace-1',
      errorCode: 'validation_failed',
      errorMessage: 'Invalid payment',
    })
    await transitionCloudSyncMutation(firstLease[1].mutationId, 'acknowledged', {
      workspaceId: 'workspace-1',
    })
    const secondLease = await leaseCloudSyncOutbox('workspace-1', 'worker-b')
    expect(secondLease).toEqual([])
  })

  it('stores pulled snapshots and cursor without overwriting pending local state', async () => {
    await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000020',
      workspaceId: 'workspace-1',
      entityType: 'categories',
      entityId: 'category-1',
      operation: 'update',
      payload: { id: 'category-1', name: 'Local', version: 2 },
      baseVersion: 1,
    })

    const result = await applyCloudSyncPullPage('workspace-1', [{
      changeSeq: 42,
      entityType: 'categories',
      entityId: 'category-1',
      operation: 'upsert',
      entityVersion: 2,
      payload: { id: 'category-1', name: 'Remote', version: 2 },
      changedAt: '2026-01-02T00:00:00.000Z',
      mutationId: null,
    }], 42)

    expect(result.applied).toEqual([])
    expect(result.withheld).toHaveLength(1)
    expect(await readCloudSyncCursor('workspace-1')).toMatchObject({ changeSeq: 42 })

    const replica = database.exec({
      sql: `SELECT payload FROM local_entities WHERE entity_type = 'categories' AND entity_id = 'category-1'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload: string }>
    expect(JSON.parse(replica[0].payload)).toMatchObject({ name: 'Local' })
  })

  it('materializes a consumed withheld change when the local intent is abandoned', async () => {
    const mutationId = '00000000-0000-4000-8000-000000000041'
    await enqueueCloudSyncMutation({
      mutationId,
      workspaceId: 'workspace-1',
      actorId: 'user-1',
      entityType: 'categories',
      entityId: 'category-withheld',
      operation: 'update',
      payload: { id: 'category-withheld', name: 'Local', version: 2 },
      baseVersion: 1,
    })

    const pulled = await applyCloudSyncPullPage('workspace-1', [{
      changeSeq: 9,
      entityType: 'categories',
      entityId: 'category-withheld',
      operation: 'upsert',
      entityVersion: 2,
      payload: {
        id: 'category-withheld',
        workspace_id: 'workspace-1',
        name: 'Server',
        version: 2,
      },
      changedAt: '2026-09-14T00:00:00.000Z',
      mutationId: null,
    }], 9, null, 'user-1')
    expect(pulled.withheld).toHaveLength(1)

    await transitionCloudSyncMutation(mutationId, 'abandoned', {
      workspaceId: 'workspace-1',
      userId: 'user-1',
    })

    const replica = database.exec({
      sql: `SELECT payload FROM local_entities WHERE entity_type = 'categories' AND entity_id = 'category-withheld'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload: string }>
    expect(JSON.parse(replica[0].payload)).toMatchObject({
      name: 'Server',
      workspaceId: 'workspace-1',
      syncStatus: 'synced',
    })
  })

  it('materializes acknowledged server entities as a synced camelCase replica', async () => {
    const mutationId = '00000000-0000-4000-8000-000000000030'
    await enqueueCloudSyncMutation({
      mutationId,
      workspaceId: 'workspace-1',
      entityType: 'categories',
      entityId: 'category-ack',
      operation: 'update',
      payload: {
        id: 'category-ack',
        workspaceId: 'workspace-1',
        name: 'Local',
        localOnlyField: 'must not survive the server replacement',
        version: 2,
      },
      baseVersion: 1,
    })

    await acknowledgeCloudSyncMutation(mutationId, {
      workspaceId: 'workspace-1',
      entity: {
        id: 'category-ack',
        workspace_id: 'workspace-1',
        name: 'Server',
        is_deleted: false,
        updated_at: '2026-01-03T00:00:00.000Z',
        version: 2,
      },
      serverVersion: 2,
      changeSeq: 43,
    })

    const replica = database.exec({
      sql: `SELECT payload FROM local_entities WHERE entity_type = 'categories' AND entity_id = 'category-ack'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload: string }>
    const replicaPayload = JSON.parse(replica[0].payload)
    expect(replicaPayload).toMatchObject({
      id: 'category-ack',
      workspaceId: 'workspace-1',
      name: 'Server',
      isDeleted: false,
      updatedAt: '2026-01-03T00:00:00.000Z',
      syncStatus: 'synced',
      lastSyncedAt: expect.any(String),
      version: 2,
    })
    expect(replicaPayload).not.toHaveProperty('workspace_id')
    expect(replicaPayload).not.toHaveProperty('localOnlyField')
    expect(await readCloudSyncCursor('workspace-1')).toEqual({
      changeSeq: 0,
      snapshotWatermark: null,
    })

    const snapshots = database.exec({
      sql: `SELECT payload_json FROM sync_server_snapshots WHERE entity_type = 'categories' AND entity_id = 'category-ack'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload_json: string }>
    expect(JSON.parse(snapshots[0].payload_json)).toMatchObject({
      workspace_id: 'workspace-1',
      is_deleted: false,
      updated_at: '2026-01-03T00:00:00.000Z',
    })
  })

  it('materializes pulled rows as synced camelCase while retaining raw snapshots', async () => {
    const result = await applyCloudSyncPullPage('workspace-1', [{
      changeSeq: 44,
      entityType: 'categories',
      entityId: 'category-pull',
      operation: 'upsert',
      entityVersion: 3,
      payload: {
        id: 'category-pull',
        workspace_id: 'workspace-1',
        name: 'Pulled',
        is_deleted: false,
        updated_at: '2026-01-04T00:00:00.000Z',
        version: 3,
      },
      changedAt: '2026-01-04T00:00:00.000Z',
      mutationId: null,
    }], 44)

    expect(result.applied).toHaveLength(1)
    const replica = database.exec({
      sql: `SELECT payload FROM local_entities WHERE entity_type = 'categories' AND entity_id = 'category-pull'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload: string }>
    const replicaPayload = JSON.parse(replica[0].payload)
    expect(replicaPayload).toMatchObject({
      workspaceId: 'workspace-1',
      isDeleted: false,
      updatedAt: '2026-01-04T00:00:00.000Z',
      syncStatus: 'synced',
      lastSyncedAt: expect.any(String),
    })
    expect(replicaPayload).not.toHaveProperty('workspace_id')

    const snapshots = database.exec({
      sql: `SELECT payload_json FROM sync_server_snapshots WHERE entity_type = 'categories' AND entity_id = 'category-pull'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload_json: string }>
    expect(JSON.parse(snapshots[0].payload_json)).toMatchObject({
      workspace_id: 'workspace-1',
      is_deleted: false,
      updated_at: '2026-01-04T00:00:00.000Z',
    })
  })

  it('atomically installs a staged snapshot while preserving live local intents', async () => {
    await applyCloudSyncPullPage('workspace-1', [
      {
        changeSeq: 45,
        entityType: 'categories',
        entityId: 'category-stale',
        operation: 'upsert',
        entityVersion: 1,
        payload: { id: 'category-stale', workspace_id: 'workspace-1', name: 'Stale' },
        changedAt: '2026-01-05T00:00:00.000Z',
        mutationId: null,
      },
      {
        changeSeq: 46,
        entityType: 'units',
        entityId: 'unit-stale',
        operation: 'upsert',
        entityVersion: 1,
        payload: { id: 'unit-stale', workspace_id: 'workspace-1', code: 'old' },
        changedAt: '2026-01-05T00:00:00.000Z',
        mutationId: null,
      },
    ], 46)
    await enqueueCloudSyncMutation({
      mutationId: '00000000-0000-4000-8000-000000000035',
      workspaceId: 'workspace-1',
      actorId: 'user-1',
      entityType: 'categories',
      entityId: 'category-pending',
      operation: 'update',
      payload: { id: 'category-pending', workspaceId: 'workspace-1', name: 'Local pending' },
      baseVersion: 1,
    })

    await stageCloudSyncSnapshotPage('workspace-1', 90, [
      {
        entityType: 'categories',
        entityId: 'category-pending',
        operation: 'upsert',
        entityVersion: 2,
        payload: {
          id: 'category-pending',
          workspace_id: 'workspace-1',
          name: 'Remote value',
          updated_at: '2026-01-06T00:00:00.000Z',
        },
        changedAt: '2026-01-06T00:00:00.000Z',
      },
      {
        entityType: 'units',
        entityId: 'unit-current',
        operation: 'upsert',
        entityVersion: 4,
        payload: {
          id: 'unit-current',
          workspace_id: 'workspace-1',
          code: 'box',
          is_dynamic: true,
          updated_at: '2026-01-06T00:00:00.000Z',
        },
        changedAt: '2026-01-06T00:00:00.000Z',
      },
    ], true)

    const projection = await finalizeCloudSyncSnapshot(
      'workspace-1',
      90,
      ['categories', 'units'],
      'user-1',
    )

    const replicaRows = database.exec({
      sql: `SELECT entity_type, entity_id, payload FROM local_entities ORDER BY entity_type, entity_id`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ entity_type: string; entity_id: string; payload: string }>
    expect(replicaRows.map((row) => `${row.entity_type}:${row.entity_id}`)).toEqual([
      'categories:category-pending',
      'units:unit-current',
    ])
    expect(JSON.parse(replicaRows[0].payload)).toMatchObject({
      name: 'Local pending',
      syncStatus: 'pending',
    })
    expect(JSON.parse(replicaRows[1].payload)).toMatchObject({
      workspaceId: 'workspace-1',
      isDynamic: true,
      syncStatus: 'synced',
    })
    expect(projection).toHaveLength(2)
    expect(await readCloudSyncCursor('workspace-1', 'user-1')).toEqual({
      changeSeq: 90,
      snapshotWatermark: 90,
    })

    const rawPendingSnapshot = database.exec({
      sql: `SELECT payload_json FROM sync_server_snapshots WHERE entity_type = 'categories' AND entity_id = 'category-pending'`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ payload_json: string }>
    expect(JSON.parse(rawPendingSnapshot[0].payload_json)).toMatchObject({
      workspace_id: 'workspace-1',
      name: 'Remote value',
    })
    const staged = database.exec({
      sql: `SELECT COUNT(*) AS count FROM sync_snapshot_stage`,
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ count: number }>
    expect(Number(staged[0].count)).toBe(0)
  })

  it('prunes acknowledged and abandoned terminal rows after retention', async () => {
    const mutationIds = [
      '00000000-0000-4000-8000-000000000041',
      '00000000-0000-4000-8000-000000000042',
      '00000000-0000-4000-8000-000000000043',
    ]
    for (const [index, mutationId] of mutationIds.entries()) {
      await enqueueCloudSyncMutation({
        mutationId,
        workspaceId: 'workspace-1',
        actorId: 'user-1',
        entityType: 'categories',
        entityId: `category-retention-${index}`,
        operation: 'update',
        payload: { id: `category-retention-${index}`, version: 2 },
      })
    }
    await transitionCloudSyncMutation(mutationIds[0], 'acknowledged', {
      workspaceId: 'workspace-1',
    })
    await transitionCloudSyncMutation(mutationIds[1], 'abandoned', {
      workspaceId: 'workspace-1',
    })

    await pruneAcknowledgedCloudSyncMutations(
      'workspace-1',
      new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
    )

    expect((await listCloudSyncOutbox('workspace-1')).map((row) => row.mutationId))
      .toEqual([mutationIds[2]])
  })
})
