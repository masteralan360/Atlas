import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkNativeSqliteReadiness,
  setLocalModeSqliteConnectionForTests,
  type SqliteConnection,
} from './localModeSqlite'

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

describe('native SQLite readiness', () => {
  let database: WasmDb | null = null

  afterEach(() => {
    setLocalModeSqliteConnectionForTests(undefined)
    database?.close()
    database = null
  })

  it('requires integrity, write/read, and rollback checks before opening', async () => {
    const sqlite3 = await sqlite3InitModule()
    database = new sqlite3.oo1.DB(':memory:', 'ct') as WasmDb
    setLocalModeSqliteConnectionForTests(createConnection(database))

    await expect(checkNativeSqliteReadiness({
      workspaceId: 'workspace-1',
      userId: 'user-1',
    })).resolves.toEqual({
      ready: true,
      scope: { workspaceId: 'workspace-1', userId: 'user-1' },
    })

    const rows = database.exec({
      sql: 'SELECT COUNT(*) AS count FROM atlas_sqlite_readiness_probe',
      returnValue: 'resultRows',
      rowMode: 'object',
    }) as Array<{ count: number }>
    expect(Number(rows[0].count)).toBe(0)
  })

  it('blocks a database that fails quick_check', async () => {
    setLocalModeSqliteConnectionForTests({
      async execute() { return { rowsAffected: 0 } },
      async select<T>() { return [{ quick_check: 'database disk image is malformed' }] as T },
    })

    await expect(checkNativeSqliteReadiness({
      workspaceId: 'workspace-1',
      userId: 'user-1',
    })).resolves.toMatchObject({
      ready: false,
      reason: 'integrity-check-failed',
    })
  })
})
