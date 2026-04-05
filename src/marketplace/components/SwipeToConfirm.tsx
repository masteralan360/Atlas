import React, { useState, useRef, useEffect } from 'react'
import { ChevronRight, ChevronLeft, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

type SwipeToConfirmProps = {
    onConfirm: () => void
    label: string
    loading?: boolean
    disabled?: boolean
    className?: string
}

export function SwipeToConfirm({
    onConfirm,
    label,
    loading = false,
    disabled = false,
    className
}: SwipeToConfirmProps) {
    const { i18n } = useTranslation()
    const isRtl = i18n.dir() === 'rtl'
    const [dragX, setDragX] = useState(0)
    const [isDragging, setIsDragging] = useState(false)
    const [isConfirmed, setIsConfirmed] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const startX = useRef(0)

    const handleTouchStart = (e: React.TouchEvent | React.MouseEvent) => {
        if (disabled || loading || isConfirmed) return
        setIsDragging(true)
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX

        // In RTL, we calculate relative to the right edge or flip the drag
        startX.current = isRtl ? clientX + dragX : clientX - dragX
    }

    const handleTouchMove = (e: React.TouchEvent | React.MouseEvent) => {
        if (!isDragging || disabled || loading || isConfirmed) return
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
        const containerWidth = containerRef.current?.offsetWidth || 0
        const handleWidth = 56 // w-14
        const maxDrag = containerWidth - handleWidth - 12 // 1.5 * 4 * 2 (p-1.5)

        let newX = isRtl ? startX.current - clientX : clientX - startX.current
        newX = Math.max(0, Math.min(newX, maxDrag))
        setDragX(newX)
    }

    const handleTouchEnd = () => {
        if (!isDragging) return
        setIsDragging(false)

        const containerWidth = containerRef.current?.offsetWidth || 0
        const handleWidth = 56
        const maxDrag = containerWidth - handleWidth - 8
        const threshold = maxDrag * 0.9

        if (dragX >= threshold) {
            setDragX(maxDrag)
            setIsConfirmed(true)
            onConfirm()
        } else {
            setDragX(0)
        }
    }

    // Reset confirmed state if loading turns off and it didn't succeed (transition to 0)
    useEffect(() => {
        if (!loading && isConfirmed) {
            const timeout = setTimeout(() => {
                setDragX(0)
                setIsConfirmed(false)
            }, 0) // Slight delay so users see the state before it pops back
            return () => clearTimeout(timeout)
        }
    }, [loading, isConfirmed])

    return (
        <div
            ref={containerRef}
            className={cn(
                "relative h-16 w-full flex items-center p-1.5 rounded-2xl bg-muted/40 border border-border/50 overflow-hidden select-none touch-none",
                disabled && "opacity-50 grayscale pointer-events-none",
                className
            )}
            onMouseDown={handleTouchStart}
            onMouseMove={handleTouchMove}
            onMouseUp={handleTouchEnd}
            onMouseLeave={handleTouchEnd}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            {/* Background Text */}
            <div className={cn(
                "absolute inset-0 flex items-center justify-center text-sm font-black transition-opacity duration-300 pointer-events-none",
                isDragging || isConfirmed ? "opacity-0 text-primary" : "opacity-100 text-muted-foreground"
            )}>
                {label}
            </div>

            {/* Progress Track (Optional) */}
            <div
                className={cn(
                    "absolute top-1.5 bottom-1.5 bg-primary/80 rounded-xl transition-all duration-0 pointer-events-none",
                    isRtl ? "right-1.5" : "left-1.5"
                )}
                style={{ width: `calc(${dragX}px + 56px)` }}
            />

            {/* Handle */}
            <div
                className={cn(
                    "flex h-[52px] w-14 items-center justify-center rounded-xl bg-primary shadow-lg shadow-primary/20 cursor-grab active:cursor-grabbing transition-colors absolute z-10",
                    isRtl ? "right-1.5" : "left-1.5",
                    isConfirmed && "cursor-default",
                    !isDragging && "transition-transform duration-300"
                )}
                style={{ transform: `translateX(${isRtl ? -dragX : dragX}px)` }}
            >
                {loading ? (
                    <Loader2 className="h-6 w-6 animate-spin text-primary-foreground" />
                ) : (
                    <>
                        {isRtl ? (
                            <ChevronLeft className={cn(
                                "h-6 w-6 text-primary-foreground transition-transform",
                                isDragging && "scale-110"
                            )} />
                        ) : (
                            <ChevronRight className={cn(
                                "h-6 w-6 text-primary-foreground transition-transform",
                                isDragging && "scale-110"
                            )} />
                        )}
                    </>
                )}
            </div>
        </div>
    )
}
