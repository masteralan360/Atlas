import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  workspacePut: vi.fn(),
  profilePut: vi.fn(),
  clearLocalDemoWorkspaceData: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/local-db/database', () => ({
  db: {
    workspaces: { put: mocks.workspacePut },
    profiles: { put: mocks.profilePut },
  },
}))

vi.mock('./demoCleanup', () => ({
  clearLocalDemoWorkspaceData: mocks.clearLocalDemoWorkspaceData,
}))

vi.mock('@/auth/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: { rpc: mocks.rpc },
}))

import { createDemoWorkspace } from './demoService'

describe('createDemoWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
    mocks.rpc.mockResolvedValue({ error: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers each created demo with the server, where the requester IP is captured', async () => {
    const result = await createDemoWorkspace('IP capture demo', 'general', 15, 'iqd')

    expect(mocks.workspacePut).toHaveBeenCalledWith(expect.objectContaining({
      id: result.workspaceId,
      data_mode: 'demo',
      default_currency: 'iqd',
    }))
    expect(mocks.profilePut).toHaveBeenCalledWith(expect.objectContaining({
      id: result.userId,
      workspaceId: result.workspaceId,
    }))
    expect(mocks.rpc).toHaveBeenCalledWith('insert_demo', {
      p_workspace_id: result.workspaceId,
      p_expires_at: '2026-09-01T12:15:00.000Z',
    })
  })

  it('keeps local demo creation available when server registration fails', async () => {
    const serverError = new Error('Demo registration unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mocks.rpc.mockResolvedValueOnce({ error: serverError })

    await expect(createDemoWorkspace('Offline-safe demo', 'general', 5)).resolves.toMatchObject({
      workspaceName: 'Offline-safe demo',
    })
    await Promise.resolve()

    expect(warn).toHaveBeenCalledWith('[Demo] insert_demo RPC failed (non-fatal):', serverError)
    warn.mockRestore()
  })
})
