import type {
    PwaSqliteReadiness,
    PwaSqliteReadinessFailure
} from '@/local-db/pwaSqlite'
import type { NativeSqliteReadiness } from '@/local-db/localModeSqlite'

export type SqliteWorkspaceReadinessFailure = PwaSqliteReadinessFailure
    | Exclude<NativeSqliteReadiness, { ready: true }>['reason']

export type SqliteWorkspaceGateState =
    | { status: 'idle' }
    | { status: 'checking'; scopeKey: string }
    | { status: 'open'; scopeKey: string }
    | { status: 'blocked'; scopeKey: string; reason: SqliteWorkspaceReadinessFailure }

export function requiresSqliteWorkspaceGate(options: {
    dataMode?: string
}) {
    return options.dataMode === 'hybrid' || options.dataMode === 'local'
}

export function resolveSqliteWorkspaceGateState(
    scopeKey: string,
    readiness: PwaSqliteReadiness | NativeSqliteReadiness
): SqliteWorkspaceGateState {
    return readiness.ready
        ? { status: 'open', scopeKey }
        : { status: 'blocked', scopeKey, reason: readiness.reason }
}

export function isSqliteWorkspaceGateOpenForScope(
    state: SqliteWorkspaceGateState,
    scopeKey: string
) {
    return state.status === 'open' && state.scopeKey === scopeKey
}
