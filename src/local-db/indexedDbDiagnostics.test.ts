import { describe, expect, it } from 'vitest'

import {
  IndexedDbSchemaMismatchError,
  enrichIndexedDbError,
  type IndexedDbDiagnosticContext,
} from './indexedDbDiagnostics'

const context: IndexedDbDiagnosticContext = {
  databaseName: 'AtlasDatabase',
  operation: 'transaction:readwrite',
  requestedStores: ['inventory', 'storage_member_exclusions'],
  expectedStores: ['inventory', 'products', 'storage_member_exclusions'],
  availableStores: ['inventory', 'products'],
  expectedVersion: 129,
  physicalVersion: 1280,
  route: '/pos',
}

describe('IndexedDB diagnostics', () => {
  it('adds the missing store, versions, operation, route, and app version to object-store errors', () => {
    const original = new Error(
      "Failed to execute 'objectStore' on 'IDBTransaction': The specified object store was not found.",
    )
    original.name = 'NotFoundError'

    const enriched = enrichIndexedDbError(original, context)

    expect(enriched).toBeInstanceOf(IndexedDbSchemaMismatchError)
    expect(enriched).toMatchObject({
      name: 'AtlasIndexedDbSchemaMismatchError',
      details: {
        databaseName: 'AtlasDatabase',
        operation: 'transaction:readwrite',
        requestedStores: ['inventory', 'storage_member_exclusions'],
        missingStores: ['storage_member_exclusions'],
        expectedVersion: 129,
        physicalVersion: 128,
        route: '/pos',
      },
    })
    expect((enriched as Error).message).toContain('storage_member_exclusions')
    expect((enriched as Error).message).toContain('128')
    expect((enriched as Error).message).toContain('129')
    expect((enriched as Error & { cause?: unknown }).cause).toBe(original)
  })

  it('does not alter unrelated database errors', () => {
    const original = new Error('Quota exceeded')
    expect(enrichIndexedDbError(original, context)).toBe(original)
  })

  it('does not add the diagnostics twice', () => {
    const original = new Error('The specified object store was not found')
    original.name = 'NotFoundError'
    const enriched = enrichIndexedDbError(original, context)

    expect(enrichIndexedDbError(enriched, context)).toBe(enriched)
  })
})
