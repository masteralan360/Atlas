import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeBarcodeScannerText } from '@/lib/barcodeScanner'
import { cn } from '@/lib/utils'
import { Button } from '../button'
import { AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle } from '../dialog'
import { AlertCircle, Camera, CheckCircle2, Loader2, RotateCcw, ScanBarcode, X } from 'lucide-react'
import { CameraBarcodeScanner } from './CameraBarcodeScanner'

export type CameraBarcodeScanMode = 'single' | 'multiple'

export type CameraBarcodeScannerModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Expose one or both scan modes to the consuming feature. */
    modes: readonly CameraBarcodeScanMode[]
    /** A resolved `false` or a thrown error marks the scan as rejected. */
    onScan: (barcode: string, mode: CameraBarcodeScanMode) => void | boolean | Promise<void | boolean>
    selectedCameraId?: string
    cameras?: readonly MediaDeviceInfo[]
    onCameraChange?: (cameraId: string) => void
    defaultMode?: CameraBarcodeScanMode
    title?: string
    className?: string
}

type ScannerFeedback = 'ready' | 'processing' | 'success' | 'failure' | 'camera-error'

function getCameraErrorMessage(error: Error | undefined, t: (key: string, options?: Record<string, unknown>) => string) {
    const name = error?.name ?? ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return t('pos.permissionDenied', { defaultValue: 'Camera permission denied' })
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return t('pos.cameraNotFound', { defaultValue: 'Camera not found' })
    }
    return t('pos.cameraScanner.cameraUnavailable', {
        defaultValue: 'The camera could not be started. Check camera access and try again.'
    })
}

/**
 * Reusable camera barcode workflow. Feature rules stay in `onScan`; this
 * component owns camera lifecycle, mode selection, duplicate suppression,
 * scan feedback, and guarded modal closing.
 */
export function CameraBarcodeScannerModal({
    open,
    onOpenChange,
    modes,
    onScan,
    selectedCameraId = '',
    cameras = [],
    onCameraChange,
    defaultMode = 'single',
    title,
    className
}: CameraBarcodeScannerModalProps) {
    const { t } = useTranslation()
    const availableModes = useMemo<CameraBarcodeScanMode[]>(
        () => modes.length > 0 ? [...new Set(modes)] : ['single'],
        [modes]
    )
    const initialMode = availableModes.includes(defaultMode) ? defaultMode : availableModes[0]
    const [mode, setMode] = useState<CameraBarcodeScanMode>(initialMode)
    const [cameraInstance, setCameraInstance] = useState(0)
    const [cameraReady, setCameraReady] = useState(false)
    const [cameraError, setCameraError] = useState<Error | undefined>()
    const [feedback, setFeedback] = useState<ScannerFeedback>('ready')
    const [lastBarcode, setLastBarcode] = useState('')
    const [isProcessing, setIsProcessing] = useState(false)
    const inFlightRef = useRef(false)
    const lastHandledBarcodeRef = useRef('')
    const sessionRef = useRef(0)
    const mountedRef = useRef(false)
    const onScanRef = useRef(onScan)
    const audioContextRef = useRef<AudioContext | null>(null)
    const activeOscillatorsRef = useRef<Set<OscillatorNode>>(new Set())
    const lastSoundAtRef = useRef(0)

    useEffect(() => {
        onScanRef.current = onScan
    }, [onScan])

    useEffect(() => {
        mountedRef.current = true
        const activeOscillators = activeOscillatorsRef.current
        return () => {
            mountedRef.current = false
            sessionRef.current += 1
            activeOscillators.forEach((oscillator) => {
                try { oscillator.stop() } catch { /* already stopped */ }
                oscillator.disconnect()
            })
            activeOscillators.clear()
            void audioContextRef.current?.close().catch(() => undefined)
            audioContextRef.current = null
        }
    }, [])

    useEffect(() => {
        if (!open) {
            sessionRef.current += 1
            inFlightRef.current = false
            setIsProcessing(false)
            return
        }

        sessionRef.current += 1
        lastHandledBarcodeRef.current = ''
        setMode(initialMode)
        setLastBarcode('')
        setFeedback('ready')
        setCameraReady(false)
        setCameraError(undefined)

        // Opening the dialog is a user gesture in normal use. Resume here, and
        // retry from mode/rescan buttons for browsers that defer audio access.
        unlockAudio()
    // `unlockAudio` intentionally stays stable for the component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialMode, open])

    const unlockAudio = useCallback(() => {
        if (typeof window === 'undefined') return
        try {
            const browserWindow = window as Window & { webkitAudioContext?: typeof AudioContext }
            const AudioContextClass = window.AudioContext ?? browserWindow.webkitAudioContext
            if (!AudioContextClass) return
            const context = audioContextRef.current ?? new AudioContextClass()
            audioContextRef.current = context
            if (context.state === 'suspended') void context.resume().catch(() => undefined)
        } catch {
            // Audio feedback is best effort when the browser blocks Web Audio.
        }
    }, [])

    const playFeedbackSound = useCallback((kind: 'success' | 'failure') => {
        const now = Date.now()
        if (now - lastSoundAtRef.current < 400) return
        lastSoundAtRef.current = now
        try {
            const context = audioContextRef.current
            if (!context || context.state !== 'running') {
                if (context?.state === 'suspended') void context.resume().catch(() => undefined)
                return
            }

            activeOscillatorsRef.current.forEach((oscillator) => {
                try { oscillator.stop() } catch { /* already stopped */ }
                oscillator.disconnect()
            })
            activeOscillatorsRef.current.clear()

            const notes = kind === 'success'
                ? [{ frequency: 783.99, delay: 0, duration: 0.12 }, { frequency: 1046.5, delay: 0.1, duration: 0.2 }]
                : [{ frequency: 330, delay: 0, duration: 0.13 }, { frequency: 220, delay: 0.16, duration: 0.18 }]

            notes.forEach(({ frequency, delay, duration }) => {
                const oscillator = context.createOscillator()
                const gain = context.createGain()
                oscillator.type = kind === 'success' ? 'sine' : 'triangle'
                oscillator.frequency.setValueAtTime(frequency, context.currentTime + delay)
                gain.gain.setValueAtTime(0, context.currentTime + delay)
                gain.gain.linearRampToValueAtTime(kind === 'success' ? 0.055 : 0.07, context.currentTime + delay + 0.015)
                gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + delay + duration)
                oscillator.connect(gain)
                gain.connect(context.destination)
                activeOscillatorsRef.current.add(oscillator)
                oscillator.onended = () => {
                    activeOscillatorsRef.current.delete(oscillator)
                    oscillator.disconnect()
                    gain.disconnect()
                }
                oscillator.start(context.currentTime + delay)
                oscillator.stop(context.currentTime + delay + duration)
            })
        } catch {
            // A decoded barcode must still be handled when audio is unavailable.
        }
    }, [])

    const requestOpenChange = useCallback((nextOpen: boolean) => {
        if (!nextOpen && inFlightRef.current) return
        onOpenChange(nextOpen)
    }, [onOpenChange])

    const handleCameraStateChange = useCallback((state: { isReady: boolean; error?: Error }) => {
        setCameraReady(state.isReady)
        setCameraError(state.error)
        if (state.error) setFeedback('camera-error')
        else if (state.isReady) setFeedback((current) => current === 'camera-error' ? 'ready' : current)
    }, [])

    const handleCapture = useCallback(async (barcodes: Array<{ rawValue?: string }>) => {
        const barcode = normalizeBarcodeScannerText(String(barcodes[0]?.rawValue ?? ''))
        if (!open || !barcode || inFlightRef.current || barcode === lastHandledBarcodeRef.current) return

        const activeSession = sessionRef.current
        const activeMode = mode
        inFlightRef.current = true
        setIsProcessing(true)
        setFeedback('processing')
        setLastBarcode(barcode)

        try {
            const result = await onScanRef.current(barcode, activeMode)
            if (result === false) throw new Error('scan-rejected')
            lastHandledBarcodeRef.current = barcode
            if (!mountedRef.current || sessionRef.current !== activeSession) return
            playFeedbackSound('success')
            setFeedback('success')
            if (activeMode === 'single') {
                inFlightRef.current = false
                setIsProcessing(false)
                requestOpenChange(false)
            }
        } catch {
            lastHandledBarcodeRef.current = barcode
            if (!mountedRef.current || sessionRef.current !== activeSession) return
            playFeedbackSound('failure')
            setFeedback('failure')
        } finally {
            if (mountedRef.current && sessionRef.current === activeSession) {
                inFlightRef.current = false
                setIsProcessing(false)
            }
        }
    }, [mode, open, playFeedbackSound, requestOpenChange])

    const handleIntentionalRescan = () => {
        unlockAudio()
        lastHandledBarcodeRef.current = ''
        setFeedback(cameraReady ? 'ready' : cameraError ? 'camera-error' : 'ready')
    }

    const restartCamera = () => {
        setCameraError(undefined)
        setCameraReady(false)
        setFeedback('ready')
        setCameraInstance((current) => current + 1)
    }

    const cameraErrorMessage = cameraError ? getCameraErrorMessage(cameraError, t) : ''
    const statusMessage = feedback === 'processing'
        ? t('pos.cameraScanner.processing', { defaultValue: 'Processing barcode…' })
        : feedback === 'success'
            ? t('pos.cameraScanner.scanAccepted', { defaultValue: 'Barcode accepted.' })
            : feedback === 'failure'
                ? t('pos.cameraScanner.scanFailed', { defaultValue: 'Barcode could not be processed. Scan it again to retry.' })
                : cameraError
                    ? cameraErrorMessage
                    : cameraReady
                        ? t('pos.cameraScanner.ready', { defaultValue: 'Point the camera at a barcode.' })
                        : t('pos.cameraScanner.startingCamera', { defaultValue: 'Starting camera…' })

    return (
        <AppDialog open={open} onOpenChange={requestOpenChange}>
            <AppDialogContent
                showCloseButton={!isProcessing}
                className={cn('max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-1rem)] sm:max-h-[min(calc(100dvh-3rem),820px)]', className)}
            >
                <AppDialogHeader>
                    <AppDialogTitle className="flex items-center gap-2">
                        <Camera className="h-5 w-5 shrink-0 text-primary" />
                        {title ?? t('pos.cameraScanner.title', { defaultValue: 'Camera Barcode Scanner' })}
                    </AppDialogTitle>
                </AppDialogHeader>

                <AppDialogBody className="space-y-4 sm:space-y-5">
                    {availableModes.length > 1 && (
                        <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/30 p-1.5" aria-label={t('pos.cameraScanner.mode', { defaultValue: 'Scan mode' })}>
                            {availableModes.map((availableMode) => {
                                const isSelected = mode === availableMode
                                const Icon = availableMode === 'single' ? ScanBarcode : RotateCcw
                                return (
                                    <button
                                        key={availableMode}
                                        type="button"
                                        disabled={isProcessing}
                                        onClick={() => {
                                            unlockAudio()
                                            setMode(availableMode)
                                            setFeedback('ready')
                                        }}
                                        className={cn(
                                            'flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-60',
                                            isSelected ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                        )}
                                        aria-pressed={isSelected}
                                    >
                                        <Icon className="h-4 w-4 shrink-0" />
                                        {availableMode === 'single'
                                            ? t('pos.cameraScanner.singleScan', { defaultValue: 'Single scan' })
                                            : t('pos.cameraScanner.multipleScans', { defaultValue: 'Multiple scans' })}
                                    </button>
                                )
                            })}
                        </div>
                    )}

                    {cameras.length > 1 && onCameraChange && (
                        <label className="flex min-w-0 items-center gap-3 text-sm">
                            <span className="shrink-0 font-medium">{t('pos.selectCamera', { defaultValue: 'Select camera' })}</span>
                            <select
                                className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
                                value={selectedCameraId}
                                onChange={(event) => onCameraChange(event.target.value)}
                                disabled={isProcessing}
                            >
                                <option value="">
                                    {t('pos.cameraScanner.defaultCamera', { defaultValue: 'Use default rear camera' })}
                                </option>
                                {cameras.map((camera, index) => (
                                    <option key={camera.deviceId || index} value={camera.deviceId}>
                                        {camera.label || `${t('pos.camera', { defaultValue: 'Camera' })} ${index + 1}`}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}

                    <div className="relative isolate aspect-[4/3] max-h-[min(54vh,460px)] min-h-56 overflow-hidden rounded-2xl border border-border bg-black shadow-inner sm:aspect-video sm:min-h-64">
                        {open && !cameraError && (
                            <CameraBarcodeScanner
                                key={`${selectedCameraId}:${cameraInstance}`}
                                selectedCameraId={selectedCameraId}
                                onCapture={handleCapture}
                                onCameraStateChange={handleCameraStateChange}
                                paused={isProcessing}
                            />
                        )}
                        {!cameraReady && !cameraError && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/45 px-5 text-center text-white">
                                <Loader2 className="h-8 w-8 animate-spin" />
                                <p className="text-sm font-medium">{t('pos.cameraScanner.startingCamera', { defaultValue: 'Starting camera…' })}</p>
                            </div>
                        )}
                        {cameraError && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/30 px-5 text-center">
                                <AlertCircle className="h-9 w-9 text-destructive" />
                                <p className="max-w-sm text-sm font-medium">{cameraErrorMessage}</p>
                                <Button type="button" variant="outline" size="sm" onClick={restartCamera}>
                                    <RotateCcw className="me-2 h-4 w-4" />
                                    {t('pos.cameraScanner.retryCamera', { defaultValue: 'Retry camera' })}
                                </Button>
                            </div>
                        )}
                        {cameraReady && !cameraError && (
                            <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-primary/70 shadow-[0_0_16px_rgba(var(--primary),0.9)]" />
                        )}
                    </div>

                    <div className="flex min-h-12 items-start gap-3 rounded-xl border border-border bg-muted/30 p-3" role="status" aria-live="polite">
                        {feedback === 'processing'
                            ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                            : feedback === 'success'
                                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                                : feedback === 'failure' || feedback === 'camera-error'
                                    ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                                    : <ScanBarcode className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                        <div className="min-w-0 flex-1 space-y-1">
                            <p className="text-sm leading-5">{statusMessage}</p>
                            {lastBarcode && feedback !== 'processing' && (
                                <p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{lastBarcode}</p>
                            )}
                        </div>
                        {(feedback === 'failure' || (feedback === 'success' && mode === 'multiple')) && (
                            <Button type="button" variant="ghost" size="sm" className="h-auto min-h-9 shrink-0 px-2 text-xs" onClick={handleIntentionalRescan}>
                                <RotateCcw className="me-1.5 h-3.5 w-3.5" />
                                {t('pos.cameraScanner.scanSameAgain', { defaultValue: 'Scan same again' })}
                            </Button>
                        )}
                    </div>
                </AppDialogBody>

                <AppDialogFooter className="flex-col-reverse sm:flex-row">
                    <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={isProcessing} onClick={() => requestOpenChange(false)}>
                        {isProcessing
                            ? <><Loader2 className="me-2 h-4 w-4 animate-spin" />{t('pos.cameraScanner.processing', { defaultValue: 'Processing barcode…' })}</>
                            : <><X className="me-2 h-4 w-4" />{t('pos.cameraScanner.close', { defaultValue: 'Close scanner' })}</>}
                    </Button>
                </AppDialogFooter>
            </AppDialogContent>
        </AppDialog>
    )
}
