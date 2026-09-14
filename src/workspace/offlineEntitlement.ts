import type { WorkspaceDataMode } from '@/local-db/models'
import {
    runLocalModeSqliteTransaction,
    type LocalModeSqliteScope,
    type SqliteConnection
} from '@/local-db/localModeSqlite'

export const OFFLINE_ENTITLEMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const OFFLINE_ENTITLEMENT_CLOCK_SKEW_MS = 5 * 60 * 1000

export interface OfflineEntitlementLockSnapshot {
    lockedWorkspace: boolean
    subscriptionExpiresAt: string | null
    renewalDueAt: string | null
    hasUsageLimits: boolean
    paymentAccessLocked: boolean
}

export interface OfflineEntitlementSnapshot {
    workspaceId: string
    userId: string
    verifiedAt: string
    lastObservedAt: string
    lock: OfflineEntitlementLockSnapshot
}

export type OfflineEntitlementDecision =
    | { status: 'not-required' }
    | { status: 'valid'; ageMs: number }
    | { status: 'revalidation-required'; reason: 'missing' | 'invalid' | 'expired' | 'clock-changed' }

interface StoredOfflineEntitlementRow {
    workspace_id: string
    user_id: string
    verified_at: string
    last_observed_at: string
    locked_workspace: number
    subscription_expires_at: string | null
    renewal_due_at: string | null
    has_usage_limits: number
    payment_access_locked: number
}

const ENSURE_OFFLINE_ENTITLEMENT_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS workspace_entitlement_verifications (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        locked_workspace INTEGER NOT NULL CHECK (locked_workspace IN (0, 1)),
        subscription_expires_at TEXT,
        renewal_due_at TEXT,
        has_usage_limits INTEGER NOT NULL CHECK (has_usage_limits IN (0, 1)),
        payment_access_locked INTEGER NOT NULL CHECK (payment_access_locked IN (0, 1)),
        PRIMARY KEY (workspace_id, user_id)
    )
`

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string'
}

function normalizeStoredBoolean(value: unknown): boolean | null {
    if (value === 0 || value === false) return false
    if (value === 1 || value === true) return true
    return null
}

function toScope(workspaceId: string, userId: string): LocalModeSqliteScope {
    return { workspaceId, userId }
}

async function ensureOfflineEntitlementSchema(connection: SqliteConnection) {
    await connection.execute(ENSURE_OFFLINE_ENTITLEMENT_SCHEMA_SQL)
    const columns = await connection.select<Array<{ name: string }>>(
        'PRAGMA table_info(workspace_entitlement_verifications)'
    )
    if (!columns.some((column) => column.name === 'last_observed_at')) {
        await connection.execute(
            'ALTER TABLE workspace_entitlement_verifications ADD COLUMN last_observed_at TEXT'
        )
        await connection.execute(`
            UPDATE workspace_entitlement_verifications
            SET last_observed_at = verified_at
            WHERE last_observed_at IS NULL
        `)
    }
}

function parseStoredSnapshot(
    row: StoredOfflineEntitlementRow | undefined,
    workspaceId: string,
    userId: string
): OfflineEntitlementSnapshot | null {
    if (!row || row.workspace_id !== workspaceId || row.user_id !== userId) return null

    const lockedWorkspace = normalizeStoredBoolean(row.locked_workspace)
    const hasUsageLimits = normalizeStoredBoolean(row.has_usage_limits)
    const paymentAccessLocked = normalizeStoredBoolean(row.payment_access_locked)
    if (
        lockedWorkspace === null
        || hasUsageLimits === null
        || paymentAccessLocked === null
        || typeof row.verified_at !== 'string'
        || typeof row.last_observed_at !== 'string'
        || !isNullableString(row.subscription_expires_at)
        || !isNullableString(row.renewal_due_at)
    ) {
        return null
    }

    return {
        workspaceId,
        userId,
        verifiedAt: row.verified_at,
        lastObservedAt: row.last_observed_at,
        lock: {
            lockedWorkspace,
            subscriptionExpiresAt: row.subscription_expires_at,
            renewalDueAt: row.renewal_due_at,
            hasUsageLimits,
            paymentAccessLocked
        }
    }
}

export function evaluateOfflineEntitlement(options: {
    dataMode: WorkspaceDataMode
    snapshot: OfflineEntitlementSnapshot | null
    nowMs?: number
}): OfflineEntitlementDecision {
    if (options.dataMode !== 'hybrid') {
        return { status: 'not-required' }
    }

    if (!options.snapshot) {
        return { status: 'revalidation-required', reason: 'missing' }
    }

    const verifiedAtMs = Date.parse(options.snapshot.verifiedAt)
    const lastObservedAtMs = Date.parse(options.snapshot.lastObservedAt)
    const nowMs = options.nowMs ?? Date.now()
    if (!Number.isFinite(verifiedAtMs) || !Number.isFinite(lastObservedAtMs) || !Number.isFinite(nowMs)) {
        return { status: 'revalidation-required', reason: 'invalid' }
    }

    const ageMs = nowMs - verifiedAtMs
    if (
        ageMs < -OFFLINE_ENTITLEMENT_CLOCK_SKEW_MS
        || nowMs < lastObservedAtMs - OFFLINE_ENTITLEMENT_CLOCK_SKEW_MS
    ) {
        return { status: 'revalidation-required', reason: 'clock-changed' }
    }
    if (ageMs > OFFLINE_ENTITLEMENT_MAX_AGE_MS) {
        return { status: 'revalidation-required', reason: 'expired' }
    }

    return { status: 'valid', ageMs: Math.max(0, ageMs) }
}

export async function readOfflineEntitlementSnapshot(
    workspaceId: string,
    userId: string
): Promise<OfflineEntitlementSnapshot | null> {
    return runLocalModeSqliteTransaction(async (connection) => {
        await ensureOfflineEntitlementSchema(connection)
        const rows = await connection.select<StoredOfflineEntitlementRow[]>(`
            SELECT
                workspace_id,
                user_id,
                verified_at,
                last_observed_at,
                locked_workspace,
                subscription_expires_at,
                renewal_due_at,
                has_usage_limits,
                payment_access_locked
            FROM workspace_entitlement_verifications
            WHERE workspace_id = $1 AND user_id = $2
            LIMIT 1
        `, [workspaceId, userId])

        return parseStoredSnapshot(rows[0], workspaceId, userId)
    }, toScope(workspaceId, userId))
}

export async function writeOfflineEntitlementSnapshot(
    snapshot: OfflineEntitlementSnapshot
): Promise<void> {
    const scope = toScope(snapshot.workspaceId, snapshot.userId)
    await runLocalModeSqliteTransaction(async (connection) => {
        await ensureOfflineEntitlementSchema(connection)
        await connection.execute(`
            INSERT INTO workspace_entitlement_verifications (
                workspace_id,
                user_id,
                verified_at,
                last_observed_at,
                locked_workspace,
                subscription_expires_at,
                renewal_due_at,
                has_usage_limits,
                payment_access_locked
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                verified_at = excluded.verified_at,
                last_observed_at = CASE
                    WHEN excluded.last_observed_at > workspace_entitlement_verifications.last_observed_at
                    THEN excluded.last_observed_at
                    ELSE workspace_entitlement_verifications.last_observed_at
                END,
                locked_workspace = excluded.locked_workspace,
                subscription_expires_at = excluded.subscription_expires_at,
                renewal_due_at = excluded.renewal_due_at,
                has_usage_limits = excluded.has_usage_limits,
                payment_access_locked = excluded.payment_access_locked
            WHERE excluded.verified_at >= workspace_entitlement_verifications.verified_at
        `, [
            snapshot.workspaceId,
            snapshot.userId,
            snapshot.verifiedAt,
            snapshot.lastObservedAt,
            snapshot.lock.lockedWorkspace ? 1 : 0,
            snapshot.lock.subscriptionExpiresAt,
            snapshot.lock.renewalDueAt,
            snapshot.lock.hasUsageLimits ? 1 : 0,
            snapshot.lock.paymentAccessLocked ? 1 : 0
        ])
    }, scope)
}

export async function recordOfflineEntitlementObservation(
    workspaceId: string,
    userId: string,
    observedAt: string
): Promise<void> {
    const observedAtMs = Date.parse(observedAt)
    if (!Number.isFinite(observedAtMs)) return
    await runLocalModeSqliteTransaction(async (connection) => {
        await ensureOfflineEntitlementSchema(connection)
        await connection.execute(`
            UPDATE workspace_entitlement_verifications
            SET last_observed_at = CASE
                    WHEN last_observed_at < $1 THEN $1 ELSE last_observed_at END
            WHERE workspace_id = $2 AND user_id = $3
        `, [observedAt, workspaceId, userId])
    }, toScope(workspaceId, userId))
}
