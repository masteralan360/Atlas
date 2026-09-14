import { beforeAll, describe, expect, it } from 'vitest'

import { sha256CanonicalJson, type DurableOutboxMutation } from '@/local-db/cloudSyncOutbox'

let buildEnvelope: typeof import('./cloudSyncProtocol').cloudSyncProtocolInternals.buildEnvelope
let buildPullRequest: typeof import('./cloudSyncProtocol').cloudSyncProtocolInternals.buildPullRequest
let normalizeSnapshotRows: typeof import('./cloudSyncProtocol').cloudSyncProtocolInternals.normalizeSnapshotRows
let protocolV1SnapshotEntityTypes: typeof import('./cloudSyncProtocol').cloudSyncProtocolInternals.protocolV1SnapshotEntityTypes

beforeAll(async () => {
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
  const internals = (await import('./cloudSyncProtocol')).cloudSyncProtocolInternals
  buildEnvelope = internals.buildEnvelope
  buildPullRequest = internals.buildPullRequest
  normalizeSnapshotRows = internals.normalizeSnapshotRows
  protocolV1SnapshotEntityTypes = internals.protocolV1SnapshotEntityTypes
})

function mutation(payload: Record<string, unknown>): DurableOutboxMutation {
  return {
    mutationId: '00000000-0000-4000-8000-000000000001',
    localSequence: 1,
    workspaceId: '00000000-0000-4000-8000-000000000002',
    actorId: '00000000-0000-4000-8000-000000000003',
    entityType: 'categories',
    entityId: '00000000-0000-4000-8000-000000000004',
    operation: 'update',
    mutationKind: 'entity',
    mutationType: 'entity.upsert',
    aggregateKey: 'categories:00000000-0000-4000-8000-000000000004',
    groupId: null,
    dependencies: [],
    payloadSchemaVersion: 1,
    payloadHash: '',
    payload,
    baseVersion: 4,
    state: 'leased',
    attemptCount: 1,
    leaseOwner: 'worker-1',
    leaseExpiresAt: '2026-09-14T01:00:00.000Z',
    nextAttemptAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    acknowledgedAt: null,
  }
}

describe('Cloud Sync protocol envelope', () => {
  it('sends the exact recursively canonicalized payload alongside its hash', async () => {
    const payload = {
      z: 1,
      nested: { y: true, a: 'first' },
      list: [{ d: 4, b: 2 }],
    }
    const row = mutation(payload)
    row.payloadHash = await sha256CanonicalJson(payload)

    const envelope = buildEnvelope(
      row,
      '00000000-0000-4000-8000-000000000003',
    )

    expect(envelope.payload_canonical).toBe(
      '{"list":[{"b":2,"d":4}],"nested":{"a":"first","y":true},"z":1}',
    )
    expect(envelope.payload_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(envelope.payload).toEqual(payload)
    expect(JSON.parse(envelope.payload_canonical)).toEqual(payload)
  })

  it('pins snapshot recovery to the exact server adapter contract', () => {
    expect(protocolV1SnapshotEntityTypes).toEqual([
      'categories',
      'category_discounts',
      'price_book_items',
      'price_books',
      'product_barcodes',
      'product_discounts',
      'reorder_transfer_rules',
      'units',
    ])
    expect(normalizeSnapshotRows({
      rows: [{
        entity_type: 'units',
        entity_id: '00000000-0000-4000-8000-000000000010',
        operation: 'upsert',
        entity_version: 3,
        payload: {
          id: '00000000-0000-4000-8000-000000000010',
          workspace_id: '00000000-0000-4000-8000-000000000002',
          code: 'box',
        },
        changed_at: '2026-09-14T00:00:00.000Z',
      }],
    })).toEqual([expect.objectContaining({
      entityType: 'units',
      operation: 'upsert',
      entityVersion: 3,
    })])
    expect(() => normalizeSnapshotRows({
      rows: [{
        entity_type: 'sales',
        entity_id: '00000000-0000-4000-8000-000000000011',
        operation: 'upsert',
        payload: {},
      }],
    })).toThrow('invalid snapshot row')
  })

  it('distinguishes a fresh cursor zero from an installed zero-watermark baseline', () => {
    expect(buildPullRequest('workspace-1', 0, null)).toMatchObject({
      p_after_change_seq: 0,
      p_has_baseline: false,
    })
    expect(buildPullRequest('workspace-1', 0, 0)).toMatchObject({
      p_after_change_seq: 0,
      p_has_baseline: true,
    })
  })
})
