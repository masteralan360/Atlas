import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

import {
  setLocalModeSqliteConnectionForTests,
  type SqliteConnection,
} from '@/local-db/localModeSqlite'

type WasmDatabase = {
  exec: (options: string | {
    sql: string
    bind?: unknown[]
    returnValue?: string
    rowMode?: string
  }) => unknown
  close: () => void
}

/** Install a real in-memory SQLite connection for integration tests. */
export async function installMemorySqliteForTest(): Promise<() => void> {
  const sqlite3 = await sqlite3InitModule()
  const database = new sqlite3.oo1.DB(':memory:', 'ct') as WasmDatabase
  database.exec(`
    CREATE TABLE local_entities (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      workspace_id TEXT,
      payload TEXT NOT NULL,
      updated_at TEXT,
      current_workspace TEXT,
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE INDEX idx_local_entities_workspace
      ON local_entities (workspace_id);
    CREATE INDEX idx_local_entities_type_workspace
      ON local_entities (entity_type, workspace_id);
    CREATE TABLE cashier_shift_active_claims (
      workspace_id TEXT NOT NULL,
      cashier_user_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, cashier_user_id)
    );
  `)
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

  setLocalModeSqliteConnectionForTests(connection)
  return () => {
    setLocalModeSqliteConnectionForTests(undefined)
    database.close()
  }
}
