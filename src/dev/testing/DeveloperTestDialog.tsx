import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Circle, Download, FlaskConical, Loader2, Play, RotateCcw, ShieldCheck, Square, XCircle } from 'lucide-react'
import { AppDialog, AppDialogBody, AppDialogContent, AppDialogDescription, AppDialogFooter, AppDialogHeader, AppDialogTitle } from '@/ui/components/dialog'
import { Button } from '@/ui/components/button'
import { Input } from '@/ui/components/input'
import { Label } from '@/ui/components/label'
import { Checkbox } from '@/ui/components/checkbox'
import { cn } from '@/lib/utils'
import suitesJson from './suites.json'
import { runnerErrorKey, testRunnerClient } from './client'
import type { SuiteDefinition, TestRun, TestStatus } from './types'

const suites: Record<string, SuiteDefinition> = suitesJson
const icons = { pending: Circle, running: Loader2, passed: CheckCircle2, failed: XCircle, skipped: AlertTriangle, cancelled: Square }

function StatusIcon({ status }: { status: TestStatus }) {
    const Icon = icons[status]
    return <Icon aria-hidden className={cn('h-4 w-4 shrink-0', status === 'running' && 'animate-spin', status === 'passed' && 'text-emerald-600', status === 'failed' && 'text-destructive', status === 'skipped' && 'text-amber-600')} />
}

export default function DeveloperTestDialog({ suiteId, open, onOpenChange }: { suiteId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { t, i18n } = useTranslation()
    const suite = suites[suiteId]
    const [selected, setSelected] = useState(() => suite?.groups.map((group) => group.id) ?? [])
    const [seed, setSeed] = useState('20,260,918')
    const [samples, setSamples] = useState('16')
    const [run, setRun] = useState<TestRun | null>(null)
    const [ready, setReady] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [onlyFailures, setOnlyFailures] = useState(false)
    const token = useRef('')
    const mutationVersion = useRef(0)
    const submittingRef = useRef(false)
    const mounted = useRef(true)
    const busy = submitting || run?.status === 'running'
    const activeRun = run?.suiteId === suiteId ? run : null
    const format = (value: number) => new Intl.NumberFormat(i18n.language).format(value)
    const parsedSeed = Number(seed.replace(/,/g, ''))
    const parsedSamples = Number(samples.replace(/,/g, ''))
    const valid = !!suite && selected.length > 0 && seed !== '' && samples !== ''
        && Number.isInteger(parsedSeed) && parsedSeed >= 0 && parsedSeed <= 0xffffffff
        && Number.isInteger(parsedSamples) && parsedSamples >= 1 && parsedSamples <= 100

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])

    useEffect(() => {
        if (!open) return
        const abort = new AbortController()
        let timer: ReturnType<typeof setTimeout>
        const poll = async () => {
            const version = mutationVersion.current
            try {
                let nextRun
                if (!token.current) {
                    const session = await testRunnerClient.session(abort.signal)
                    token.current = session.token
                    nextRun = session.run
                } else nextRun = await testRunnerClient.run(token.current, abort.signal)
                if (abort.signal.aborted) return
                if (version === mutationVersion.current && !submittingRef.current) setRun(nextRun)
                setReady(true)
                setError(null)
            } catch (error) {
                if (abort.signal.aborted) return
                setReady(false)
                setError(runnerErrorKey(error))
                token.current = ''
            }
            if (!abort.signal.aborted) timer = setTimeout(poll, 1000)
        }
        void poll()
        return () => { abort.abort(); clearTimeout(timer) }
    }, [open])

    const start = async (groupIds = selected, usePreviousInputs = false) => {
        if (submittingRef.current || busy || !ready || !valid) return
        submittingRef.current = true
        mutationVersion.current++
        setSubmitting(true)
        setError(null)
        setOnlyFailures(false)
        try {
            const next = await testRunnerClient.start(token.current, {
                suiteId, groupIds,
                seed: usePreviousInputs && activeRun ? activeRun.seed : parsedSeed,
                samples: usePreviousInputs && activeRun ? activeRun.samples : parsedSamples
            })
            if (mounted.current) setRun(next)
        } catch (error) { if (mounted.current) setError(runnerErrorKey(error)) }
        finally { submittingRef.current = false; if (mounted.current) setSubmitting(false) }
    }

    const cancel = async () => {
        if (!run || submittingRef.current) return
        submittingRef.current = true
        mutationVersion.current++
        setSubmitting(true)
        try { const next = await testRunnerClient.cancel(token.current, run.id); if (mounted.current) setRun(next) }
        catch (error) { if (mounted.current) setError(runnerErrorKey(error)) }
        finally { submittingRef.current = false; if (mounted.current) setSubmitting(false) }
    }

    const download = () => {
        if (!activeRun || busy) return
        const url = URL.createObjectURL(new Blob([JSON.stringify(activeRun, null, 2)], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `atlas-${suiteId}-${activeRun.id}.json`
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    const tests = activeRun?.groups.flatMap((group) => group.tests) ?? []
    const finished = tests.filter((test) => !['pending', 'running'].includes(test.status)).length
    const groupProgress = activeRun?.groups.reduce((sum, group) => {
        if (!['pending', 'running'].includes(group.status)) return sum + 1
        const done = group.tests.filter((test) => !['pending', 'running'].includes(test.status)).length
        return sum + (group.tests.length ? done / group.tests.length * 0.95 : 0)
    }, 0) ?? 0
    const progress = activeRun?.groups.length ? Math.round(groupProgress / activeRun.groups.length * 100) : 0
    const failedGroups = activeRun?.groups.filter((group) => group.status === 'failed').map((group) => group.id) ?? []
    const blockClose = (event: { preventDefault: () => void }) => { if (busy) event.preventDefault() }
    const formatInput = (value: string) => value === '' ? '' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value.replace(/,/g, '')))

    return <AppDialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
        <AppDialogContent className="max-w-5xl" showCloseButton={!busy} onInteractOutside={blockClose} onEscapeKeyDown={blockClose}>
            <AppDialogHeader>
                <AppDialogTitle className="flex items-center gap-2"><FlaskConical className="h-5 w-5" />{t('devTesting.title', { module: t(suite?.titleKey ?? 'devTesting.saleOrders') })}</AppDialogTitle>
                <AppDialogDescription>{t('devTesting.description')}</AppDialogDescription>
            </AppDialogHeader>
            <AppDialogBody className="space-y-5">
                <div className="flex gap-3 rounded-xl border border-emerald-600/20 bg-emerald-600/5 p-3 text-sm">
                    <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" /><p>{t('devTesting.isolation')}</p>
                </div>
                {error && <p role="alert" className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{t(error)}</p>}
                {!ready && !error && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t('devTesting.connecting')}</p>}
                {run && !activeRun && <p role="status" className="text-sm">{t('devTesting.anotherSuite')}</p>}
                <fieldset disabled={busy} className="space-y-3">
                    <legend className="mb-2 font-medium">{t('devTesting.checks')} *</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {suite?.groups.map((group) => <label key={group.id} className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm">
                            <Checkbox allowViewer aria-label={t(group.titleKey)} checked={selected.includes(group.id)} onCheckedChange={(checked) => setSelected((previous) => checked ? [...previous, group.id] : previous.filter((id) => id !== group.id))} disabled={busy} />
                            <span><span className="block font-medium">{t(group.titleKey)}</span><span className="text-xs text-muted-foreground">{t(`devTesting.layers.${group.layer}`)}</span></span>
                        </label>)}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                            <Label htmlFor="dev-test-seed">{t('devTesting.seed')} *</Label>
                            <Input allowViewer id="dev-test-seed" value={seed} inputMode="numeric" placeholder="0" disabled={busy} onChange={(event) => {
                                const value = event.target.value.replace(/,/g, '')
                                if (/^\d*$/.test(value)) setSeed(formatInput(value))
                            }} />
                            <p className="text-xs text-muted-foreground">{t('devTesting.seedHelp')}</p>
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="dev-test-samples">{t('devTesting.samples')} *</Label>
                            <Input allowViewer id="dev-test-samples" value={samples} inputMode="numeric" placeholder="0" disabled={busy} onChange={(event) => {
                                const value = event.target.value.replace(/,/g, '')
                                if (/^\d*$/.test(value)) setSamples(formatInput(value))
                            }} />
                            <p className="text-xs text-muted-foreground">{t('devTesting.samplesHelp')}</p>
                        </div>
                    </div>
                </fieldset>
                <div className="rounded-xl border border-amber-600/25 bg-amber-600/5 p-3 text-sm">
                    <p className="mb-2 flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" />{t('devTesting.coverageLimit')}</p>
                    <ul className="space-y-1">
                        {suite?.unavailable.map((id) => <li key={id} className="flex flex-wrap items-center justify-between gap-2"><span>{t(`devTesting.environments.${id}`)}</span><span className="text-xs text-amber-700 dark:text-amber-400">{t('devTesting.blocked')}</span></li>)}
                    </ul>
                    <p className="mt-2 text-xs text-muted-foreground">{t('devTesting.coverageHelp')}</p>
                </div>
                {activeRun && <section className="select-text space-y-3" aria-label={t('devTesting.results')}>
                    <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <p className="flex items-center gap-2 font-medium"><StatusIcon status={activeRun.status} />{t(`devTesting.runStatus.${activeRun.status}`)} · {t('devTesting.progress', { done: format(finished), total: format(tests.length) })}</p>
                        <span className="text-xs text-muted-foreground">{t('devTesting.runSeed', { seed: format(activeRun.seed) })}</span>
                    </div>
                    <div role="progressbar" aria-label={t('devTesting.results')} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div>
                    <div className="flex flex-wrap gap-3 text-xs">
                        {(['passed', 'failed', 'skipped', 'cancelled'] as const).map((status) => <span key={status} className="flex items-center gap-1"><StatusIcon status={status} />{t(`devTesting.status.${status}`)}: {format(tests.filter((test) => test.status === status).length)}</span>)}
                    </div>
                    <label className="flex items-center gap-2 text-sm"><Checkbox allowViewer aria-label={t('devTesting.onlyFailures')} checked={onlyFailures} onCheckedChange={(checked) => setOnlyFailures(checked === true)} />{t('devTesting.onlyFailures')}</label>
                    {activeRun.cancelRequested && activeRun.status === 'running' && <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{t('devTesting.cancelling')}</p>}
                    {activeRun.groups.map((group) => <details key={group.id} open={group.status === 'failed'} className="rounded-xl border p-3">
                        <summary className="cursor-pointer text-sm"><span className="inline-flex items-center gap-2"><StatusIcon status={group.status} />{t(suite.groups.find((entry) => entry.id === group.id)?.titleKey ?? 'devTesting.checks')} · {t(`devTesting.status.${group.status}`)} · {format(group.tests.length)}</span></summary>
                        {group.errors.map((error, index) => <pre key={index} className="mt-2 max-w-full whitespace-pre-wrap break-words rounded-lg bg-destructive/5 p-2 text-xs text-destructive" dir="ltr">{error}</pre>)}
                        <div className="mt-2 space-y-2">
                            {group.tests.filter((test) => !onlyFailures || test.status === 'failed').map((test) => <div key={test.id} className="rounded-lg bg-muted/40 p-2 text-xs">
                                <div className="flex items-start gap-2"><StatusIcon status={test.status} /><span className="min-w-0 flex-1 break-words" dir="ltr">{test.name}</span><span className="shrink-0 text-muted-foreground">{t('devTesting.duration', { ms: format(Math.round(test.durationMs)) })}</span></div>
                                <p className="mt-1 break-all text-muted-foreground" dir="ltr">{test.file}</p>
                                {test.errors.map((error, index) => <pre key={index} className="mt-2 whitespace-pre-wrap break-words text-destructive" dir="ltr">{error}</pre>)}
                            </div>)}
                        </div>
                    </details>)}
                    {activeRun.reportPath && <p className="break-all text-xs text-muted-foreground" dir="ltr">{activeRun.reportPath}</p>}
                </section>}
            </AppDialogBody>
            <AppDialogFooter className="flex-wrap">
                {activeRun && <Button variant="outline" allowViewer disabled={busy} onClick={download}><Download />{t('devTesting.export')}</Button>}
                {failedGroups.length > 0 && <Button variant="outline" allowViewer disabled={busy || !ready || !valid} onClick={() => void start(failedGroups, true)}><RotateCcw />{t('devTesting.rerun')}</Button>}
                {busy ? <Button variant="outline" allowViewer disabled={submitting || !!run?.cancelRequested || !ready} onClick={() => void cancel()}><Square />{t('devTesting.cancel')}</Button> : <Button variant="outline" allowViewer onClick={() => onOpenChange(false)}>{t('common.close')}</Button>}
                <Button allowViewer disabled={!valid || !ready || busy} onClick={() => void start()}>{busy ? <Loader2 className="animate-spin" /> : <Play />}{t(busy ? 'devTesting.running' : 'devTesting.run')}</Button>
            </AppDialogFooter>
        </AppDialogContent>
    </AppDialog>
}
