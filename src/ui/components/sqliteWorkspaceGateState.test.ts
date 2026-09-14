import { describe, expect, it } from 'vitest'

import {
    isSqliteWorkspaceGateOpenForScope,
    requiresSqliteWorkspaceGate,
    resolveSqliteWorkspaceGateState
} from './sqliteWorkspaceGateState'

const scope = {
    workspaceId: 'workspace-1',
    userId: 'user-1'
}

describe('SQLite workspace gate state', () => {
    it('blocks when OPFS readiness fails', () => {
        expect(resolveSqliteWorkspaceGateState('workspace-1:user-1', {
            ready: false,
            scope,
            reason: 'opfs-unavailable',
            message: 'OPFS is unavailable'
        })).toEqual({
            status: 'blocked',
            scopeKey: 'workspace-1:user-1',
            reason: 'opfs-unavailable'
        })
    })

    it('preserves the distinct workspace-owned failure', () => {
        expect(resolveSqliteWorkspaceGateState('workspace-1:user-1', {
            ready: false,
            scope,
            reason: 'workspace-owned',
            message: 'The workspace is open elsewhere'
        })).toEqual({
            status: 'blocked',
            scopeKey: 'workspace-1:user-1',
            reason: 'workspace-owned'
        })
    })

    it('opens only the successfully checked scope', () => {
        const state = resolveSqliteWorkspaceGateState('workspace-1:user-1', {
            ready: true,
            scope
        })
        expect(state).toEqual({
            status: 'open',
            scopeKey: 'workspace-1:user-1'
        })
        expect(isSqliteWorkspaceGateOpenForScope(state, 'workspace-1:user-1')).toBe(true)
        expect(isSqliteWorkspaceGateOpenForScope(state, 'workspace-2:user-1')).toBe(false)
    })

    it('requires verified SQLite for Cloud Sync and Local on every runtime', () => {
        expect(requiresSqliteWorkspaceGate({ dataMode: 'hybrid' })).toBe(true)
        expect(requiresSqliteWorkspaceGate({ dataMode: 'local' })).toBe(true)
        expect(requiresSqliteWorkspaceGate({ dataMode: 'demo' })).toBe(false)
    })
})
