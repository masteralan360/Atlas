import { describe, expect, it } from 'vitest'

import {
  canRestoreWorkspaceRecoveryWithoutSession,
  isAuthenticatedState,
  resolveCachedWorkspaceAssignment
} from './authenticationState'

describe('authentication state', () => {
  it('does not authenticate a session before its user identity is ready', () => {
    expect(isAuthenticatedState({
      hasSession: true,
      hasUser: false,
      canRestoreWithoutSession: false
    })).toBe(false)
  })

  it('authenticates a paired online session and user', () => {
    expect(isAuthenticatedState({
      hasSession: true,
      hasUser: true,
      canRestoreWithoutSession: false
    })).toBe(true)
  })

  it('allows an eligible local or offline recovery user without a session', () => {
    expect(isAuthenticatedState({
      hasSession: false,
      hasUser: true,
      canRestoreWithoutSession: true
    })).toBe(true)
  })

  it('does not authenticate an online user without a session or eligible recovery', () => {
    expect(isAuthenticatedState({
      hasSession: false,
      hasUser: true,
      canRestoreWithoutSession: false
    })).toBe(false)
  })
})

describe('offline authentication recovery', () => {
  it('restores Local and Demo independently of the Cloud Sync entitlement window', () => {
    expect(canRestoreWorkspaceRecoveryWithoutSession({
      workspaceId: 'local-workspace',
      workspaceMode: 'local'
    }, false)).toBe(true)
    expect(canRestoreWorkspaceRecoveryWithoutSession({
      workspaceId: 'demo-workspace',
      workspaceMode: 'demo'
    }, false)).toBe(true)
  })

  it('restores Cloud Sync recovery only while offline so SQLite can enforce entitlement age', () => {
    expect(canRestoreWorkspaceRecoveryWithoutSession({
      workspaceId: 'cloud-sync-workspace',
      workspaceMode: 'cloud'
    }, true)).toBe(true)
    expect(canRestoreWorkspaceRecoveryWithoutSession({
      workspaceId: 'cloud-sync-workspace',
      workspaceMode: 'hybrid'
    }, false)).toBe(false)
  })
})

describe('cached workspace assignment recovery', () => {
  it('restores the active workspace from the same user recovery record', () => {
    expect(resolveCachedWorkspaceAssignment({
      authenticatedUserId: 'user-1',
      recoveredUser: {
        id: 'user-1',
        workspaceId: 'workspace-current',
        sourceWorkspaceId: 'workspace-source',
        workspaceCode: 'WS-1',
        workspaceName: 'Workspace 1',
        isConfigured: true,
        workspaceMode: 'cloud'
      }
    })).toEqual({
      sourceWorkspaceId: 'workspace-source',
      currentWorkspaceId: 'workspace-current',
      workspaceCode: 'WS-1',
      workspaceName: 'Workspace 1',
      isConfigured: true,
      workspaceMode: 'hybrid'
    })
  })

  it('does not reuse another signed-in user\'s recovery record', () => {
    expect(resolveCachedWorkspaceAssignment({
      authenticatedUserId: 'user-2',
      recoveredUser: {
        id: 'user-1',
        workspaceId: 'workspace-1'
      }
    })).toBeNull()
  })

  it('supports a verified active local account backed by the online session', () => {
    expect(resolveCachedWorkspaceAssignment({
      authenticatedUserId: 'admin-user',
      recoveredUser: {
        id: 'local-staff-user',
        workspaceId: 'workspace-1',
        sourceWorkspaceId: 'workspace-1',
        workspaceMode: 'hybrid'
      },
      recoveredUserIsActiveLocalAccount: true
    })).toMatchObject({
      sourceWorkspaceId: 'workspace-1',
      currentWorkspaceId: 'workspace-1',
      workspaceMode: 'hybrid'
    })
  })

  it('falls back to the downloaded Dexie profile when recovery storage is unavailable', () => {
    expect(resolveCachedWorkspaceAssignment({
      authenticatedUserId: 'user-1',
      cachedProfile: {
        id: 'user-1',
        workspaceId: 'workspace-source',
        currentWorkspaceId: 'workspace-current'
      }
    })).toEqual({
      sourceWorkspaceId: 'workspace-source',
      currentWorkspaceId: 'workspace-current'
    })
  })
})
