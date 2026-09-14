import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/local-db/usbBackup', () => ({
    runUsbBackupIfNeeded: vi.fn()
}))

import {
    setLocalModeSqliteConnectionForTests,
    type SqliteConnection
} from '@/local-db/localModeSqlite'
import {
    evaluateOfflineEntitlement,
    OFFLINE_ENTITLEMENT_CLOCK_SKEW_MS,
    OFFLINE_ENTITLEMENT_MAX_AGE_MS,
    readOfflineEntitlementSnapshot,
    writeOfflineEntitlementSnapshot,
    type OfflineEntitlementSnapshot
} from './offlineEntitlement'

type WasmDb = {
    exec: (options: string | {
        sql: string
        bind?: unknown[]
        returnValue?: string
        rowMode?: string
    }) => unknown
    close: () => void
}

const NOW_MS = Date.parse('2026-09-14T12:00:00.000Z')

function snapshot(overrides: Partial<OfflineEntitlementSnapshot> = {}): OfflineEntitlementSnapshot {
    return {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        verifiedAt: new Date(NOW_MS).toISOString(),
        lastObservedAt: new Date(NOW_MS).toISOString(),
        lock: {
            lockedWorkspace: false,
            subscriptionExpiresAt: '2026-10-01T00:00:00.000Z',
            renewalDueAt: null,
            hasUsageLimits: false,
            paymentAccessLocked: false
        },
        ...overrides
    }
}

function createConnection(database: WasmDb): SqliteConnection {
    const connection: SqliteConnection = {
        async execute(query: string, bindValues?: unknown[]) {
            database.exec({ sql: query, bind: bindValues ?? [] })
            return { rowsAffected: 0 }
        },
        async select<T>(query: string, bindValues?: unknown[]) {
            return database.exec({
                sql: query,
                bind: bindValues ?? [],
                returnValue: 'resultRows',
                rowMode: 'object'
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
        }
    }
    return connection
}

describe('offline Cloud Sync entitlement', () => {
    let database: WasmDb

    beforeEach(async () => {
        const sqlite3 = await sqlite3InitModule()
        database = new sqlite3.oo1.DB(':memory:', 'ct') as WasmDb
        setLocalModeSqliteConnectionForTests(createConnection(database))
    })

    afterEach(() => {
        setLocalModeSqliteConnectionForTests(undefined)
        database.close()
    })

    it('accepts a server verification for at most seven days', () => {
        const atBoundary = snapshot({
            verifiedAt: new Date(NOW_MS - OFFLINE_ENTITLEMENT_MAX_AGE_MS).toISOString()
        })

        expect(evaluateOfflineEntitlement({
            dataMode: 'hybrid',
            snapshot: atBoundary,
            nowMs: NOW_MS
        })).toEqual({
            status: 'valid',
            ageMs: OFFLINE_ENTITLEMENT_MAX_AGE_MS
        })

        expect(evaluateOfflineEntitlement({
            dataMode: 'hybrid',
            snapshot: atBoundary,
            nowMs: NOW_MS + 1
        })).toEqual({ status: 'revalidation-required', reason: 'expired' })
    })

    it('blocks missing, invalid, and implausibly future verifications', () => {
        expect(evaluateOfflineEntitlement({
            dataMode: 'hybrid',
            snapshot: null,
            nowMs: NOW_MS
        })).toEqual({ status: 'revalidation-required', reason: 'missing' })

        expect(evaluateOfflineEntitlement({
            dataMode: 'hybrid',
            snapshot: snapshot({ verifiedAt: 'not-a-date' }),
            nowMs: NOW_MS
        })).toEqual({ status: 'revalidation-required', reason: 'invalid' })

        expect(evaluateOfflineEntitlement({
            dataMode: 'hybrid',
            snapshot: snapshot({
                verifiedAt: new Date(NOW_MS + OFFLINE_ENTITLEMENT_CLOCK_SKEW_MS + 1).toISOString()
            }),
            nowMs: NOW_MS
        })).toEqual({ status: 'revalidation-required', reason: 'clock-changed' })

        expect(evaluateOfflineEntitlement({
            dataMode: 'hybrid',
            snapshot: snapshot({
                verifiedAt: new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString(),
                lastObservedAt: new Date(NOW_MS).toISOString()
            }),
            nowMs: NOW_MS - OFFLINE_ENTITLEMENT_CLOCK_SKEW_MS - 1
        })).toEqual({ status: 'revalidation-required', reason: 'clock-changed' })
    })

    it('leaves Local and Demo workspaces unaffected', () => {
        expect(evaluateOfflineEntitlement({
            dataMode: 'local',
            snapshot: null,
            nowMs: NOW_MS
        })).toEqual({ status: 'not-required' })
        expect(evaluateOfflineEntitlement({
            dataMode: 'demo',
            snapshot: null,
            nowMs: NOW_MS
        })).toEqual({ status: 'not-required' })
    })

    it('persists and updates a workspace-and-user-scoped verification in SQLite', async () => {
        const first = snapshot()
        await writeOfflineEntitlementSnapshot(first)

        await expect(readOfflineEntitlementSnapshot('workspace-1', 'user-1')).resolves.toEqual(first)
        await expect(readOfflineEntitlementSnapshot('workspace-1', 'user-2')).resolves.toBeNull()
        await expect(readOfflineEntitlementSnapshot('workspace-2', 'user-1')).resolves.toBeNull()

        const updated = snapshot({
            verifiedAt: new Date(NOW_MS + 1000).toISOString(),
            lastObservedAt: new Date(NOW_MS + 1000).toISOString(),
            lock: {
                ...first.lock,
                lockedWorkspace: true,
                paymentAccessLocked: true
            }
        })
        await writeOfflineEntitlementSnapshot(updated)

        await expect(readOfflineEntitlementSnapshot('workspace-1', 'user-1')).resolves.toEqual(updated)

        await writeOfflineEntitlementSnapshot(snapshot({
            verifiedAt: new Date(NOW_MS - 1000).toISOString(),
            lastObservedAt: new Date(NOW_MS - 1000).toISOString(),
            lock: { ...first.lock, lockedWorkspace: false }
        }))
        await expect(readOfflineEntitlementSnapshot('workspace-1', 'user-1')).resolves.toEqual(updated)
    })
})
