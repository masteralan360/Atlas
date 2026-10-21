import { afterEach, describe, expect, it } from 'vitest'
import {
  clearCrudTrace,
  getCrudTraceHistory,
  getCrudTraceSnapshot,
  isCrudDebuggerAvailable,
  runCrudOperation,
  selectCrudTrace,
  setCrudDebuggerEnabled
} from './trace'

describe('CRUD performance trace selection', () => {
  afterEach(() => {
    setCrudDebuggerEnabled(false)
    clearCrudTrace()
  })

  it('keeps the newest operation selected when an older operation completes later', async () => {
    if (!isCrudDebuggerAvailable()) return
    setCrudDebuggerEnabled(true)

    let resolveOlder!: () => void
    const older = runCrudOperation(
      { action: 'delete', entityKey: 'product', entityId: 'older', workspaceMode: 'hybrid' },
      async (trace) => {
        await trace?.measure('stage.remote', 'network', () => new Promise<void>((resolve) => {
          resolveOlder = resolve
        }))
      }
    )

    await Promise.resolve()
    await runCrudOperation(
      { action: 'create', entityKey: 'product', entityId: 'newer', workspaceMode: 'local' },
      async (trace) => {
        await trace?.measure('stage.local', 'persistence', () => Promise.resolve())
      }
    )

    resolveOlder()
    await older

    expect(getCrudTraceSnapshot()).toMatchObject({
      action: 'create',
      entityId: 'newer',
      workspaceMode: 'local',
      status: 'success',
      stages: [{ labelKey: 'stage.local', status: 'success' }]
    })
    expect(getCrudTraceHistory().map((trace) => trace.entityId)).toEqual(['older', 'newer'])
    const olderTrace = getCrudTraceHistory().find((trace) => trace.entityId === 'older')
    expect(olderTrace?.status).toBe('success')
    selectCrudTrace(olderTrace!.id)
    expect(getCrudTraceSnapshot()?.entityId).toBe('older')
  })

  it('records the measured failing stage and operation failure', async () => {
    if (!isCrudDebuggerAvailable()) return
    setCrudDebuggerEnabled(true)

    await expect(runCrudOperation(
      { action: 'update', entityKey: 'product', entityId: 'product-1', workspaceMode: 'cloud' },
      async (trace) => trace?.measure('stage.remote', 'network', () => Promise.reject(new Error('request failed')))
    )).rejects.toThrow('request failed')

    expect(getCrudTraceSnapshot()).toMatchObject({
      status: 'failure',
      stages: [{ labelKey: 'stage.remote', status: 'failure', error: 'Error: request failed' }]
    })
    expect(getCrudTraceHistory()[0]).toMatchObject({ status: 'failure', entityId: 'product-1' })
  })

  it('keeps deferred Cloud and Hybrid synchronization pending while Local mode has no remote stage', async () => {
    if (!isCrudDebuggerAvailable()) return
    setCrudDebuggerEnabled(true)

    for (const workspaceMode of ['cloud', 'hybrid', 'local'] as const) {
      await runCrudOperation(
        { action: 'update', entityKey: 'product', workspaceMode },
        async (trace) => {
          await trace?.measure('stage.local', 'persistence', () => Promise.resolve())
          if (workspaceMode !== 'local') {
            trace?.addPendingStage('stage.syncQueued', 'network', 'crudDebugger.details.queuedForSync')
          }
        }
      )

      const snapshot = getCrudTraceSnapshot()
      expect(snapshot?.workspaceMode).toBe(workspaceMode)
      expect(snapshot?.status).toBe('success')
      if (workspaceMode === 'local') {
        expect(snapshot?.stages).toHaveLength(1)
      } else {
        expect(snapshot?.stages[1]).toMatchObject({
          labelKey: 'stage.syncQueued',
          status: 'pending',
          queuedAt: expect.any(String)
        })
        expect(snapshot?.stages[1]?.durationMs).toBeUndefined()
        expect(snapshot?.stages[1]?.startedAt).toBeUndefined()
      }
    }
  })

  it('does not retain a trace while tracking is disabled', async () => {
    if (!isCrudDebuggerAvailable()) return
    setCrudDebuggerEnabled(false)
    await runCrudOperation({ action: 'read', entityKey: 'product' }, async () => ['cached'])
    expect(getCrudTraceSnapshot()).toBeNull()
  })
})
