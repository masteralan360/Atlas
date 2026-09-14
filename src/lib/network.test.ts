import { afterEach, describe, expect, it } from 'vitest'

import {
    isBusinessDataOnline,
    isWorkspaceOutboxOnly,
    setActiveBusinessWorkspace,
    setNetworkStatus,
    setWorkspaceSyncProtocolVersion,
} from './network'

const WORKSPACE_ID = 'protocol-routing-workspace'

afterEach(() => {
    setWorkspaceSyncProtocolVersion(WORKSPACE_ID, 0)
    setActiveBusinessWorkspace(null)
    setNetworkStatus(true)
})

describe('business mutation routing', () => {
    it('routes protocol-v1 workspaces through the SQLite outbox even while connected', () => {
        setNetworkStatus(true)
        setWorkspaceSyncProtocolVersion(WORKSPACE_ID, 1)

        expect(isWorkspaceOutboxOnly(WORKSPACE_ID)).toBe(true)
        expect(isBusinessDataOnline(WORKSPACE_ID)).toBe(false)
    })

    it('keeps compatibility workspaces on direct writes until cutover', () => {
        setNetworkStatus(true)
        setWorkspaceSyncProtocolVersion(WORKSPACE_ID, 0)

        expect(isWorkspaceOutboxOnly(WORKSPACE_ID)).toBe(false)
        expect(isBusinessDataOnline(WORKSPACE_ID)).toBe(true)
    })
})
