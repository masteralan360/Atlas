import { getWorkspaceDataMode } from '@/workspace/workspaceMode'

export type CrudAction = 'create' | 'read' | 'update' | 'delete'
export type CrudWorkspaceMode = 'cloud' | 'hybrid' | 'local' | 'demo' | 'unknown'
export type CrudTraceStatus = 'pending' | 'success' | 'failure' | 'cancelled'
export type CrudStageStatus = 'pending' | 'success' | 'failure' | 'cancelled'
export type CrudStageLayer = 'interaction' | 'application' | 'data' | 'network' | 'persistence' | 'response' | 'unknown'

export interface CrudTraceStage {
  id: string
  labelKey: string
  layer: CrudStageLayer
  status: CrudStageStatus
  startedAt?: string
  queuedAt?: string
  endedAt?: string
  durationMs?: number
  details?: string
  detailsKey?: string
  error?: string
}

export interface CrudTraceSnapshot {
  id: string
  action: CrudAction
  entityKey: string
  entityId?: string
  workspaceMode: CrudWorkspaceMode
  status: CrudTraceStatus
  startedAt: string
  endedAt?: string
  durationMs?: number
  stages: CrudTraceStage[]
  error?: string
}

export interface CrudTraceHandle {
  readonly id: string
  measure<T>(
    labelKey: string,
    layer: CrudStageLayer,
    work: () => Promise<T> | T,
    detailsKey?: string
  ): Promise<T>
  addPendingStage(labelKey: string, layer: CrudStageLayer, detailsKey?: string): void
  setEntityId(entityId: string): void
  setWorkspaceMode(mode: CrudWorkspaceMode): void
}

type CrudTraceInput = {
  action: CrudAction
  entityKey: string
  entityId?: string | null
  workspaceId?: string | null
  workspaceMode?: CrudWorkspaceMode
}

const isDevelopment = import.meta.env.DEV
const historyStorageKey = 'atlas:dev:crud-trace-history:v1'
const historyLimit = 20
const emptyHistory: CrudTraceSnapshot[] = []
let enabled = false
let currentTrace: CrudTraceSnapshot | null = null
let completedTraces: CrudTraceSnapshot[] = loadCompletedTraces()
let sequence = 0
const listeners = new Set<() => void>()
const activeTraces = new Map<string, CrudTraceSnapshot>()
const activeStartedMonotonic = new Map<string, number>()

function isTraceSnapshot(value: unknown): value is CrudTraceSnapshot {
  if (!value || typeof value !== 'object') return false
  const trace = value as Partial<CrudTraceSnapshot>
  return typeof trace.id === 'string'
    && (trace.action === 'create' || trace.action === 'read' || trace.action === 'update' || trace.action === 'delete')
    && typeof trace.entityKey === 'string'
    && typeof trace.startedAt === 'string'
    && (trace.status === 'success' || trace.status === 'failure' || trace.status === 'cancelled')
    && Array.isArray(trace.stages)
}

function loadCompletedTraces() {
  if (!isDevelopment || typeof window === 'undefined') return []
  try {
    const stored = window.sessionStorage.getItem(historyStorageKey)
    const parsed: unknown = stored ? JSON.parse(stored) : []
    return Array.isArray(parsed) ? parsed.filter(isTraceSnapshot).slice(0, historyLimit) : []
  } catch {
    return []
  }
}

function persistCompletedTraces() {
  if (!isDevelopment || typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(historyStorageKey, JSON.stringify(completedTraces))
  } catch {
    // Session storage can be unavailable in private or restricted browser contexts.
  }
}

function publish() {
  listeners.forEach((listener) => listener())
}

function monotonicNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function createId() {
  sequence += 1
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${sequence.toString(36)}`
  return `crud-${random}`
}

function safeError(error: unknown) {
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error')
  return `${name}: ${message}`
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted token]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted number]')
    .slice(0, 240)
}

function isCancellation(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError')
}

export function isCrudDebuggerAvailable() {
  return isDevelopment
}

export function isCrudDebuggerEnabled() {
  return isDevelopment && enabled
}

export function setCrudDebuggerEnabled(next: boolean) {
  if (!isDevelopment) return
  enabled = next
  if (!next) {
    currentTrace = null
    activeTraces.clear()
    activeStartedMonotonic.clear()
  } else if (!currentTrace) {
    currentTrace = completedTraces[0] ?? null
  }
  publish()
}

export function clearCrudTrace() {
  if (!isDevelopment) return
  currentTrace = null
  completedTraces = []
  activeTraces.clear()
  activeStartedMonotonic.clear()
  persistCompletedTraces()
  publish()
}

export function subscribeCrudTrace(listener: () => void) {
  if (!isDevelopment) return () => undefined
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCrudTraceSnapshot() {
  return currentTrace
}

export function getCrudTraceHistory() {
  return completedTraces.length ? completedTraces : emptyHistory
}

export function selectCrudTrace(id: string) {
  if (!isCrudDebuggerEnabled()) return
  const trace = activeTraces.get(id) ?? completedTraces.find((item) => item.id === id)
  if (!trace) return
  currentTrace = trace
  publish()
}

export function getCrudTraceElapsedMs() {
  if (!currentTrace) return 0
  if (typeof currentTrace.durationMs === 'number') return currentTrace.durationMs
  const started = activeStartedMonotonic.get(currentTrace.id)
  return typeof started === 'number' ? Math.max(0, monotonicNow() - started) : 0
}

function updateActiveTrace(id: string, update: (trace: CrudTraceSnapshot) => CrudTraceSnapshot) {
  if (!enabled) return
  const activeTrace = activeTraces.get(id)
  if (!activeTrace) return
  const nextTrace = update(activeTrace)
  activeTraces.set(id, nextTrace)
  if (currentTrace?.id === id) currentTrace = nextTrace
  publish()
}

function finishActiveTrace(id: string, update: (trace: CrudTraceSnapshot) => CrudTraceSnapshot) {
  if (!enabled) return
  const activeTrace = activeTraces.get(id)
  if (!activeTrace) return
  const finishedTrace = update(activeTrace)
  activeTraces.delete(id)
  activeStartedMonotonic.delete(id)
  completedTraces = [finishedTrace, ...completedTraces.filter((trace) => trace.id !== id)].slice(0, historyLimit)
  persistCompletedTraces()
  if (currentTrace?.id === id) currentTrace = finishedTrace
  publish()
}

export async function runCrudOperation<T>(
  input: CrudTraceInput,
  execute: (trace: CrudTraceHandle | undefined) => Promise<T> | T
): Promise<T> {
  if (!isCrudDebuggerEnabled()) {
    return execute(undefined)
  }

  const id = createId()
  const started = monotonicNow()
  const initialTrace: CrudTraceSnapshot = {
    id,
    action: input.action,
    entityKey: input.entityKey,
    entityId: input.entityId || undefined,
    workspaceMode: input.workspaceMode ?? (input.workspaceId ? getWorkspaceDataMode(input.workspaceId) : 'unknown'),
    status: 'pending',
    startedAt: new Date().toISOString(),
    stages: []
  }
  activeTraces.set(id, initialTrace)
  activeStartedMonotonic.set(id, started)
  currentTrace = initialTrace
  publish()

  const handle: CrudTraceHandle = {
    id,
    async measure<TStage>(labelKey: string, layer: CrudStageLayer, work: () => Promise<TStage> | TStage, detailsKey?: string) {
      const stageId = createId()
      const stageStart = monotonicNow()
      const stage: CrudTraceStage = {
        id: stageId,
        labelKey,
        layer,
        status: 'pending',
        startedAt: new Date().toISOString(),
        detailsKey
      }
      updateActiveTrace(id, (trace) => ({ ...trace, status: 'pending', stages: [...trace.stages, stage] }))
      try {
        const result = await work()
        const durationMs = Math.max(0, monotonicNow() - stageStart)
        updateActiveTrace(id, (trace) => ({
          ...trace,
          stages: trace.stages.map((item) => item.id === stageId
            ? { ...item, status: 'success', endedAt: new Date().toISOString(), durationMs }
            : item)
        }))
        return result
      } catch (error) {
        const durationMs = Math.max(0, monotonicNow() - stageStart)
        const status = isCancellation(error) ? 'cancelled' : 'failure'
        updateActiveTrace(id, (trace) => ({
          ...trace,
          stages: trace.stages.map((item) => item.id === stageId
            ? { ...item, status, endedAt: new Date().toISOString(), durationMs, error: safeError(error) }
            : item)
        }))
        throw error
      }
    },
    addPendingStage(labelKey, layer, detailsKey) {
      const stage: CrudTraceStage = {
        id: createId(),
        labelKey,
        layer,
        status: 'pending',
        queuedAt: new Date().toISOString(),
        detailsKey
      }
      updateActiveTrace(id, (trace) => ({ ...trace, stages: [...trace.stages, stage] }))
    },
    setWorkspaceMode(mode) {
      updateActiveTrace(id, (trace) => ({ ...trace, workspaceMode: mode }))
    },
    setEntityId(entityId) {
      updateActiveTrace(id, (trace) => ({ ...trace, entityId }))
    }
  }

  try {
    const result = await execute(handle)
    const durationMs = Math.max(0, monotonicNow() - started)
    finishActiveTrace(id, (trace) => ({ ...trace, status: 'success', endedAt: new Date().toISOString(), durationMs }))
    return result
  } catch (error) {
    const durationMs = Math.max(0, monotonicNow() - started)
    const status = isCancellation(error) ? 'cancelled' : 'failure'
    const failedAt = new Date().toISOString()
    finishActiveTrace(id, (trace) => {
      const hasFailureStage = trace.stages.some((stage) => stage.status === 'failure' || stage.status === 'cancelled')
      const failureMarker: CrudTraceStage = {
        id: createId(),
        labelKey: 'crudDebugger.stages.unmeasuredOperationWork',
        layer: 'unknown',
        status,
        endedAt: failedAt,
        error: safeError(error)
      }
      return {
        ...trace,
        status,
        endedAt: failedAt,
        durationMs,
        error: safeError(error),
        stages: hasFailureStage ? trace.stages : [...trace.stages, failureMarker]
      }
    })
    throw error
  }
}
