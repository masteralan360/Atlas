import { useEffect, useState, type CSSProperties } from 'react'

import { cn } from '@/lib/utils'

type Orientation = 'vertical' | 'horizontal'
type ColorScheme = 'primary' | 'purple' | 'blue' | 'green' | 'red'

type GlowLineProps = {
    orientation: Orientation
    position: string
    className?: string
    color: ColorScheme
}

type LoadingGlowLineProps = GlowLineProps & {
    isLoading: boolean
}

type ColorSchemeConfig = {
    core: string
    glow: readonly [string, string, string]
}

const COLOR_SCHEMES: Record<ColorScheme, ColorSchemeConfig> = {
    primary: {
        core: 'via-[hsl(var(--primary))]',
        glow: [
            'via-[hsl(var(--primary))]',
            'via-[hsl(var(--primary))]',
            'via-[hsl(var(--primary))]'
        ]
    },
    purple: {
        core: 'via-purple-400',
        glow: ['via-purple-400', 'via-purple-500', 'via-purple-300']
    },
    blue: {
        core: 'via-blue-400',
        glow: ['via-blue-400', 'via-blue-500', 'via-blue-300']
    },
    green: {
        core: 'via-green-400',
        glow: ['via-green-400', 'via-green-500', 'via-green-300']
    },
    red: {
        core: 'via-red-400',
        glow: ['via-red-400', 'via-red-500', 'via-red-300']
    }
}

/**
 * Sera-inspired layered glow line. Its layers share one animation class, so
 * the core and its bloom always travel as a single, connected light beam.
 */
export function GlowLine({ orientation, position, className, color }: GlowLineProps) {
    const isVertical = orientation === 'vertical'
    const positionStyle: CSSProperties = isVertical ? { left: position } : { top: position }
    const containerClasses = isVertical ? 'absolute h-full w-px' : 'absolute h-px w-full'
    const gradientDirection = isVertical ? 'bg-gradient-to-b' : 'bg-gradient-to-r'
    const travelClass = isVertical ? 'glow-line__travel--vertical' : 'glow-line__travel--horizontal'
    const selectedScheme = COLOR_SCHEMES[color]
    const glowLayers = [
        { size: isVertical ? 'w-1 -ml-0.5' : 'h-1 -mt-0.5', blur: 'blur-sm', opacity: 'opacity-50' },
        { size: isVertical ? 'w-2 -ml-1' : 'h-2 -mt-1', blur: 'blur-md', opacity: 'opacity-35' },
        { size: isVertical ? 'w-4 -ml-2' : 'h-4 -mt-2', blur: 'blur-lg', opacity: 'opacity-20' }
    ]

    return (
        <div aria-hidden="true" className={cn(containerClasses, 'glow-line__sweep', className)} style={positionStyle}>
            <div className={cn('absolute inset-0 opacity-75', gradientDirection, 'from-transparent to-transparent', travelClass, selectedScheme.core)} />
            <div
                className={cn(
                    'absolute inset-0 from-transparent via-white to-transparent opacity-30',
                    isVertical ? 'w-0.5 -ml-px bg-gradient-to-b' : 'h-0.5 -mt-px bg-gradient-to-r',
                    travelClass
                )}
            />
            {glowLayers.map((layer, index) => (
                <div
                    key={index}
                    className={cn(
                        'absolute inset-0 from-transparent to-transparent',
                        gradientDirection,
                        layer.size,
                        layer.blur,
                        layer.opacity,
                        travelClass,
                        selectedScheme.glow[index]
                    )}
                />
            ))}
        </div>
    )
}

/** Keeps the line mounted long enough for a graceful exit after loading. */
export function LoadingGlowLine({ isLoading, ...glowLineProps }: LoadingGlowLineProps) {
    const [shouldRender, setShouldRender] = useState(isLoading)

    useEffect(() => {
        if (isLoading) {
            setShouldRender(true)
            return
        }

        if (!shouldRender) return

        const exitTimer = window.setTimeout(() => setShouldRender(false), 700)
        return () => window.clearTimeout(exitTimer)
    }, [isLoading, shouldRender])

    if (!shouldRender) return null

    return (
        <div
            aria-hidden="true"
            className={cn(
                'absolute inset-0 z-20 pointer-events-none transition-opacity duration-700 ease-out',
                isLoading ? 'opacity-100' : 'opacity-0'
            )}
        >
            <GlowLine {...glowLineProps} />
        </div>
    )
}
