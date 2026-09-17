import { Maximize2, Move } from 'lucide-react'
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { CustomTemplateComponentPosition } from '@/lib/printPreviewEditorStore'

export function MovableOrderPrintBlock({
    componentKey,
    label,
    position,
    editable,
    onPositionChange,
    wrapperClassName,
    handleSide = 'right',
    minY,
    pushFlow,
    previewPageBreakMode,
    resizable = false,
    minScale = 0.5,
    maxScale = 2,
    fontSizeEditable = false,
    defaultFontSize = 16,
    minFontSize = 8,
    maxFontSize = 72,
    children
}: {
    componentKey: string
    label: string
    position?: CustomTemplateComponentPosition
    editable?: boolean
    onPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
    wrapperClassName?: string
    handleSide?: 'left' | 'right'
    minY?: number
    pushFlow?: boolean
    previewPageBreakMode?: 'transform'
    /** Shows an editor-only handle that scales this component without changing its data. */
    resizable?: boolean
    minScale?: number
    maxScale?: number
    /** Shows the uploaded-text-style font-size control for text components. */
    fontSizeEditable?: boolean
    defaultFontSize?: number
    minFontSize?: number
    maxFontSize?: number
    children: ReactNode
}) {
    const resolvedScale = Math.min(maxScale, Math.max(minScale, position?.scale ?? 1))
    const configuredFontSize = typeof position?.fontSize === 'number' && Number.isFinite(position.fontSize)
        ? position.fontSize
        : defaultFontSize
    const resolvedFontSize = Math.min(maxFontSize, Math.max(minFontSize, configuredFontSize))
    const resolvedPosition = {
        x: position?.x ?? 0,
        y: position?.y ?? 0,
        scale: resolvedScale,
        ...(position?.fontSize !== undefined ? { fontSize: position.fontSize } : {})
    }

    const updatePosition = (nextPosition: CustomTemplateComponentPosition) => {
        onPositionChange?.(componentKey, {
            x: nextPosition.x,
            y: minY !== undefined ? Math.max(minY, nextPosition.y) : nextPosition.y,
            scale: Math.min(maxScale, Math.max(minScale, nextPosition.scale ?? resolvedScale)),
            ...(nextPosition.fontSize !== undefined || position?.fontSize !== undefined
                ? { fontSize: nextPosition.fontSize ?? position?.fontSize }
                : {})
        })
    }

    const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
        if (!editable || !onPositionChange) return

        event.preventDefault()
        event.stopPropagation()
        const page = event.currentTarget.closest<HTMLElement>('[data-order-print-page]')
        if (!page) return

        const pageRect = page.getBoundingClientRect()
        const pageWidthMm = parseFloat(page.dataset.pageWidthMm || '210')
        const mmPerPixel = pageWidthMm / pageRect.width
        const startX = event.clientX
        const startY = event.clientY
        const initialPosition = resolvedPosition
        const roundMillimeters = (value: number) => Math.round(value * 100) / 100

        const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
            updatePosition({
                x: roundMillimeters(initialPosition.x + ((moveEvent.clientX - startX) * mmPerPixel)),
                y: roundMillimeters(initialPosition.y + ((moveEvent.clientY - startY) * mmPerPixel))
            })
        }
        const handlePointerUp = () => {
            window.removeEventListener('pointermove', handlePointerMove)
            window.removeEventListener('pointerup', handlePointerUp)
            window.removeEventListener('pointercancel', handlePointerUp)
        }

        window.addEventListener('pointermove', handlePointerMove)
        window.addEventListener('pointerup', handlePointerUp)
        window.addEventListener('pointercancel', handlePointerUp)
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!editable || !onPositionChange) return
        const step = event.shiftKey ? 5 : 1
        const delta = {
            ArrowLeft: { x: -step, y: 0 },
            ArrowRight: { x: step, y: 0 },
            ArrowUp: { x: 0, y: -step },
            ArrowDown: { x: 0, y: step }
        }[event.key]
        if (!delta) return

        event.preventDefault()
        updatePosition({
            x: resolvedPosition.x + delta.x,
            y: resolvedPosition.y + delta.y,
            scale: resolvedScale
        })
    }

    const handleResizePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
        if (!editable || !onPositionChange || !resizable) return

        event.preventDefault()
        event.stopPropagation()
        const block = event.currentTarget.parentElement
        if (!block) return

        const blockRect = block.getBoundingClientRect()
        const startX = event.clientX
        const initialScale = resolvedScale

        const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
            const width = Math.max(blockRect.width, 1)
            const relativeWidthChange = (moveEvent.clientX - startX) / width
            updatePosition({
                ...resolvedPosition,
                scale: initialScale * (1 + relativeWidthChange)
            })
        }
        const handlePointerUp = () => {
            window.removeEventListener('pointermove', handlePointerMove)
            window.removeEventListener('pointerup', handlePointerUp)
            window.removeEventListener('pointercancel', handlePointerUp)
        }

        window.addEventListener('pointermove', handlePointerMove)
        window.addEventListener('pointerup', handlePointerUp)
        window.addEventListener('pointercancel', handlePointerUp)
    }

    // Workspace names need to retain their original layout footprint. Scaling the
    // heading visually gives the same font-size control without reflowing the
    // surrounding header or moving neighbouring print components.
    const blockStyle = {
        ...(pushFlow ? {
            position: 'relative',
            transform: `translate(${resolvedPosition.x}mm, 0) scale(${resolvedScale})`,
            transformOrigin: 'top left',
            marginTop: `${resolvedPosition.y}mm`,
            zIndex: 20
        } : {
            transform: `translate(${resolvedPosition.x}mm, ${resolvedPosition.y}mm) scale(${resolvedScale})`,
            transformOrigin: 'top left',
            position: 'relative',
            zIndex: 20
        }),
        ...(fontSizeEditable ? {
            '--print-component-font-scale': `${resolvedFontSize / Math.max(defaultFontSize, 1)}`
        } : {})
    } as CSSProperties & { '--print-component-font-scale'?: string }

    return (
        <div
            className={[
                editable ? 'group/order-block relative outline outline-1 outline-dashed outline-transparent hover:outline-primary/60' : undefined,
                fontSizeEditable ? '[&_h1]:origin-top [&_h1]:scale-[var(--print-component-font-scale)]' : undefined,
                wrapperClassName
            ].filter(Boolean).join(' ')}
            style={blockStyle}
            data-order-print-component={componentKey}
            data-pdf-keep-together
            data-print-preview-editor-page-break-mode={previewPageBreakMode}
            data-pdf-template-object-id={`component:${componentKey}`}
            data-pdf-template-object-kind="component"
        >
            {children}
            {editable ? (
                <>
                    <button
                        type="button"
                        className={`order-template-move-handle absolute -top-3 ${handleSide === 'left' ? 'start-1' : 'end-1'} z-50 inline-flex h-6 touch-none items-center gap-1 rounded border border-primary/30 bg-white px-1.5 text-[9px] font-semibold text-primary opacity-70 shadow-sm hover:opacity-100 focus:opacity-100`}
                        onPointerDown={handlePointerDown}
                        onKeyDown={handleKeyDown}
                        aria-label={`Move ${label}`}
                        title={`Move ${label}. Use arrow keys for 1mm steps; hold Shift for 5mm.`}
                    >
                        <Move className="h-3 w-3" />
                        <span>{label}</span>
                    </button>
                    {resizable ? (
                        <button
                            type="button"
                            className={`order-template-scale-handle absolute -bottom-3 ${handleSide === 'left' ? 'start-1' : 'end-1'} z-50 inline-flex h-6 touch-ew-resize items-center gap-1 rounded border border-primary/30 bg-white px-1.5 text-[9px] font-semibold text-primary opacity-70 shadow-sm hover:opacity-100 focus:opacity-100`}
                            onPointerDown={handleResizePointerDown}
                            aria-label={`Scale ${label}`}
                            title={`Scale ${label}. Drag horizontally to resize.`}
                        >
                            <Maximize2 className="h-3 w-3" />
                            <span>Scale</span>
                        </button>
                    ) : null}
                    {fontSizeEditable ? (
                        <div
                            className="absolute -top-10 left-1/2 z-50 flex h-7 -translate-x-1/2 items-center justify-center rounded-md border border-slate-200 bg-white px-1 opacity-0 shadow-sm transition-opacity group-hover/order-block:opacity-100 group-focus-within/order-block:opacity-100"
                            onPointerDown={(event) => event.stopPropagation()}
                        >
                            <input
                                type="text"
                                lang="en"
                                inputMode="numeric"
                                min={minFontSize}
                                max={maxFontSize}
                                value={position?.fontSize === '' ? '' : (position?.fontSize ?? defaultFontSize)}
                                onChange={(event) => {
                                    const value = event.target.value
                                    updatePosition({
                                        ...resolvedPosition,
                                        fontSize: value === '' ? '' : parseInt(value, 10)
                                    })
                                }}
                                className="h-5 w-12 bg-transparent text-center text-xs font-medium text-slate-700 outline-none"
                                aria-label={`Font size for ${label}`}
                            />
                            <span className="pointer-events-none select-none pe-1 text-[10px] font-medium text-slate-400">px</span>
                        </div>
                    ) : null}
                </>
            ) : null}
        </div>
    )
}
