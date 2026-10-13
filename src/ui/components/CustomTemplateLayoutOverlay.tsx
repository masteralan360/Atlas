import type { CustomTemplateLayout } from '@/lib/printPreviewEditorStore'
import { shouldReflowCustomTemplateText } from '@/lib/printPreviewEditorStore'
import { PdfShapeGraphic } from '@/ui/components/PdfShapeGraphic'
import { getPdfShapeHeight, getPdfShapeZIndex } from '@/types'
import { platformService } from '@/services/platformService'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'

type CustomTemplateLayoutOverlayData = Pick<
    CustomTemplateLayout,
    'page' | 'annotations' | 'texts' | 'images' | 'shapes'
>

export function CustomTemplateLayoutOverlay({
    layout,
    heightMm,
    reflowLowerPageText = false,
    resolveLayoutText
}: {
    layout: CustomTemplateLayoutOverlayData
    heightMm: number
    reflowLowerPageText?: boolean
    resolveLayoutText?: (text: string) => string
}) {
    const pageWidth = layout.page.widthMm
    const pageHeight = layout.page.heightMm

    return (
        <div
            className="pointer-events-none absolute start-0 top-0 overflow-visible"
            style={{ width: '100%', height: `${heightMm}mm` }}
        >
            <svg className="absolute inset-0 z-40 h-full w-full" viewBox={`0 0 ${pageWidth} ${heightMm}`}>
                {layout.annotations.map((annotation, index) => (
                    <path
                        key={`annotation-${index}`}
                        d={`M ${annotation.points.map((point) => `${point.x},${point.y}`).join(' L ')}`}
                        stroke={annotation.color}
                        strokeWidth={annotation.brushSize}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={annotation.type === 'brush' ? 0.5 : 1}
                    />
                ))}
            </svg>

            {layout.images.map((image, index) => (
                <img
                    key={`image-${index}`}
                    src={platformService.convertFileSrc(image.path)}
                    alt=""
                    className="absolute block select-none"
                    style={{
                        left: `${(image.x / pageWidth) * 100}%`,
                        top: `${(image.y / heightMm) * 100}%`,
                        width: `${(image.width / pageWidth) * 100}%`,
                        transform: `rotate(${image.rotation || 0}deg)`,
                        transformOrigin: 'top left',
                        zIndex: 60 + index
                    }}
                />
            ))}

            {(layout.shapes || []).map((shape, index) => (
                <div
                    key={`shape-${shape.id || index}`}
                    className="absolute"
                    style={{
                        left: `${(shape.x / pageWidth) * 100}%`,
                        top: `${(shape.y / heightMm) * 100}%`,
                        width: `${(shape.width / pageWidth) * 100}%`,
                        height: `${(getPdfShapeHeight(shape) / heightMm) * 100}%`,
                        transform: `translate(-50%, -50%) rotate(${shape.rotation || 0}deg)`,
                        transformOrigin: 'center',
                        zIndex: getPdfShapeZIndex(shape)
                    }}
                >
                    <PdfShapeGraphic kind={shape.kind} color={shape.color} />
                </div>
            ))}

            {layout.texts.map((text, index) => {
                const reflowsAfterContent = shouldReflowCustomTemplateText(text, pageHeight, reflowLowerPageText)

                return (
                    <div
                        key={`text-${text.id || index}`}
                        dir={resolveIsolatedTextDirection(text.text)}
                        data-template-text-flow={reflowsAfterContent ? 'after-content' : undefined}
                        data-template-custom-text={text.text.trim() ? '' : undefined}
                        data-template-text-y-mm={reflowsAfterContent ? text.y : undefined}
                        className="absolute whitespace-pre-wrap break-words font-bold leading-snug"
                        style={{
                            left: `${(text.x / pageWidth) * 100}%`,
                            top: `${text.y}mm`,
                            width: `${(text.width / pageWidth) * 100}%`,
                            transform: `rotate(${text.rotation || 0}deg)`,
                            transformOrigin: 'top left',
                            zIndex: 100 + index,
                            fontSize: `${text.fontSize || 16}px`,
                            color: text.color || '#000000'
                        }}
                    >
                        {resolveLayoutText ? resolveLayoutText(text.text) : text.text}
                    </div>
                )
            })}
        </div>
    )
}
