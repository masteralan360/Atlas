import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Activity, Bug, Check, ChevronDown, CircleAlert, Clock3, Grip, LoaderCircle, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  clearCrudTrace,
  getCrudTraceHistory,
  getCrudTraceSnapshot,
  getCrudTraceElapsedMs,
  isCrudDebuggerEnabled,
  selectCrudTrace,
  setCrudDebuggerEnabled,
  subscribeCrudTrace,
  type CrudStageStatus,
  type CrudTraceStage,
  type CrudTraceStatus
} from './trace'

type Position = { left: number; top: number }
type Size = { width: number; height: number }
type DragOrigin = { pointerId: number; x: number; y: number; left: number; top: number }
type ResizeCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'
type ResizeOrigin = { pointerId: number; corner: ResizeCorner; x: number; y: number; left: number; top: number; width: number; height: number }

const resizeCorners: ResizeCorner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']

function statusIcon(status: CrudStageStatus | CrudTraceStatus) {
  if (status === 'success') return <Check className="h-3.5 w-3.5" aria-hidden="true" />
  if (status === 'failure') return <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
  if (status === 'cancelled') return <X className="h-3.5 w-3.5" aria-hidden="true" />
  return <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
}

function statusTone(status: CrudStageStatus | CrudTraceStatus) {
  if (status === 'success') return 'text-emerald-400'
  if (status === 'failure') return 'text-rose-400'
  if (status === 'cancelled') return 'text-amber-300'
  return 'text-sky-300'
}

function durationLabel(durationMs?: number) {
  return typeof durationMs === 'number' ? `${durationMs.toFixed(1)} ms` : '—'
}

function StageRow({ stage, slowest }: { stage: CrudTraceStage; slowest: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <li className={`rounded-md border ${slowest ? 'border-amber-500/60 bg-amber-500/10' : 'border-slate-700/80 bg-slate-900/60'}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={`shrink-0 ${statusTone(stage.status)}`}>{statusIcon(stage.status)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-slate-100">{t(stage.labelKey)}</span>
          <span className="block truncate text-[10px] text-slate-400">{t(`crudDebugger.layers.${stage.layer}`)}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-slate-200">{durationLabel(stage.durationMs)}</span>
        {slowest && <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-amber-300">{t('crudDebugger.slowest')}</span>}
      </button>
      {expanded && (
        <div className="border-t border-slate-700/80 px-2.5 py-2 text-[10px] text-slate-300">
          <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
            <span className="text-slate-500">{t(stage.startedAt ? 'crudDebugger.started' : stage.queuedAt ? 'crudDebugger.queued' : 'crudDebugger.detected')}</span>
            <time className="font-mono">{stage.startedAt || stage.queuedAt ? new Date(stage.startedAt ?? stage.queuedAt!).toLocaleTimeString() : '—'}</time>
            <span className="text-slate-500">{t('crudDebugger.ended')}</span><span className="font-mono">{stage.endedAt ? new Date(stage.endedAt).toLocaleTimeString() : t('crudDebugger.pending')}</span>
            <span className="text-slate-500">{t('crudDebugger.status')}</span><span className={statusTone(stage.status)}>{t(`crudDebugger.statuses.${stage.status}`)}</span>
          </div>
          {stage.detailsKey && <p className="mt-2 break-words text-slate-400">{t(stage.detailsKey)}</p>}
          {stage.error && <p className="mt-2 break-words text-rose-300">{stage.error}</p>}
        </div>
      )}
    </li>
  )
}

export default function CrudPerformanceDebugger() {
  const { t } = useTranslation()
  const enabled = useSyncExternalStore(subscribeCrudTrace, isCrudDebuggerEnabled, () => false)
  const trace = useSyncExternalStore(subscribeCrudTrace, getCrudTraceSnapshot, () => null)
  const history = useSyncExternalStore(subscribeCrudTrace, getCrudTraceHistory, getCrudTraceHistory)
  const traceId = trace?.id
  const isTracePending = trace?.status === 'pending'
  const [position, setPosition] = useState<Position | null>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [, setElapsedTick] = useState(0)
  const dragOriginRef = useRef<DragOrigin | null>(null)
  const resizeOriginRef = useRef<ResizeOrigin | null>(null)

  useEffect(() => {
    if (!traceId || !isTracePending) return
    const timer = window.setInterval(() => setElapsedTick((value) => value + 1), 100)
    return () => window.clearInterval(timer)
  }, [isTracePending, traceId])

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    dragOriginRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: bounds.left,
      top: bounds.top
    }
    setPosition({ left: bounds.left, top: bounds.top })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current
    if (!origin || origin.pointerId !== event.pointerId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const maxLeft = Math.max(0, window.innerWidth - bounds.width)
    const maxTop = Math.max(0, window.innerHeight - bounds.height)
    setPosition({
      left: Math.max(0, Math.min(maxLeft, origin.left + event.clientX - origin.x)),
      top: Math.max(0, Math.min(maxTop, origin.top + event.clientY - origin.y))
    })
  }

  const handleDragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragOriginRef.current?.pointerId === event.pointerId) dragOriginRef.current = null
  }

  const handleResizeStart = (event: ReactPointerEvent<HTMLButtonElement>, corner: ResizeCorner) => {
    event.preventDefault()
    event.stopPropagation()
    const dialog = event.currentTarget.closest('[role="dialog"]')
    if (!(dialog instanceof HTMLElement)) return
    const bounds = dialog.getBoundingClientRect()
    resizeOriginRef.current = {
      pointerId: event.pointerId,
      corner,
      x: event.clientX,
      y: event.clientY,
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height
    }
    setPosition({ left: bounds.left, top: bounds.top })
    setSize({ width: bounds.width, height: bounds.height })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = resizeOriginRef.current
    if (!origin || origin.pointerId !== event.pointerId) return

    const west = origin.corner === 'topLeft' || origin.corner === 'bottomLeft'
    const north = origin.corner === 'topLeft' || origin.corner === 'topRight'
    const minWidth = Math.min(320, Math.max(1, window.innerWidth - 24))
    const minHeight = Math.min(260, Math.max(1, window.innerHeight - 24))
    let left = origin.left
    let top = origin.top
    let width = origin.width + (west ? origin.x - event.clientX : event.clientX - origin.x)
    let height = origin.height + (north ? origin.y - event.clientY : event.clientY - origin.y)

    if (west) {
      const fixedRight = origin.left + origin.width
      width = Math.max(minWidth, Math.min(width, fixedRight - 12))
      left = fixedRight - width
    } else {
      width = Math.max(minWidth, Math.min(width, window.innerWidth - origin.left - 12))
    }

    if (north) {
      const fixedBottom = origin.top + origin.height
      height = Math.max(minHeight, Math.min(height, fixedBottom - 12))
      top = fixedBottom - height
    } else {
      height = Math.max(minHeight, Math.min(height, window.innerHeight - origin.top - 12))
    }

    setPosition({ left: Math.max(12, left), top: Math.max(12, top) })
    setSize({ width, height })
  }

  const handleResizeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeOriginRef.current?.pointerId === event.pointerId) resizeOriginRef.current = null
  }

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, corner: ResizeCorner) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const dialog = event.currentTarget.closest('[role="dialog"]')
    if (!(dialog instanceof HTMLElement)) return
    const bounds = dialog.getBoundingClientRect()
    const west = corner === 'topLeft' || corner === 'bottomLeft'
    const north = corner === 'topLeft' || corner === 'topRight'
    const step = event.shiftKey ? 32 : 12
    const minWidth = Math.min(320, Math.max(1, window.innerWidth - 24))
    const minHeight = Math.min(260, Math.max(1, window.innerHeight - 24))
    let width = bounds.width
    let height = bounds.height
    let left = bounds.left
    let top = bounds.top

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const grows = (event.key === 'ArrowLeft' && west) || (event.key === 'ArrowRight' && !west)
      width = Math.max(minWidth, Math.min(width + (grows ? step : -step), west ? bounds.right - 12 : window.innerWidth - bounds.left - 12))
      if (west) left = bounds.right - width
    } else {
      const grows = (event.key === 'ArrowUp' && north) || (event.key === 'ArrowDown' && !north)
      height = Math.max(minHeight, Math.min(height + (grows ? step : -step), north ? bounds.bottom - 12 : window.innerHeight - bounds.top - 12))
      if (north) top = bounds.bottom - height
    }

    setPosition({ left: Math.max(12, left), top: Math.max(12, top) })
    setSize({ width, height })
  }

  if (!enabled) {
    return (
      <button
        type="button"
        onClick={() => setCrudDebuggerEnabled(true)}
        className="fixed bottom-3 right-3 z-[10000] inline-flex items-center gap-2 rounded-full border border-slate-600 bg-slate-950/95 px-3 py-2 font-mono text-xs text-slate-100 shadow-xl hover:border-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        aria-label={t('crudDebugger.enable')}
        title={t('crudDebugger.enable')}
      >
        <Bug className="h-4 w-4 text-sky-300" aria-hidden="true" />
        {t('crudDebugger.debugToggle')}
      </button>
    )
  }

  const slowestStage = trace?.stages.reduce<CrudTraceStage | undefined>((slowest, stage) => (
    typeof stage.durationMs === 'number' && (!slowest || stage.durationMs > (slowest.durationMs ?? 0))
      ? stage
      : slowest
  ), undefined)
  const currentDuration = trace ? getCrudTraceElapsedMs() : 0
  const style = {
    ...(position
      ? { left: `${position.left}px`, top: `${position.top}px`, right: 'auto', bottom: 'auto' }
      : { right: '12px', bottom: '56px' }),
    ...(size ? { width: `${size.width}px`, height: `${size.height}px` } : {}),
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: size ? 'calc(100vh - 24px)' : 'min(76vh, 680px)'
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setCrudDebuggerEnabled(false)}
        className="fixed bottom-3 right-3 z-[10000] inline-flex items-center gap-2 rounded-full border border-sky-500/70 bg-slate-950/95 px-3 py-2 font-mono text-xs text-slate-100 shadow-xl hover:border-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        aria-label={t('crudDebugger.disable')}
        title={t('crudDebugger.disable')}
      >
        <Activity className="h-4 w-4 text-sky-300" aria-hidden="true" />
        {t('crudDebugger.debugOn')}
      </button>

      <section
        role="dialog"
        aria-label={t('crudDebugger.title')}
        className="fixed z-[9999] flex w-[min(410px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#080d16] font-mono text-slate-100 shadow-2xl shadow-black/50"
        style={style}
      >
        <div
          className="flex cursor-move touch-none items-center gap-2 border-b border-slate-700 bg-slate-900/90 px-3 py-2.5"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <Bug className="h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold tracking-wide">{t('crudDebugger.title')}</div>
            <div className="text-[9px] uppercase tracking-widest text-slate-500">{t('crudDebugger.devOnly')}</div>
          </div>
          <button type="button" onClick={clearCrudTrace} disabled={!trace && history.length === 0} className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40" aria-label={t('crudDebugger.clear')} title={t('crudDebugger.clear')}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setCrudDebuggerEnabled(false)} className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white" aria-label={t('crudDebugger.disable')} title={t('crudDebugger.disable')}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="border-b border-slate-800">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[10px] text-slate-300 hover:bg-slate-900/70"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
          >
            <span className="min-w-0 flex-1 font-semibold uppercase tracking-widest">{t('crudDebugger.recentOperations')}</span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-slate-400">{history.length}</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${historyOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {historyOpen && (
            <div className="max-h-36 overflow-y-auto px-2 pb-2">
              {history.length ? (
                <ol className="space-y-1">
                  {history.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => selectCrudTrace(item.id)}
                        aria-current={trace?.id === item.id ? 'true' : undefined}
                        className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${trace?.id === item.id ? 'border-sky-500/50 bg-sky-500/10' : 'border-transparent bg-slate-900/50 hover:border-slate-700'}`}
                      >
                        <span className={`shrink-0 ${statusTone(item.status)}`}>{statusIcon(item.status)}</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] text-slate-200">{t(`crudDebugger.actions.${item.action}`)} {t(`crudDebugger.entities.${item.entityKey}`)}</span>
                        <span className="shrink-0 font-mono text-[9px] text-slate-400">{durationLabel(item.durationMs)}</span>
                        <time className="shrink-0 font-mono text-[9px] text-slate-500">{new Date(item.endedAt ?? item.startedAt).toLocaleTimeString()}</time>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="rounded border border-dashed border-slate-800 px-2 py-2 text-center text-[9px] text-slate-500">{t('crudDebugger.noHistory')}</p>
              )}
            </div>
          )}
        </div>

        {!trace ? (
          <div className={`flex flex-col items-center justify-center gap-2 px-6 py-10 text-center ${size ? 'flex-1' : ''}`}>
            <Activity className="h-7 w-7 text-slate-600" aria-hidden="true" />
            <p className="text-xs text-slate-300">{t('crudDebugger.waiting')}</p>
            <p className="text-[10px] leading-relaxed text-slate-500">{t('crudDebugger.waitingHint')}</p>
          </div>
        ) : (
          <div className={`min-h-0 overflow-y-auto p-3 ${size ? 'flex-1' : ''}`}>
            <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 ${statusTone(trace.status)}`}>{statusIcon(trace.status)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white">
                    {t(`crudDebugger.actions.${trace.action}`)} {t(`crudDebugger.entities.${trace.entityKey}`)}
                  </div>
                  {trace.entityId && <div className="mt-0.5 truncate text-[10px] text-slate-500">{t('crudDebugger.entityId')} {trace.entityId}</div>}
                </div>
                <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase ${statusTone(trace.status)} border-current/30`}>
                  {t(`crudDebugger.statuses.${trace.status}`)}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded bg-slate-950/80 p-2">
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">{t('crudDebugger.workspaceMode')}</div>
                  <div className="mt-1 text-xs text-slate-200">{t(`crudDebugger.modes.${trace.workspaceMode}`)}</div>
                </div>
                <div className="rounded bg-slate-950/80 p-2">
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">{t('crudDebugger.totalElapsed')}</div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-200"><Clock3 className="h-3 w-3 text-sky-300" aria-hidden="true" />{durationLabel(currentDuration)}</div>
                </div>
              </div>
              <div className="mt-2 text-[10px] text-slate-500">{t('crudDebugger.started')}: <time>{new Date(trace.startedAt).toLocaleTimeString()}</time></div>
              {trace.error && <p className="mt-2 break-words rounded bg-rose-950/50 p-2 text-[10px] text-rose-200">{trace.error}</p>}
            </div>

            <div className="mt-3 flex items-center justify-between px-0.5">
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{t('crudDebugger.timeline')}</h3>
              <span className="text-[9px] text-slate-500">{t('crudDebugger.correlationId')}: {trace.id.slice(-8)}</span>
            </div>
            {trace.stages.length ? (
              <ol className="mt-2 space-y-1.5">
                {trace.stages.map((stage) => (
                  <StageRow key={stage.id} stage={stage} slowest={stage.id === slowestStage?.id && (slowestStage.durationMs ?? 0) > 0} />
                ))}
              </ol>
            ) : (
              <p className="mt-2 rounded border border-dashed border-slate-700 px-3 py-4 text-center text-[10px] text-slate-500">{t('crudDebugger.noStages')}</p>
            )}
            <p className="mt-3 border-t border-slate-800 pt-2 text-[9px] leading-relaxed text-slate-500">{t('crudDebugger.paintNote')}</p>
          </div>
        )}
        {resizeCorners.map((corner) => {
          const isTop = corner.startsWith('top')
          const isLeft = corner.endsWith('Left')
          const isDiagonalNwse = (isTop && isLeft) || (!isTop && !isLeft)
          return (
            <button
              key={corner}
              type="button"
              className={`absolute ${isTop ? 'top-0' : 'bottom-0'} ${isLeft ? 'left-0' : 'right-0'} z-20 flex h-5 w-5 items-center justify-center border border-slate-700 bg-slate-900/90 text-slate-400 hover:text-sky-300 focus-visible:text-sky-300 focus-visible:outline-none ${isDiagonalNwse ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
              aria-label={t(`crudDebugger.resize.${corner}`)}
              title={t(`crudDebugger.resize.${corner}`)}
              onKeyDown={(event) => handleResizeKeyDown(event, corner)}
              onPointerDown={(event) => handleResizeStart(event, corner)}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeEnd}
              onPointerCancel={handleResizeEnd}
            >
              <Grip className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )
        })}
      </section>
    </>
  )
}
