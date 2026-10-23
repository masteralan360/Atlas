import { useCallback, useEffect, useRef, useState } from 'react'
import { getPressAndHoldProgress, WORKSPACE_PAYMENT_HOLD_DURATION_MS } from '@/lib/pressAndHold'

interface DeploymentRefreshVersionProps {
    version: string
    title?: string
    holdLabel: string
    isRtl: boolean
    onComplete: () => void
}

/**
 * A deliberately small, hold-only control for reloading a deployed web build.
 * The rainbow overlay is clipped from the reading edge, so it fills naturally
 * for both LTR and RTL sidebars.
 */
export function DeploymentRefreshVersion({
    version,
    title,
    holdLabel,
    isRtl,
    onComplete
}: DeploymentRefreshVersionProps) {
    const [progress, setProgress] = useState(0)
    const animationFrameRef = useRef<number | null>(null)
    const completedRef = useRef(false)

    const cancelHold = useCallback(() => {
        if (animationFrameRef.current !== null) {
            window.cancelAnimationFrame(animationFrameRef.current)
            animationFrameRef.current = null
        }

        if (!completedRef.current) {
            setProgress(0)
        }
    }, [])

    const beginHold = useCallback(() => {
        if (animationFrameRef.current !== null || completedRef.current) return

        const startedAt = performance.now()
        const updateProgress = (now: number) => {
            const next = getPressAndHoldProgress(startedAt, now, WORKSPACE_PAYMENT_HOLD_DURATION_MS)
            setProgress(next.progress)

            if (next.complete) {
                animationFrameRef.current = null
                completedRef.current = true
                onComplete()
                return
            }

            animationFrameRef.current = window.requestAnimationFrame(updateProgress)
        }

        animationFrameRef.current = window.requestAnimationFrame(updateProgress)
    }, [onComplete])

    useEffect(() => cancelHold, [cancelHold])

    const clipPath = isRtl
        ? `inset(0 0 0 ${100 - progress}%)`
        : `inset(0 ${100 - progress}% 0 0)`

    return (
        <button
            type="button"
            title={title ? `${title}\n${holdLabel}` : holdLabel}
            aria-label={holdLabel}
            className="relative block w-full touch-none select-none text-[10px] font-mono text-muted-foreground opacity-60 outline-none focus-visible:opacity-100"
            onClick={(event) => event.preventDefault()}
            onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                beginHold()
            }}
            onPointerUp={cancelHold}
            onPointerCancel={cancelHold}
            onPointerLeave={cancelHold}
            onBlur={cancelHold}
            onKeyDown={(event) => {
                if (event.repeat) return
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    beginHold()
                }
            }}
            onKeyUp={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    cancelHold()
                }
            }}
        >
            <span className="block truncate px-2">{version}</span>
            <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{ clipPath }}
            >
                <span
                    className="block truncate px-2 bg-clip-text text-transparent [-webkit-text-fill-color:transparent]"
                    style={{
                        backgroundImage: 'linear-gradient(90deg, #ef4444 0%, #f59e0b 20%, #eab308 40%, #22c55e 60%, #3b82f6 80%, #a855f7 100%)'
                    }}
                >
                    {version}
                </span>
            </span>
        </button>
    )
}
