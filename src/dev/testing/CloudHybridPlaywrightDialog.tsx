import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft, CheckCircle2, Circle, CircleDashed, Download, FlaskConical, ListChecks, Loader2, Play, Route, ShieldCheck, Square, XCircle } from 'lucide-react'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Button
} from '@/ui/components'
import { cn } from '@/lib/utils'
import { cloudHybridPlaywrightClient, normalizeCloudHybridScenarioMode, type CloudHybridPreflight, type CloudHybridRun, type CloudHybridScenarioPlanItem, type CloudHybridScenarioSelection, type CloudHybridStatus, type CloudHybridSuiteId } from './CloudHybridPlaywrightClient'

const statusIcon = {
    pending: Circle,
    running: Loader2,
    planned: ListChecks,
    passed: CheckCircle2,
    failed: XCircle,
    blocked: AlertTriangle,
    cancelled: Square,
    skipped: CircleDashed
}

function StatusIcon({ status }: { status: CloudHybridStatus }) {
    const Icon = statusIcon[status]
    return <Icon aria-hidden className={cn(
        'h-4 w-4 shrink-0',
        status === 'running' && 'animate-spin',
        status === 'passed' && 'text-emerald-600',
        status === 'planned' && 'text-primary',
        status === 'failed' && 'text-destructive',
        status === 'blocked' && 'text-amber-600',
        status === 'skipped' && 'text-muted-foreground'
    )} />
}

export default function CloudHybridPlaywrightDialog({
    suiteId,
    open,
    onOpenChange,
    onBack
}: {
    suiteId: CloudHybridSuiteId
    open: boolean
    onOpenChange: (open: boolean) => void
    onBack: () => void
}) {
    const { t, i18n } = useTranslation()
    const copyKey = useCallback((suffix: string) => {
        if (suiteId === 'pos') return `devTesting.cloudHybrid.${suffix}`
        const salesOrderKey = `devTesting.salesOrderHybrid.${suffix}`
        return i18n.exists(salesOrderKey) ? salesOrderKey : `devTesting.cloudHybrid.${suffix}`
    }, [i18n, suiteId])
    const [preflight, setPreflight] = useState<CloudHybridPreflight | null>(null)
    const [run, setRun] = useState<CloudHybridRun | null>(null)
    const [timeline, setTimeline] = useState<CloudHybridScenarioPlanItem[]>([])
    const [timelineReady, setTimelineReady] = useState(false)
    const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null)
    const [timelineDigitalMethodId, setTimelineDigitalMethodId] = useState<string | null>(null)
    const [timelineDragging, setTimelineDragging] = useState(false)
    const [loading, setLoading] = useState(true)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const busy = submitting || run?.status === 'running'
    const mounted = useRef(true)
    const timelineDrag = useRef<{ pointerId: number; startX: number; startScrollLeft: number; element: HTMLDivElement; moved: boolean } | null>(null)
    const suppressTimelineClick = useRef(false)
    const format = useCallback((value: number) => new Intl.NumberFormat(i18n.language).format(value), [i18n.language])
    const progress = run?.totalScenarios ? Math.round(run.currentIndex / run.totalScenarios * 100) : 0

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            const drag = timelineDrag.current
            if (!drag || drag.pointerId !== event.pointerId) return
            const distance = event.clientX - drag.startX
            if (!drag.moved && Math.abs(distance) < 4) return
            if (!drag.moved) {
                drag.moved = true
                setTimelineDragging(true)
            }
            drag.element.scrollLeft = drag.startScrollLeft - distance
            event.preventDefault()
        }
        const finishPointerDrag = (event: PointerEvent) => {
            const drag = timelineDrag.current
            if (!drag || drag.pointerId !== event.pointerId) return
            timelineDrag.current = null
            setTimelineDragging(false)
            if (drag.moved) {
                suppressTimelineClick.current = true
                window.setTimeout(() => { suppressTimelineClick.current = false }, 0)
            }
        }
        window.addEventListener('pointermove', handlePointerMove, { passive: false })
        window.addEventListener('pointerup', finishPointerDrag)
        window.addEventListener('pointercancel', finishPointerDrag)
        return () => {
            window.removeEventListener('pointermove', handlePointerMove)
            window.removeEventListener('pointerup', finishPointerDrag)
            window.removeEventListener('pointercancel', finishPointerDrag)
        }
    }, [])

    useEffect(() => {
        if (!open) return
        let timer: ReturnType<typeof setTimeout>
        let stopped = false
        const refresh = async () => {
            try {
                const snapshot = await cloudHybridPlaywrightClient.current(suiteId)
                if (stopped) return
                const ownedRun = snapshot.run?.suiteId === suiteId ? snapshot.run : null
                setRun(ownedRun)
                const activeSnapshotRun = ownedRun
                const plan = activeSnapshotRun?.scenarioPlan ?? []
                if (activeSnapshotRun && plan.length) {
                    setTimeline(plan)
                    setTimelineReady(!activeSnapshotRun.planOnly || activeSnapshotRun.status === 'planned')
                    setSelectedScenarioId((selected) => plan.some((scenario) => scenario.id === selected)
                        ? selected
                        : plan[0].id)
                    if (activeSnapshotRun.scenarioDimensions) {
                        setTimelineDigitalMethodId(activeSnapshotRun.scenarioDimensions.selectedDigitalPaymentMethod?.id ?? null)
                    }
                }
                if (!snapshot.run || snapshot.run.status !== 'running') {
                    const readiness = await cloudHybridPlaywrightClient.preflight(suiteId)
                    if (stopped) return
                    setPreflight(readiness)
                    setError(readiness.status === 'blocked' ? readiness.reason ?? copyKey('preflightFailed') : null)
                } else {
                    setPreflight({ status: 'ready', target: ownedRun?.target ?? undefined })
                    setError(null)
                }
            } catch (cause) {
                if (!stopped) {
                    setError(cause instanceof Error ? cause.message : t(copyKey('connectionFailed')))
                    setPreflight({ status: 'blocked', reason: copyKey('connectionFailed') })
                }
            } finally {
                if (!stopped) {
                    setLoading(false)
                    timer = setTimeout(refresh, run?.status === 'running' ? 1000 : 5000)
                }
            }
        }
        void refresh()
        return () => { stopped = true; clearTimeout(timer) }
    }, [copyKey, open, run?.status, suiteId, t])

    const start = async (mode?: CloudHybridScenarioSelection['mode']) => {
        if (submitting || busy || preflight?.status !== 'ready') return
        const selectedMode = normalizeCloudHybridScenarioMode(mode)
        const selectedScenario = selectedMode !== 'all' ? timeline.find((scenario) => scenario.id === selectedScenarioId) : null
        if (mode && mode !== 'all' && !selectedScenario) return
        if (suiteId === 'sales-order-resilience' && !run?.scenarioPlanId) return
        if (suiteId === 'sales-order-resilience' && selectedMode !== 'all' && selectedScenario?.status !== 'pending') return
        if (suiteId === 'sales-order-resilience' && selectedMode === 'all' && !timeline.some((scenario) => scenario.status === 'pending')) return
        setSubmitting(true)
        setError(null)
        try {
            const scenarioSelection: CloudHybridScenarioSelection | undefined = suiteId === 'sales-order-resilience'
                ? selectedMode === 'from' || selectedMode === 'only'
                    ? { mode: selectedMode, planId: run!.scenarioPlanId, scenarioId: selectedScenario!.id, signature: selectedScenario!.signature }
                    : { mode: selectedMode, planId: run!.scenarioPlanId }
                : selectedMode !== 'all' && selectedScenario
                    ? { mode: selectedMode, scenarioId: selectedScenario.id, signature: selectedScenario.signature, digitalPaymentMethodId: timelineDigitalMethodId }
                    : undefined
            const result = await cloudHybridPlaywrightClient.start(window.location.origin, suiteId, scenarioSelection)
            if (mounted.current) setRun(result.run)
        } catch (cause) {
            if (mounted.current) setError(cause instanceof Error ? cause.message : t(copyKey('startFailed')))
        } finally {
            if (mounted.current) setSubmitting(false)
        }
    }

    const prepareTimeline = async () => {
        if (submitting || busy || preflight?.status !== 'ready') return
        setSubmitting(true)
        setError(null)
        try {
            const result = await cloudHybridPlaywrightClient.prepare(window.location.origin, suiteId)
            if (mounted.current) setRun(result.run)
        } catch (cause) {
            if (mounted.current) setError(cause instanceof Error ? cause.message : t(copyKey('planFailed')))
        } finally {
            if (mounted.current) setSubmitting(false)
        }
    }

    const cancel = async () => {
        if (!run || submitting || run.cancelRequested) return
        setSubmitting(true)
        try {
            const result = await cloudHybridPlaywrightClient.cancel(suiteId, run.id)
            if (mounted.current && result.run) setRun(result.run)
        } catch (cause) {
            if (mounted.current) setError(cause instanceof Error ? cause.message : t(copyKey('cancelFailed')))
        } finally {
            if (mounted.current) setSubmitting(false)
        }
    }

    const download = () => {
        if (!run || busy) return
        const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `atlas-cloud-hybrid-playwright-${run.id}.json`
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
    }

    const blockClose = (event: { preventDefault: () => void }) => { if (busy) event.preventDefault() }
    const finishedScenarios = run?.results.length ?? 0
    const selectedScenario = timeline.find((scenario) => scenario.id === selectedScenarioId) ?? null
    const canStartSelected = timelineReady && !loading && !busy && !submitting && preflight?.status === 'ready'
        && (suiteId !== 'sales-order-resilience' || (!!run?.scenarioPlanId && selectedScenario?.status === 'pending'))
    const canRunAll = suiteId === 'sales-order-resilience'
        ? !loading && !busy && !submitting && preflight?.status === 'ready' && !!run?.scenarioPlanId
            && timeline.some((scenario) => scenario.status === 'pending')
        : !loading && !busy && preflight?.status === 'ready'
    const canPrepareTimeline = !loading && !busy && !submitting && preflight?.status === 'ready'
    const scenarioDomainLabel = (domain: string) => t(copyKey(`domain.${domain}`), { defaultValue: domain })
    const scenarioLabel = (scenario: CloudHybridScenarioPlanItem) => scenario.titleKey
        ? t(scenario.titleKey, { defaultValue: scenario.name })
        : scenario.name

    return <AppDialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
        <AppDialogContent className="max-w-5xl" showCloseButton={!busy} onInteractOutside={blockClose} onEscapeKeyDown={blockClose}>
            <AppDialogHeader>
                <AppDialogTitle className="flex items-center gap-2"><FlaskConical className="h-5 w-5" />{t(copyKey('label'))}</AppDialogTitle>
                <AppDialogDescription>{t(copyKey('description'))}</AppDialogDescription>
            </AppDialogHeader>
            <AppDialogBody className="space-y-4">
                <div className="flex gap-3 rounded-xl border border-emerald-600/20 bg-emerald-600/5 p-3 text-sm">
                    <ShieldCheck className="h-5 w-5 shrink-0" />
                    <p>{t(copyKey('independent'))}</p>
                </div>
                {loading && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t(copyKey('checking'))}</p>}
                {!loading && preflight?.status === 'ready' && preflight.target && (
                    <div role="status" className="rounded-xl border p-3 text-sm">
                        {t(copyKey('ready'), {
                            name: preflight.target.workspaceName,
                            mode: preflight.target.mode,
                            host: preflight.target.supabaseHost
                        })}
                    </div>
                )}
                {suiteId === 'sales-order-resilience' && preflight?.capabilities && (
                    <section className="space-y-2 rounded-xl border p-3 text-sm" aria-label={t(copyKey('capabilitiesTitle'))}>
                        <h2 className="font-medium">{t(copyKey('capabilitiesTitle'))}</h2>
                        <p className="text-xs text-muted-foreground">{t(copyKey('capabilitiesHelp'))}</p>
                        <div className="flex flex-wrap gap-2">
                            {preflight.capabilities.available.map((capability) => <span key={capability} className="rounded-full border border-emerald-600/30 bg-emerald-600/5 px-2 py-1 text-xs">{t(copyKey(`capabilities.${capability}`), { defaultValue: capability })}</span>)}
                            {preflight.capabilities.unavailable.map((capability) => <span key={capability.id} title={capability.reason.startsWith('devTesting.') ? t(capability.reason) : capability.reason} className="rounded-full border border-amber-600/30 bg-amber-600/5 px-2 py-1 text-xs">{t(copyKey(`capabilities.${capability.id}`), { defaultValue: capability.id })}: {capability.reason.startsWith('devTesting.') ? t(capability.reason) : capability.reason}</span>)}
                        </div>
                    </section>
                )}
                {error && <p role="alert" className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{error.startsWith('devTesting.') ? t(error) : error}</p>}
                <section className="space-y-4 rounded-2xl border bg-gradient-to-br from-muted/40 via-background to-primary/[0.04] p-4" aria-label={t(copyKey('timelineTitle'))}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                            <span className="rounded-xl border bg-background p-2 text-primary shadow-sm"><Route className="h-5 w-5" /></span>
                            <div className="space-y-1">
                                <h2 className="text-sm font-semibold">{t(copyKey('timelineTitle'))}</h2>
                                <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
                                    {timeline.length
                                        ? t(copyKey('timelineHelp'))
                                        : busy ? t(copyKey('timelineBuilding')) : t(copyKey('timelineFirstRun'))}
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {timeline.length > 0 && <span className="rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
                                {t(copyKey('timelineCount'), { count: timeline.length, formattedCount: format(timeline.length) })}
                            </span>}
                            {timeline.length > 0 && <Button type="button" size="sm" variant="outline" allowViewer disabled={!canPrepareTimeline} onClick={() => void prepareTimeline()}>
                                {submitting ? <Loader2 className="animate-spin" /> : <Route />}
                                {t(copyKey('timelineRefresh'))}
                            </Button>}
                        </div>
                    </div>
                    {timeline.length > 0 ? <>
                        <div
                            dir="ltr"
                            className={cn('overflow-x-auto pb-2 touch-pan-x select-none', timelineDragging ? 'cursor-grabbing' : 'cursor-grab')}
                            tabIndex={0}
                            aria-label={t(copyKey('timelineScroll'))}
                            onPointerDown={(event) => {
                                if (event.pointerType !== 'mouse' || event.button !== 0) return
                                timelineDrag.current = {
                                    pointerId: event.pointerId,
                                    startX: event.clientX,
                                    startScrollLeft: event.currentTarget.scrollLeft,
                                    element: event.currentTarget,
                                    moved: false
                                }
                            }}
                            onClickCapture={(event) => {
                                if (!suppressTimelineClick.current) return
                                suppressTimelineClick.current = false
                                event.preventDefault()
                                event.stopPropagation()
                            }}
                            onDragStart={(event) => event.preventDefault()}
                        >
                            <div className="relative w-max min-w-full pt-1">
                                <div aria-hidden className="absolute left-8 right-8 top-5 h-px bg-gradient-to-r from-border via-primary/40 to-border" />
                                <ol className="relative flex items-start">
                                    {timeline.map((scenario, index) => {
                                        const selected = scenario.id === selectedScenarioId
                                        return <li key={`${scenario.id}-${index}`} className="w-56 shrink-0 px-2">
                                            <button
                                                type="button"
                                                aria-pressed={selected}
                                                title={scenarioLabel(scenario)}
                                                disabled={busy}
                                                onClick={() => setSelectedScenarioId(scenario.id)}
                                                className={cn(
                                                    'group flex w-full flex-col items-center rounded-xl text-left outline-none transition focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70',
                                                    selected && 'text-primary'
                                                )}
                                            >
                                                <span className={cn(
                                                    'relative z-10 grid h-9 w-9 place-items-center rounded-full border-2 bg-background shadow-sm transition',
                                                    selected ? 'border-primary ring-4 ring-primary/10' : 'border-border group-hover:border-primary/60',
                                                    scenario.status === 'passed' && 'border-emerald-600/70',
                                                    scenario.status === 'failed' && 'border-destructive/70',
                                                    scenario.status === 'blocked' && 'border-amber-600/70'
                                                )}>
                                                    <StatusIcon status={scenario.status} />
                                                </span>
                                                <span className={cn(
                                                    'mt-3 flex min-h-28 w-full flex-col rounded-xl border bg-background/90 p-3 shadow-sm transition group-hover:border-primary/40 group-hover:shadow',
                                                    selected && 'border-primary/50 bg-primary/[0.035] shadow-md'
                                                )}>
                                                    <span className="flex items-center justify-between gap-2">
                                                        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                            {t(copyKey('scenarioNumber'), { number: format(index + 1) })}
                                                        </span>
                                                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                                            {scenarioDomainLabel(scenario.domain)}
                                                        </span>
                                                    </span>
                                                    <span className="mt-2 line-clamp-3 text-xs font-medium leading-relaxed text-foreground">{scenarioLabel(scenario)}</span>
                                                    <span className="mt-auto flex items-center gap-1 pt-2 text-[10px] text-muted-foreground">
                                                        <StatusIcon status={scenario.status} />
                                                        {t(copyKey(`status.${scenario.status}`), { defaultValue: scenario.status })}
                                                    </span>
                                                </span>
                                            </button>
                                        </li>
                                    })}
                                </ol>
                            </div>
                        </div>
                        {selectedScenario && <div className="flex flex-col gap-3 rounded-xl border bg-background/80 p-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t(copyKey('selectedScenario'))}</p>
                                <p className="mt-1 text-sm font-medium">{scenarioLabel(selectedScenario)}</p>
                                {selectedScenario.descriptionKey && <p className="mt-1 text-xs text-muted-foreground">{t(selectedScenario.descriptionKey)}</p>}
                                {selectedScenario.coverage?.length ? <div className="mt-2 flex flex-wrap gap-1">{selectedScenario.coverage.map((tag) => <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{t(copyKey(`coverage.${tag}`), { defaultValue: tag })}</span>)}</div> : null}
                                {selectedScenario.statusReason && <p className="mt-2 text-xs text-amber-700">{selectedScenario.statusReason.startsWith('devTesting.') ? t(selectedScenario.statusReason) : selectedScenario.statusReason}</p>}
                                {selectedScenario.missingCapabilities?.length ? <p className="mt-2 text-xs text-amber-700">{t(copyKey('missingCapabilities'))}: {selectedScenario.missingCapabilities.map((capability) => t(copyKey(`capabilities.${capability}`), { defaultValue: capability })).join(', ')}</p> : null}
                                {selectedScenario.preparedDimensions && <details className="mt-2 rounded-md border p-2 text-xs">
                                    <summary className="cursor-pointer font-medium">{t(copyKey('preparedDimensions'))}</summary>
                                    <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words" dir="ltr">{JSON.stringify(selectedScenario.preparedDimensions, null, 2)}</pre>
                                </details>}
                                {selectedScenario.cleanupRequirements?.length ? <p className="mt-2 text-xs text-muted-foreground">{t(copyKey('cleanupRequirementsHelp'))}</p> : null}
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                                <Button type="button" size="sm" variant="outline" allowViewer disabled={!canStartSelected} onClick={() => void start('from')}>
                                    <Route />{t(copyKey('runFromScenario'))}
                                </Button>
                                <Button type="button" size="sm" allowViewer disabled={!canStartSelected} onClick={() => void start('only')}>
                                    {submitting ? <Loader2 className="animate-spin" /> : <Play />}{t(copyKey('runOnlyScenario'))}
                                </Button>
                            </div>
                        </div>}
                    </> : <div className="flex flex-col gap-3 rounded-xl border border-dashed bg-background/60 p-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-3">
                            <CircleDashed className="h-5 w-5 shrink-0 text-primary" />
                            <p>{busy ? t(copyKey('timelineBuilding')) : t(copyKey('timelineFirstRun'))}</p>
                        </div>
                        <Button type="button" size="sm" variant="outline" allowViewer disabled={!canPrepareTimeline} onClick={() => void prepareTimeline()}>
                            {submitting ? <Loader2 className="animate-spin" /> : <Route />}
                            {t(copyKey('timelinePrepare'))}
                        </Button>
                    </div>}
                </section>
                {run && <section className="select-text space-y-3" aria-label={t(copyKey('results'))}>
                    <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <p className="flex items-center gap-2 font-medium">
                            <StatusIcon status={run.status} />
                            {t(copyKey(`status.${run.status}`), { defaultValue: run.status })}
                            {' · '}{run.status === 'planned'
                                ? t(copyKey('planReadyCount'), {
                                    count: run.scenarioPlan?.length ?? timeline.length,
                                    formattedCount: format(run.scenarioPlan?.length ?? timeline.length),
                                })
                                : t(copyKey('progress'), { done: format(finishedScenarios), total: format(run.totalScenarios) })}
                        </p>
                        <span className="text-xs text-muted-foreground">{run.currentScenario || t(copyKey(`stage.${run.stage}`), { defaultValue: run.stage })}</span>
                    </div>
                    {run.status !== 'planned' && <>
                        <div role="progressbar" aria-label={t(copyKey('results'))} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-muted">
                            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs">
                            <span className="flex items-center gap-1"><StatusIcon status="passed" />{t(copyKey('passed'))}: {format(run.passed)}</span>
                            <span className="flex items-center gap-1"><StatusIcon status="failed" />{t(copyKey('failed'))}: {format(run.failed)}</span>
                            <span className="flex items-center gap-1"><StatusIcon status="blocked" />{t(copyKey('blocked'))}: {format(run.blocked)}</span>
                        </div>
                    </>}
                    {run.cancelRequested && run.status === 'running' && <p role="status" className="text-sm text-amber-700">{t(copyKey('finishingCleanup'))}</p>}
                    {run.fixtureCleanup && <div role="status" className={cn('rounded-lg border p-3 text-xs', run.fixtureCleanup.completed ? 'border-emerald-600/30 bg-emerald-600/5' : 'border-destructive/30 bg-destructive/5 text-destructive')}>
                        <p>{t(copyKey(run.fixtureCleanup.completed ? 'cleanupVerified' : 'cleanupFailed'))}</p>
                        {run.fixtureCleanup.errors?.map((message, index) => <pre key={index} className="mt-1 whitespace-pre-wrap break-words" dir="ltr">{message}</pre>)}
                    </div>}
                    {suiteId === 'sales-order-resilience' && run.coverageSummary && <div className="grid gap-2 rounded-xl border p-3 text-xs sm:grid-cols-2">
                        <p><strong>{t(copyKey('availableCoverage'))}:</strong> {run.coverageSummary.available.map((item) => t(copyKey(`scenarioNames.${item}`), { defaultValue: item })).join(', ') || '—'}</p>
                        <p><strong>{t(copyKey('unverifiedCoverage'))}:</strong> {run.coverageSummary.unverified.map((item) => t(copyKey(`coverage.${item}`), { defaultValue: item })).join(', ') || '—'}</p>
                        {run.coverageSummary.skipped.map((item) => <p key={`skip-${item.id}`}><strong>{t(copyKey('skippedCoverage'))}:</strong> {t(copyKey(`scenarioNames.${item.id}`), { defaultValue: item.id })} — {item.reason.startsWith('devTesting.') ? t(item.reason) : item.reason}{item.missingCapabilities?.length ? ` (${t(copyKey('missingCapabilities'))}: ${item.missingCapabilities.map((capability) => t(copyKey(`capabilities.${capability}`), { defaultValue: capability })).join(', ')})` : ''}</p>)}
                        {run.coverageSummary.blocked.map((item) => <p key={`blocked-${item.id}`}><strong>{t(copyKey('blockedCoverage'))}:</strong> {t(copyKey(`scenarioNames.${item.id}`), { defaultValue: item.id })} — {item.reason.startsWith('devTesting.') ? t(item.reason) : item.reason}</p>)}
                    </div>}
                    {suiteId === 'sales-order-resilience' && run.scenarioDimensions?.capabilities && <div className="space-y-2 rounded-xl border p-3 text-xs">
                        <h3 className="font-medium">{t(copyKey('discoveredCapabilities'))}</h3>
                        <div className="flex flex-wrap gap-2">
                            {Object.entries(run.scenarioDimensions.capabilities).filter(([key, value]) => typeof value === 'boolean' && key !== 'isConfigured' && key !== 'isLocked').map(([key, value]) => <span key={key} className={cn('rounded-full border px-2 py-1', value ? 'border-emerald-600/30 bg-emerald-600/5' : 'border-amber-600/30 bg-amber-600/5')}>{t(copyKey(`capabilities.${key}`), { defaultValue: key })}: {t(copyKey(value ? 'available' : 'unavailable'))}</span>)}
                            {Array.isArray(run.scenarioDimensions.capabilities.allowedCurrencies) && <span className="rounded-full border px-2 py-1">{t(copyKey('allowedCurrencies'))}: {(run.scenarioDimensions.capabilities.allowedCurrencies as string[]).map((currency) => currency.toUpperCase()).join(', ') || '—'}</span>}
                            {Array.isArray(run.scenarioDimensions.capabilities.paymentMethods) && <span className="rounded-full border px-2 py-1">{t(copyKey('supportedPaymentMethods'))}: {(run.scenarioDimensions.capabilities.paymentMethods as string[]).map((method) => t(copyKey(`paymentMethods.${method}`), { defaultValue: method })).join(', ') || '—'}</span>}
                        </div>
                    </div>}
                    {suiteId === 'sales-order-resilience' && run.hybridBoundaries && <details className="rounded-xl border p-3 text-xs">
                        <summary className="cursor-pointer font-medium">{t(copyKey('runtimeBoundaries'))}</summary>
                        <dl className="mt-2 grid gap-2 sm:grid-cols-2">{Object.entries(run.hybridBoundaries).map(([key, value]) => <div key={key}><dt className="font-medium">{t(copyKey(`boundaries.${key}`), { defaultValue: key })}</dt><dd className="text-muted-foreground">{value}</dd></div>)}</dl>
                    </details>}
                    <div className="space-y-2">
                        {run.results.map((result) => <details key={result.id} open={result.status === 'failed'} className="rounded-xl border p-3">
                            <summary className="cursor-pointer text-sm">
                                <span className="inline-flex items-center gap-2"><StatusIcon status={result.status} />{result.titleKey ? t(result.titleKey, { defaultValue: result.name }) : result.name}</span>
                            </summary>
                            {result.errors?.map((message, index) => <pre key={index} className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive" dir="ltr">{message}</pre>)}
                            {result.cleanup?.errors?.map((message, index) => <pre key={`cleanup-${index}`} className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive" dir="ltr">{message}</pre>)}
                            {result.artifacts?.screenshot && <p className="mt-2 break-all text-xs text-muted-foreground" dir="ltr">{result.artifacts.screenshot}</p>}
                            {result.actual !== undefined && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 text-[11px]" dir="ltr">{JSON.stringify(result.actual, null, 2)}</pre>}
                        </details>)}
                    </div>
                    {run.logs.length > 0 && <details className="rounded-xl border p-3">
                        <summary className="cursor-pointer text-sm font-medium">{t(copyKey('diagnostics'))}</summary>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs" dir="ltr">{run.logs.map((entry) => `${entry.at} ${entry.level.toUpperCase()} ${entry.message}`).join('\n')}</pre>
                    </details>}
                    {run.diagnosticsPath && <p className="break-all text-xs text-muted-foreground" dir="ltr">{run.diagnosticsPath}</p>}
                </section>}
            </AppDialogBody>
            <AppDialogFooter className="flex-wrap">
                <Button type="button" variant="outline" allowViewer disabled={busy} onClick={onBack}><ArrowLeft />{t(copyKey('back'))}</Button>
                {run && <Button type="button" variant="outline" allowViewer disabled={busy} onClick={download}><Download />{t(copyKey('export'))}</Button>}
                {busy
                    ? <Button type="button" variant="outline" allowViewer disabled={submitting || run?.cancelRequested} onClick={() => void cancel()}><Square />{t(copyKey(run?.cancelRequested ? 'cancelling' : 'cancel'))}</Button>
                    : <Button type="button" allowViewer disabled={!canRunAll} onClick={() => void start()}>{submitting ? <Loader2 className="animate-spin" /> : <Play />}{t(submitting ? copyKey('starting') : copyKey('runFull'))}</Button>}
            </AppDialogFooter>
        </AppDialogContent>
    </AppDialog>
}
