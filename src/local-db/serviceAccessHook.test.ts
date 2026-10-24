import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A small hook host isolates authorization effects from the app/session. State
// updates are retained between renders; remount explicitly runs effect cleanup.
const host = vi.hoisted(() => ({
  state: undefined as unknown,
  effect: undefined as (() => void | (() => void)) | undefined,
  writes: 0,
  rpc: vi.fn(),
  online: true,
  localMode: false,
  userId: 'cashier-a',
  role: 'staff',
  workspaceId: 'workspace-a',
}))

vi.mock('react', () => ({
  useState: (initial: () => unknown) => {
    if (host.state === undefined) host.state = initial()
    return [host.state, (next: unknown) => {
      host.writes++
      host.state = typeof next === 'function' ? next(host.state) : next
    }]
  },
  useEffect: (effect: () => void | (() => void)) => { host.effect = effect },
}))
vi.mock('@/lib/supabaseSchema', () => ({ getSupabaseClientForTable: () => ({ rpc: host.rpc }) }))
vi.mock('@/lib/network', () => ({
  getActiveBusinessUserId: () => host.userId,
  getActiveBusinessUserRole: () => host.role,
  getActiveBusinessWorkspaceId: () => host.workspaceId,
  isOnline: () => host.online,
}))
vi.mock('@/hooks/useNetworkStatus', () => ({ useNetworkStatus: () => host.online }))
vi.mock('@/workspace/workspaceMode', () => ({ isLocalWorkspaceMode: () => host.localMode }))
vi.mock('@/lib/supabaseRequest', () => ({
  runSupabaseAction: (_label: string, action: () => unknown) => action(),
  normalizeSupabaseActionError: (error: unknown) => error,
}))
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }))
vi.mock('./database', () => {
  const rows = (values: unknown[]) => ({ where: () => ({ equals: () => ({
    filter: () => ({ toArray: async () => values }), toArray: async () => values,
  }) }) })
  return { db: {
    transaction: (...args: unknown[]) => (args[args.length - 1] as () => unknown)(),
    users: { get: async () => ({ workspaceId: host.workspaceId, role: host.role, isDeleted: false }) },
    profiles: { get: async () => undefined },
    products: rows([{ id: 'local-service', isService: true, isDeleted: false }]),
    service_access_category_members: rows([]), service_access_category_services: rows([]),
  } }
})

import { invalidateServiceAccessCache, useServiceAccessIds } from './serviceAccess'

let cleanup: (() => void) | void
const render = () => useServiceAccessIds(host.workspaceId)
const flush = () => vi.advanceTimersByTimeAsync(0)

async function mount() {
  cleanup?.()
  render()
  cleanup = host.effect?.()
  await flush()
  return render()
}

function deferred() {
  let resolve!: (value: { data: string[]; error: null }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ data: string[]; error: null }>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve: (ids: string[]) => resolve({ data: ids, error: null }), reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval, clearInterval }))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  host.state = undefined
  host.writes = 0
  host.online = true
  host.localMode = false
  host.userId = 'cashier-a'
  host.role = 'staff'
  host.workspaceId = 'workspace-a'
  host.rpc.mockReset().mockResolvedValue({ data: ['service-a'], error: null })
  invalidateServiceAccessCache()
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('service authorization refresh lifecycle', () => {
  it('distinguishes a successful empty permission set from a failed lookup', async () => {
    host.rpc.mockResolvedValueOnce({ data: [], error: null })
    expect(await mount()).toMatchObject({ status: 'ready', isReady: true, ids: new Set() })
    host.rpc.mockResolvedValueOnce({ data: null, error: { message: '503 Service Unavailable' } })
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(render()).toMatchObject({ status: 'unavailable', isReady: false, ids: new Set() })
  })

  it.each(['staff', 'admin'])('fails closed for an initial %s request failure', async (role) => {
    host.role = role
    host.rpc.mockRejectedValueOnce(new Error('Network request failed'))
    expect(await mount()).toMatchObject({ status: 'unavailable', isReady: false, ids: new Set() })
  })

  it('recovers after a periodic failure without treating the failure as authorization', async () => {
    expect((await mount()).ids).toEqual(new Set(['service-a']))
    host.rpc.mockRejectedValueOnce(new Error('Expired session'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(render()).toMatchObject({ status: 'unavailable', isReady: false, ids: new Set() })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(render()).toMatchObject({ status: 'ready', isReady: true, ids: new Set(['service-a']) })
  })

  it('handles visibility refresh failures and retries when the window regains focus', async () => {
    await mount()
    host.rpc.mockRejectedValueOnce(new Error('Gateway timeout'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(render().status).toBe('unavailable')
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(render().status).toBe('ready')
  })

  it('blocks offline staff immediately and retains the existing offline admin bypass', async () => {
    await mount()
    host.online = false
    expect(render()).toMatchObject({ status: 'unavailable', isReady: false, ids: new Set() })
    await mount()
    expect(host.rpc).toHaveBeenCalledTimes(1)
    host.role = 'admin'
    expect(render()).toMatchObject({ status: 'ready', isReady: true, ids: null })
  })

  it('continues authorizing offline Local-mode staff from their local data', async () => {
    host.localMode = true
    host.online = false
    expect(await mount()).toMatchObject({ status: 'ready', isReady: true, ids: new Set(['local-service']) })
    expect(host.rpc).not.toHaveBeenCalled()
  })

  it('does not expose the previous user or workspace authorization while the next boundary loads', async () => {
    await mount()
    host.userId = 'cashier-b'
    expect(render()).toMatchObject({ status: 'loading', isReady: false, ids: new Set() })
    host.workspaceId = 'workspace-b'
    expect(render()).toMatchObject({ status: 'loading', isReady: false, ids: new Set() })
  })

  it('ignores an old failure arriving after a newer successful invalidation refresh', async () => {
    const older = deferred()
    const newer = deferred()
    host.rpc.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    await mount()
    invalidateServiceAccessCache(host.workspaceId)
    newer.resolve(['service-b'])
    await flush()
    older.reject(new Error('Old request failed late'))
    await flush()
    expect(render()).toMatchObject({ status: 'ready', isReady: true, ids: new Set(['service-b']) })
  })

  it('ignores an old allow-list arriving after a newer successful denial', async () => {
    const older = deferred()
    const newer = deferred()
    host.rpc.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    await mount()
    invalidateServiceAccessCache(host.workspaceId)
    newer.resolve([])
    await flush()
    older.resolve(['service-a'])
    await flush()
    expect(render()).toMatchObject({ status: 'ready', isReady: true, ids: new Set() })
  })

  it('ignores a late response after unmount', async () => {
    const pending = deferred()
    host.rpc.mockReturnValueOnce(pending.promise)
    await mount()
    cleanup?.()
    cleanup = undefined
    const writesBefore = host.writes
    pending.resolve(['service-a'])
    await flush()
    expect(host.writes).toBe(writesBefore)
  })
})
