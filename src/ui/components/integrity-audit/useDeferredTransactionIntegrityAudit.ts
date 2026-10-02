import { useCallback, useEffect, useRef, useState } from 'react'
import type { TransactionIntegritySeverity } from '@/lib/integrityAudit/severity'

export type TransactionIntegrityAuditPhase =
  | 'idle'
  | 'scheduled'
  | 'running'
  | TransactionIntegritySeverity
  | 'error'

export interface TransactionIntegrityAuditState<TResult> {
  phase: TransactionIntegrityAuditPhase
  result: TResult | null
  errorKey: string | null
}

export interface TransactionIntegrityAuditScheduler {
  requestIdleCallback?: (callback: () => void, timeoutMs: number) => unknown
  cancelIdleCallback?: (handle: unknown) => void
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const browserScheduler: TransactionIntegrityAuditScheduler = {
  requestIdleCallback: typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (callback, timeoutMs) => (window as Window & {
        requestIdleCallback: (handler: () => void, options: { timeout: number }) => number
      }).requestIdleCallback(callback, { timeout: timeoutMs })
    : undefined,
  cancelIdleCallback: typeof window !== 'undefined' && 'cancelIdleCallback' in window
    ? handle => (window as Window & { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(handle as number)
    : undefined,
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function scheduleTransactionIntegrityAudit(
  callback: () => void,
  scheduler: TransactionIntegrityAuditScheduler = browserScheduler
): () => void {
  let cancelled = false
  const run = () => {
    if (!cancelled) callback()
  }

  if (scheduler.requestIdleCallback) {
    const handle = scheduler.requestIdleCallback(run, 2000)
    return () => {
      cancelled = true
      scheduler.cancelIdleCallback?.(handle)
    }
  }

  const handle = scheduler.setTimeout(run, 250)
  return () => {
    cancelled = true
    scheduler.clearTimeout(handle)
  }
}

interface AuditContext<TResult> {
  enabled: boolean
  auditKey: string
  runAudit: () => Promise<TResult>
  getSeverity: (result: TResult) => TransactionIntegritySeverity
}

interface KeyedAuditState<TResult> extends TransactionIntegrityAuditState<TResult> {
  auditKey: string
}

export function useDeferredTransactionIntegrityAudit<TResult>({
  enabled,
  auditKey,
  runAudit,
  getSeverity
}: AuditContext<TResult>) {
  const contextRef = useRef<AuditContext<TResult>>({ enabled, auditKey, runAudit, getSeverity })
  contextRef.current = { enabled, auditKey, runAudit, getSeverity }

  const [state, setState] = useState<KeyedAuditState<TResult>>({
    auditKey,
    phase: 'idle',
    result: null,
    errorKey: null
  })
  const mountedRef = useRef(false)
  const runIdRef = useRef(0)
  const inFlightRef = useRef<{ auditKey: string; promise: Promise<void> } | null>(null)
  const scheduledCancelRef = useRef<(() => void) | null>(null)

  const runNow = useCallback(() => {
    const context = contextRef.current
    if (!context.enabled) return Promise.resolve()

    scheduledCancelRef.current?.()
    scheduledCancelRef.current = null

    const inFlight = inFlightRef.current
    if (inFlight?.auditKey === context.auditKey) return inFlight.promise

    const runId = ++runIdRef.current
    setState({ auditKey: context.auditKey, phase: 'running', result: null, errorKey: null })
    const promise = Promise.resolve()
      .then(context.runAudit)
      .then(result => {
        if (!mountedRef.current || contextRef.current.auditKey !== context.auditKey || runIdRef.current !== runId) return
        setState({ auditKey: context.auditKey, phase: context.getSeverity(result), result, errorKey: null })
      })
      .catch(error => {
        if (!mountedRef.current || contextRef.current.auditKey !== context.auditKey || runIdRef.current !== runId) return
        const errorKey = error && typeof error === 'object' && 'messageKey' in error && typeof error.messageKey === 'string'
          ? error.messageKey
          : 'transactionAudit.loadFailed'
        setState({ auditKey: context.auditKey, phase: 'error', result: null, errorKey })
      })
      .finally(() => {
        if (inFlightRef.current?.auditKey === context.auditKey && runIdRef.current === runId) {
          inFlightRef.current = null
        }
      })

    inFlightRef.current = { auditKey: context.auditKey, promise }
    return promise
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      scheduledCancelRef.current?.()
      scheduledCancelRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setState({ auditKey, phase: 'idle', result: null, errorKey: null })
      return
    }

    setState({ auditKey, phase: 'scheduled', result: null, errorKey: null })
    scheduledCancelRef.current = scheduleTransactionIntegrityAudit(() => {
      scheduledCancelRef.current = null
      void runNow()
    })

    return () => {
      scheduledCancelRef.current?.()
      scheduledCancelRef.current = null
    }
  }, [auditKey, enabled, runNow])

  const currentState = state.auditKey === auditKey
    ? state
    : { auditKey, phase: enabled ? 'scheduled' as const : 'idle' as const, result: null, errorKey: null }

  return {
    ...currentState,
    runNow
  }
}
