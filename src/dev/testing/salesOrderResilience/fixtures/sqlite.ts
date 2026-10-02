import initSqlJs, { type Database } from 'sql.js'
import { createRequire } from 'node:module'
import type { SqliteConnection } from '@/local-db/localModeSqlite'

const require = createRequire(import.meta.url)
let runtime: ReturnType<typeof initSqlJs> | undefined
/** Real SQLite SQL/transactions in a disposable WASM database, never the user's native file. */
export class LabSqlite implements SqliteConnection {
    private depth = 0
    constructor(readonly database: Database) {}
    static async open(bytes?: Uint8Array) {
        runtime ??= initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
        const SQL = await runtime
        const sqlite = new LabSqlite(new SQL.Database(bytes))
        await sqlite.execute('CREATE TABLE IF NOT EXISTS local_entities (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, workspace_id TEXT, current_workspace TEXT, payload TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(entity_type, entity_id))')
        return sqlite
    }
    async execute(query: string, values: unknown[] = []) { this.database.run(query, values as (string | number | null)[]); return { rowsAffected: this.database.getRowsModified() } }
    async select<T>(query: string, values: unknown[] = []): Promise<T> {
        const statement = this.database.prepare(query)
        try {
            statement.bind(values as (string | number | null)[])
            const rows = []
            while (statement.step()) rows.push(statement.getAsObject())
            return rows as T
        } finally { statement.free() }
    }
    async transaction<T>(task: (connection: SqliteConnection) => Promise<T>): Promise<T> {
        if (this.depth) return task(this)
        this.depth++
        this.database.run('BEGIN')
        try { const result = await task(this); this.database.run('COMMIT'); return result }
        catch (error) { this.database.run('ROLLBACK'); throw error }
        finally { this.depth-- }
    }
    async close() { this.database.close(); return true }
}
