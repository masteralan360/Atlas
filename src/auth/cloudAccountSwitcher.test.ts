import { describe, expect, it, vi } from 'vitest'
import {
  CloudAccountSwitchError,
  performCloudAccountSwitch,
  requestCloudWorkspaceAccount,
  requestCloudWorkspaceAccounts,
  type CloudAccountSwitchDependencies,
  type CloudWorkspaceAccount
} from './cloudAccountSwitcher'

const account: CloudWorkspaceAccount = {
  id: 'target-user',
  email: 'target@example.com',
  name: 'Target User',
  role: 'staff',
  profileUrl: null
}

type Identity = {
  id: string
  workspaceId: string
  workspaceMode: 'cloud' | 'hybrid'
}

const currentIdentity: Identity = {
  id: 'current-user',
  workspaceId: 'workspace-1',
  workspaceMode: 'cloud'
}

const previousSession = { id: 'current-session' }
const verifiedSession = { user: { id: 'target-user' }, session: { id: 'target-session' } }

function dependencies(overrides: Partial<CloudAccountSwitchDependencies<Identity, typeof previousSession>> = {}) {
  const calls: string[] = []
  const deps: CloudAccountSwitchDependencies<Identity, typeof previousSession> = {
    isOnline: () => true,
    loadMember: async (workspaceId, userId) => {
      calls.push(`member:${workspaceId}:${userId}`)
      return account
    },
    verifyCredentials: async (email, password) => {
      calls.push(`verify:${email}:${password}`)
      return { credential: verifiedSession }
    },
    completeOutgoingShift: async () => {
      calls.push('close-outgoing')
      return true
    },
    commitSession: async () => {
      calls.push('commit')
      return { id: 'target-session' }
    },
    loadIdentity: async () => {
      calls.push('load-identity')
      return { id: 'target-user', workspaceId: 'workspace-1', workspaceMode: 'cloud' }
    },
    publishIdentity: () => calls.push('publish'),
    confirmIncomingShift: async () => {
      calls.push('check-incoming')
      return true
    },
    restoreIdentity: async () => calls.push('restore'),
    ...overrides
  }
  return { deps, calls }
}

describe('Cloud / Hybrid account switching', () => {
  it('uses the authenticated workspace member endpoint and returns only valid account rows', async () => {
    const invoke = vi.fn(async (_body: Record<string, unknown>) => ({
      data: {
        accounts: [account, { id: 'bad-row', email: 5 }, null]
      },
      error: null
    }))

    await expect(requestCloudWorkspaceAccounts('workspace-1', invoke)).resolves.toEqual([account])
    expect(invoke).toHaveBeenCalledWith({ action: 'list-members', workspaceId: 'workspace-1' })
  })

  it('revalidates a chosen member against the current workspace before password validation', async () => {
    const invoke = vi.fn(async () => ({ data: { account }, error: null }))

    await expect(requestCloudWorkspaceAccount('workspace-1', 'target-user', invoke)).resolves.toEqual(account)
    expect(invoke).toHaveBeenCalledWith({
      action: 'validate-member',
      workspaceId: 'workspace-1',
      userId: 'target-user'
    })
  })

  it('returns a friendly connection error when the member request cannot reach Supabase', async () => {
    const invoke = vi.fn(async () => ({ data: null, error: new Error('Failed to fetch') }))

    await expect(requestCloudWorkspaceAccounts('workspace-1', invoke)).rejects.toMatchObject({
      code: 'connection'
    })
  })

  it('closes the outgoing shift before committing the new session and checking the incoming shift', async () => {
    const { deps, calls } = dependencies()

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: null })

    expect(calls).toEqual([
      'member:workspace-1:target-user',
      'verify:target@example.com:entered-password',
      'close-outgoing',
      'commit',
      'load-identity',
      'publish',
      'check-incoming'
    ])
  })

  it('does not close the outgoing shift or change session when the password is invalid', async () => {
    const { deps, calls } = dependencies({
      verifyCredentials: async () => ({ error: 'credentials' })
    })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'wrong-password'
    }, deps)).resolves.toEqual({ error: 'credentials' })

    expect(calls).toEqual(['member:workspace-1:target-user'])
  })

  it('does not close the outgoing shift when credential validation unexpectedly fails', async () => {
    const { deps, calls } = dependencies({
      verifyCredentials: async () => { throw new Error('connection failed') }
    })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: 'connection' })

    expect(calls).toEqual(['member:workspace-1:target-user'])
  })

  it('rejects offline switching before making a remote request', async () => {
    const { deps, calls } = dependencies({ isOnline: () => false })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: 'offline' })

    expect(calls).toEqual([])
  })

  it('keeps the current account if the outgoing cashier declines handoff', async () => {
  const { deps, calls } = dependencies({
      completeOutgoingShift: async () => {
        calls.push('close-outgoing')
        return false
      }
    })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: 'outgoing_shift_cancelled' })

    expect(calls).toEqual([
      'member:workspace-1:target-user',
      'verify:target@example.com:entered-password',
      'close-outgoing'
    ])
  })

  it('restores the original session if committing the validated session fails', async () => {
    const { deps, calls } = dependencies({
      commitSession: async () => {
        calls.push('commit')
        throw new Error('session commit failed')
      }
    })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: 'failed' })

    expect(calls.slice(-2)).toEqual(['commit', 'restore'])
  })

  it('restores the original account when the incoming user cancels login-shift start', async () => {
    const { deps, calls } = dependencies({
      confirmIncomingShift: async () => {
        calls.push('check-incoming')
        return false
      }
    })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: 'incoming_shift_cancelled' })

    expect(calls.slice(-3)).toEqual(['publish', 'check-incoming', 'restore'])
  })

  it('restores the original account if the authenticated member moves to another workspace', async () => {
    const { deps, calls } = dependencies({
      loadIdentity: async () => {
        calls.push('load-identity')
        return { id: 'target-user', workspaceId: 'workspace-2', workspaceMode: 'cloud' }
      }
    })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: 'workspace_changed' })

    expect(calls.slice(-2)).toEqual(['load-identity', 'restore'])
  })

  it('restores the original account when incoming login-shift lookup fails', async () => {
    const { deps, calls } = dependencies({
      confirmIncomingShift: async () => {
        calls.push('check-incoming')
        throw new Error('remote failure')
      }
    })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: 'failed' })

    expect(calls.slice(-3)).toEqual(['publish', 'check-incoming', 'restore'])
  })

  it('reports when the previous sign-in could not be restored', async () => {
    const { deps } = dependencies({
      confirmIncomingShift: async () => false,
      restoreIdentity: async () => { throw new Error('session restore failed') }
    })

    await expect(performCloudAccountSwitch({
      currentIdentity,
      currentSession: previousSession,
      targetUserId: 'target-user',
      password: 'entered-password'
    }, deps)).resolves.toEqual({ error: 'restore_failed' })
  })

  it('uses a non-technical switch error for unknown failures', () => {
    expect(new CloudAccountSwitchError('failed').message).toBe('failed')
  })
})
