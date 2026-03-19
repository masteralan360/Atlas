import type Dexie from 'dexie'

import { isTauri } from '@/lib/platform'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

const LOCAL_MODE_SQLITE_PATH = 'sqlite:asaas-local-mode.db'

export const LOCAL_MODE_SQLITE_TABLES = [
    'products',
    'categories',
    'invoices',
    'users',
    'sales',
    'sale_items',
    'workspaces',
    'storages',
    'suppliers',
    'customers',
    'employees',
    'budget_settings',
    'budget_allocations',
    'expense_series',
    'expense_items',
    'payroll_statuses',
    'dividend_statuses',
    'workspace_contacts',
    'loans',
    'loan_installments',
    'loan_payments',
    'sales_orders',
    'purchase_orders'
] as const

export type LocalModeSqliteTableName = (typeof LOCAL_MODE_SQLITE_TABLES)[number]

interface SqliteConnection {
    execute(query: string, bindValues?: unknown[]): Promise<unknown>
    select<T>(query: string, bindValues?: unknown[]): Promise<T>
}

interface StoredEntityRow {
    entity_type: LocalModeSqliteTableName
    entity_id: string
    workspace_id: string | null
    payload: string
    updated_at: string | null
}

const hydratedWorkspaces = new Set<string>()
const hydrationTasks = new Map<string, Promise<void>>()

let sqlitePromise: Promise<SqliteConnection | null> | null = null
let sqliteWriteQueue: Promise<void> = Promise.resolve()
let mirroringPauseDepth = 0

function isSupported() {
    return isTauri()
}

function isMirroredTableName(tableName: string): tableName is LocalModeSqliteTableName {
    return (LOCAL_MODE_SQLITE_TABLES as readonly string[]).includes(tableName)
}

function isBlobMarker(value: unknown): value is { __asaasType: 'blob'; mimeType: string; data: string } {
    return !!value
        && typeof value === 'object'
        && (value as { __asaasType?: string }).__asaasType === 'blob'
        && typeof (value as { data?: unknown }).data === 'string'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Object.prototype.toString.call(value) === '[object Object]'
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunkSize = 0x8000

    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    }

    return btoa(binary)
}

function base64ToBlob(base64: string, mimeType: string) {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
    }

    return new Blob([bytes], { type: mimeType || 'application/octet-stream' })
}

async function serializeValue(value: unknown): Promise<unknown> {
    if (value instanceof Blob) {
        return {
            __asaasType: 'blob' as const,
            mimeType: value.type,
            data: arrayBufferToBase64(await value.arrayBuffer())
        }
    }

    if (Array.isArray(value)) {
        return Promise.all(value.map((item) => serializeValue(item)))
    }

    if (isPlainObject(value)) {
        const entries = await Promise.all(
            Object.entries(value).map(async ([key, nested]) => [key, await serializeValue(nested)] as const)
        )

        return Object.fromEntries(entries)
    }

    return value
}

function deserializeValue(value: unknown): unknown {
    if (isBlobMarker(value)) {
        return base64ToBlob(value.data, value.mimeType)
    }

    if (Array.isArray(value)) {
        return value.map((item) => deserializeValue(item))
    }

    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [key, deserializeValue(nested)])
        )
    }

    return value
}

async function ensureConnection() {
    if (!isSupported()) {
        return null
    }

    if (!sqlitePromise) {
        sqlitePromise = (async () => {
            const { default: Database } = await import('@tauri-apps/plugin-sql')
            const connection = await Database.load(LOCAL_MODE_SQLITE_PATH)

            await connection.execute(`
                CREATE TABLE IF NOT EXISTS local_entities (
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    workspace_id TEXT,
                    payload TEXT NOT NULL,
                    updated_at TEXT,
                    PRIMARY KEY (entity_type, entity_id)
                )
            `)
            await connection.execute(`
                CREATE INDEX IF NOT EXISTS idx_local_entities_workspace
                ON local_entities (workspace_id)
            `)
            await connection.execute(`
                CREATE INDEX IF NOT EXISTS idx_local_entities_type_workspace
                ON local_entities (entity_type, workspace_id)
            `)

            return connection as SqliteConnection
        })().catch((error) => {
            sqlitePromise = null
            console.error('[LocalModeSQLite] Failed to initialize SQLite connection:', error)
            return null
        })
    }

    return sqlitePromise
}

function enqueueWrite(task: () => Promise<void>) {
    sqliteWriteQueue = sqliteWriteQueue
        .catch(() => undefined)
        .then(task)
        .catch((error) => {
            console.error('[LocalModeSQLite] Write failed:', error)
        })

    return sqliteWriteQueue
}

async function withMirroringPaused<T>(work: () => Promise<T>) {
    mirroringPauseDepth += 1

    try {
        return await work()
    } finally {
        mirroringPauseDepth = Math.max(0, mirroringPauseDepth - 1)
    }
}

function getEntityId(tableName: LocalModeSqliteTableName, row: Record<string, unknown>) {
    if (tableName === 'workspaces') {
        return typeof row.id === 'string' ? row.id : (typeof row.workspaceId === 'string' ? row.workspaceId : null)
    }

    return typeof row.id === 'string' ? row.id : null
}

async function resolveWorkspaceId(
    cacheDb: Dexie,
    tableName: LocalModeSqliteTableName,
    row: Record<string, unknown>
) {
    if (tableName === 'workspaces') {
        return typeof row.id === 'string'
            ? row.id
            : (typeof row.workspaceId === 'string' ? row.workspaceId : null)
    }

    if (typeof row.workspaceId === 'string') {
        return row.workspaceId
    }

    if (tableName === 'sale_items' && typeof row.saleId === 'string') {
        const sale = await cacheDb.table('sales').get(row.saleId)
        return typeof sale?.workspaceId === 'string' ? sale.workspaceId : null
    }

    return null
}

async function readCacheRowsForWorkspace(
    cacheDb: Dexie,
    tableName: LocalModeSqliteTableName,
    workspaceId: string
) {
    if (tableName === 'workspaces') {
        const workspace = await cacheDb.table(tableName).get(workspaceId)
        return workspace ? [workspace] : []
    }

    if (tableName === 'sale_items') {
        const sales = await cacheDb.table('sales').where('workspaceId').equals(workspaceId).toArray()
        const saleIds = sales
            .map((sale: Record<string, unknown>) => sale.id)
            .filter((saleId): saleId is string => typeof saleId === 'string')

        if (saleIds.length === 0) {
            return []
        }

        return cacheDb.table(tableName).where('saleId').anyOf(saleIds).toArray()
    }

    return cacheDb.table(tableName).where('workspaceId').equals(workspaceId).toArray()
}

async function clearCacheRowsForWorkspace(cacheDb: Dexie, workspaceId: string) {
    const currentSales = await cacheDb.table('sales').where('workspaceId').equals(workspaceId).toArray()
    const currentSaleIds = currentSales
        .map((sale: Record<string, unknown>) => sale.id)
        .filter((saleId): saleId is string => typeof saleId === 'string')

    for (const tableName of LOCAL_MODE_SQLITE_TABLES) {
        if (tableName === 'workspaces') {
            await cacheDb.table(tableName).delete(workspaceId)
            continue
        }

        if (tableName === 'sale_items') {
            if (currentSaleIds.length > 0) {
                await cacheDb.table(tableName).where('saleId').anyOf(currentSaleIds).delete()
            }
            continue
        }

        await cacheDb.table(tableName).where('workspaceId').equals(workspaceId).delete()
    }
}

async function getStoredWorkspaceRowCount(connection: SqliteConnection, workspaceId: string) {
    const rows = await connection.select<Array<{ count: number | string }>>(
        `
            SELECT COUNT(*) AS count
            FROM local_entities
            WHERE workspace_id = $1
               OR (entity_type = 'workspaces' AND entity_id = $1)
        `,
        [workspaceId]
    )

    const count = rows[0]?.count
    return typeof count === 'string' ? Number.parseInt(count, 10) : Number(count ?? 0)
}

async function seedWorkspaceFromDexie(cacheDb: Dexie, workspaceId: string) {
    for (const tableName of LOCAL_MODE_SQLITE_TABLES) {
        const rows = await readCacheRowsForWorkspace(cacheDb, tableName, workspaceId)

        for (const row of rows) {
            await persistEntity(cacheDb, tableName, row as Record<string, unknown>)
        }
    }
}

async function persistEntity(
    cacheDb: Dexie,
    tableName: LocalModeSqliteTableName,
    row: Record<string, unknown>
) {
    const entityId = getEntityId(tableName, row)
    if (!entityId) {
        return
    }

    const workspaceId = await resolveWorkspaceId(cacheDb, tableName, row)
    const shouldPersist = tableName === 'workspaces'
        ? row.data_mode === 'local' || (workspaceId ? isLocalWorkspaceMode(workspaceId) : false)
        : (workspaceId ? isLocalWorkspaceMode(workspaceId) : false)

    if (!shouldPersist) {
        return
    }

    const connection = await ensureConnection()
    if (!connection) {
        return
    }

    const payload = JSON.stringify(await serializeValue(row))
    const updatedAt = typeof row.updatedAt === 'string'
        ? row.updatedAt
        : new Date().toISOString()

    await connection.execute(
        `
            INSERT INTO local_entities (entity_type, entity_id, workspace_id, payload, updated_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                payload = excluded.payload,
                updated_at = excluded.updated_at
        `,
        [tableName, entityId, workspaceId, payload, updatedAt]
    )
}

async function deleteEntity(
    cacheDb: Dexie,
    tableName: LocalModeSqliteTableName,
    row: Record<string, unknown>
) {
    const entityId = getEntityId(tableName, row)
    if (!entityId) {
        return
    }

    const workspaceId = await resolveWorkspaceId(cacheDb, tableName, row)
    const shouldDelete = tableName === 'workspaces'
        ? row.data_mode === 'local' || (workspaceId ? isLocalWorkspaceMode(workspaceId) : false)
        : (workspaceId ? isLocalWorkspaceMode(workspaceId) : false)

    if (!shouldDelete) {
        return
    }

    const connection = await ensureConnection()
    if (!connection) {
        return
    }

    await connection.execute(
        `
            DELETE FROM local_entities
            WHERE entity_type = $1 AND entity_id = $2
        `,
        [tableName, entityId]
    )
}

export async function hydrateLocalModeCacheFromSqlite(
    cacheDb: Dexie,
    workspaceId?: string | null
) {
    if (!workspaceId || !isLocalWorkspaceMode(workspaceId) || !isSupported()) {
        return
    }

    const existingTask = hydrationTasks.get(workspaceId)
    if (existingTask) {
        return existingTask
    }

    if (hydratedWorkspaces.has(workspaceId)) {
        return
    }

    const task = (async () => {
        const connection = await ensureConnection()
        if (!connection) {
            return
        }

        const storedRowCount = await getStoredWorkspaceRowCount(connection, workspaceId)
        if (storedRowCount === 0) {
            await seedWorkspaceFromDexie(cacheDb, workspaceId)
            hydratedWorkspaces.add(workspaceId)
            return
        }

        const rows = await connection.select<StoredEntityRow[]>(
            `
                SELECT entity_type, entity_id, workspace_id, payload, updated_at
                FROM local_entities
                WHERE workspace_id = $1
                   OR (entity_type = 'workspaces' AND entity_id = $1)
                ORDER BY entity_type, updated_at
            `,
            [workspaceId]
        )

        await withMirroringPaused(async () => {
            await clearCacheRowsForWorkspace(cacheDb, workspaceId)

            const groupedRows = new Map<LocalModeSqliteTableName, Record<string, unknown>[]>()
            for (const row of rows) {
                const payload = JSON.parse(row.payload) as unknown
                const revived = deserializeValue(payload) as Record<string, unknown>
                const existingGroup = groupedRows.get(row.entity_type) ?? []
                existingGroup.push(revived)
                groupedRows.set(row.entity_type, existingGroup)
            }

            for (const tableName of LOCAL_MODE_SQLITE_TABLES) {
                const records = groupedRows.get(tableName)
                if (!records?.length) {
                    continue
                }

                await cacheDb.table(tableName).bulkPut(records)
            }
        })

        hydratedWorkspaces.add(workspaceId)
    })().finally(() => {
        hydrationTasks.delete(workspaceId)
    })

    hydrationTasks.set(workspaceId, task)
    return task
}

export function queueLocalModeSqliteUpsert(
    cacheDb: Dexie,
    tableName: string,
    row: Record<string, unknown>
) {
    if (!isSupported() || mirroringPauseDepth > 0 || !isMirroredTableName(tableName)) {
        return
    }

    void enqueueWrite(() => persistEntity(cacheDb, tableName, row))
}

export function queueLocalModeSqliteDelete(
    cacheDb: Dexie,
    tableName: string,
    row: Record<string, unknown>
) {
    if (!isSupported() || mirroringPauseDepth > 0 || !isMirroredTableName(tableName)) {
        return
    }

    void enqueueWrite(() => deleteEntity(cacheDb, tableName, row))
}
