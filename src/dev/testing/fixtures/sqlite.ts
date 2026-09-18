import type { SqliteConnection } from '@/local-db/localModeSqlite'

/** Recording adapter contract only; this is not native SQLite or restart proof. */
export class PosSqliteAdapterStub implements SqliteConnection {
    rows = new Map<string, string>()
    events: string[] = []
    failTable?: string
    async execute(query: string, values: unknown[] = []) {
        if (query.includes('INSERT INTO local_entities')) {
            const table = String(values[0])
            if (table === this.failTable) throw new Error('Injected SQLite write failure')
            this.rows.set(`${table}:${values[1]}`, String(values[4]))
        }
        return { rowsAffected: 1 }
    }
    async select<T>(_query: string, values: unknown[] = []): Promise<T> {
        const payload = this.rows.get(`${values[0]}:${values[1]}`)
        return (payload ? [{ payload }] : []) as T
    }
    async transaction<T>(task: (connection: SqliteConnection) => Promise<T>): Promise<T> {
        const before = new Map(this.rows)
        this.events.push('begin')
        try { const result = await task(this); this.events.push('commit'); return result }
        catch (error) { this.rows = before; this.events.push('rollback'); throw error }
    }
}
