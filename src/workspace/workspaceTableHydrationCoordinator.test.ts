import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recordWorkspaceTableHydrationFetch } from './workspaceDataFreshness'
import {
  acquireWorkspaceTableHydration,
  getWorkspaceTableHydrationCoordinatorState,
  resetWorkspaceTableHydrationCoordinatorForTests,
} from './workspaceTableHydrationCoordinator'

function installBrowserStorage() {
  const rows = new Map<string, string>()
  const storage = {
    get length() {
      return rows.size
    },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('workspace table hydration coordinator', () => {
  beforeEach(() => {
    resetWorkspaceTableHydrationCoordinatorForTests()
    installBrowserStorage()
  })

  it('shares six rapid remounts of one table as one remote read', async () => {
    const request = { workspaceId: 'workspace-remounts', tableName: 'products' }
    const work = deferred<boolean>()
    const run = vi.fn(() => work.promise)

    const leases = Array.from({ length: 6 }, () => acquireWorkspaceTableHydration(request, run))

    expect(run).toHaveBeenCalledTimes(1)
    expect(getWorkspaceTableHydrationCoordinatorState()).toEqual({
      runningCount: 1,
      queuedCount: 0,
      jobCount: 1,
    })

    work.resolve(true)
    await expect(Promise.all(leases.map((lease) => lease.promise))).resolves.toEqual([true, true, true, true, true, true])
    leases.forEach((lease) => lease.release())

    await Promise.resolve()
    expect(getWorkspaceTableHydrationCoordinatorState()).toEqual({
      runningCount: 0,
      queuedCount: 0,
      jobCount: 0,
    })
  })

  it('uses scoped freshness and lets a complete snapshot satisfy an active-rows read', async () => {
    const workspaceId = 'workspace-freshness'
    const run = vi.fn(async () => true)

    recordWorkspaceTableHydrationFetch(workspaceId, 'supabase', 'payment_transactions', 'all')
    const activeLease = acquireWorkspaceTableHydration(
      { workspaceId, tableName: 'payment_transactions' },
      run,
    )

    expect(activeLease.isFresh).toBe(true)
    expect(run).not.toHaveBeenCalled()

    recordWorkspaceTableHydrationFetch(workspaceId, 'supabase', 'loans', 'active')
    const allLease = acquireWorkspaceTableHydration(
      { workspaceId, tableName: 'loans', includeDeleted: true },
      run,
    )

    expect(allLease.isFresh).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    activeLease.release()
    await expect(allLease.promise).resolves.toBe(true)
    allLease.release()
  })

  it('aborts a running remote read when its last route consumer leaves', async () => {
    const run = vi.fn((signal: AbortSignal) => new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => resolve(false), { once: true })
    }))
    const lease = acquireWorkspaceTableHydration(
      { workspaceId: 'workspace-cancel', tableName: 'inventory' },
      run,
    )

    expect(run).toHaveBeenCalledTimes(1)
    lease.release()

    await expect(lease.promise).resolves.toBe(false)
    await Promise.resolve()
    expect(getWorkspaceTableHydrationCoordinatorState()).toEqual({
      runningCount: 0,
      queuedCount: 0,
      jobCount: 0,
    })
  })

  it('starts a new read when the user immediately returns after cancellation', async () => {
    const run = vi.fn((signal: AbortSignal) => new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => resolve(false), { once: true })
    }))
    const request = { workspaceId: 'workspace-return', tableName: 'inventory' }
    const abandonedLease = acquireWorkspaceTableHydration(request, run)

    abandonedLease.release()
    const returningLease = acquireWorkspaceTableHydration(request, run)

    expect(run).toHaveBeenCalledTimes(2)
    returningLease.release()
    await expect(Promise.all([abandonedLease.promise, returningLease.promise])).resolves.toEqual([false, false])
  })

  it('limits unrelated table reads to three and starts the next after one completes', async () => {
    const work = Array.from({ length: 4 }, () => deferred<boolean>())
    const runs = work.map((task) => vi.fn(() => task.promise))
    const leases = runs.map((run, index) => acquireWorkspaceTableHydration(
      { workspaceId: 'workspace-queue', tableName: `table_${index}` },
      run,
    ))

    expect(runs.map((run) => run.mock.calls.length)).toEqual([1, 1, 1, 0])
    expect(getWorkspaceTableHydrationCoordinatorState()).toEqual({
      runningCount: 3,
      queuedCount: 1,
      jobCount: 4,
    })

    work[0].resolve(true)
    await leases[0].promise
    await Promise.resolve()

    expect(runs.map((run) => run.mock.calls.length)).toEqual([1, 1, 1, 1])
    work.slice(1).forEach((task) => task.resolve(true))
    await Promise.all(leases.map((lease) => lease.promise))
    leases.forEach((lease) => lease.release())
  })
})
