import { getPdfShapeBottom, type PdfShape, type UniversalInvoice } from '@/types'
import type { ReactElement } from 'react'

export type PrintFormat = 'a4' | 'receipt' | 'barcode_35x15'
export type CustomTemplatePrintLanguage = 'en' | 'ar' | 'ku'

export type TemplatePreviewField = {
    key: string
    label: string
    value: string
    type: 'text' | 'number' | 'date' | 'boolean' | 'range'
    placeholder?: string
    min?: number
    max?: number
    step?: number
    unit?: string
}

export type TemplatePreviewDataKey = {
    key: string
    label: string
    group?: string
    token?: string
    description?: string
}

export type TemplatePreviewRenderOptions = {
    editableFields?: boolean
    editableComponents?: boolean
    dataKeys?: TemplatePreviewDataKey[]
    tokenFieldTemplates?: Record<string, string>
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    hiddenFields?: Record<string, boolean>
    fieldOrders?: Record<string, string[]>
    fieldLabelOverrides?: Record<string, string>
    fieldDisplayModes?: Record<string, string>
    /** Background watermark rendered behind every template component. */
    background?: CustomTemplateBackground
    onFieldChange?: (key: string, value: string) => void
    onComponentPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
    onFieldOrderChange?: (sectionKey: string, fieldKeys: string[]) => void
    onFieldLabelChange?: (fieldKey: string, label: string) => void
    onFieldDisplayModeChange?: (fieldKey: string, mode: string) => void
    workspaceFooterContacts?: Record<string, { primary?: string; nonPrimary?: string }>
}

export type TemplatePreviewMovableComponent = {
    key: string
    label: string
    defaultPosition?: CustomTemplateComponentPosition
}

export type TemplatePreview = {
    fields: TemplatePreviewField[]
    dataKeys?: TemplatePreviewDataKey[]
    movableComponents?: TemplatePreviewMovableComponent[]
    /** Enables the common background watermark editor in the preview's edit panel. */
    supportsBackgroundEdit?: boolean
    /** Keeps legacy lower-page notes below dynamic native content when it expands. */
    reflowLowerPageText?: boolean
    page?: {
        widthMm: number
        heightMm: number
    }
    createElement: (
        data: Record<string, string>,
        effectiveId?: string,
        printLangOverride?: string,
        renderOptions?: TemplatePreviewRenderOptions
    ) => ReactElement
    buildPdf: (
        element: ReactElement,
        printLangOverride?: string,
        fieldValues?: Record<string, string>
    ) => Promise<Blob>
    fixedPrintLang?: 'en' | 'ar' | 'ku'
}

export type CustomTemplateAnnotation = {
    type: 'pen' | 'brush'
    points: { x: number; y: number }[]
    color: string
    brushSize: number
}

export type CustomTemplateText = {
    id: string
    text: string
    x: number
    y: number
    width: number
    rotation: number
    fontSize?: number | ''
    color?: string
    anchor?: 'absolute' | 'afterContent'
}

export type CustomTemplateImage = {
    path: string
    x: number
    y: number
    width: number
    rotation?: number
}

export type CustomTemplateShape = PdfShape

export type CustomTemplateComponentPosition = {
    x: number
    y: number
    /** Visual scale for movable print components. Older saved layouts omit this and render at 1×. */
    scale?: number
    /** Optional font size for editable text components. Older saved layouts keep their template default. */
    fontSize?: number | ''
}

export type CustomTemplateBackground = {
    path: string
    /** Watermark opacity as a percentage (1-100). */
    opacity: number
    /** Watermark width as a percentage of the page width (10-100). */
    size: number
}

export type CustomTemplateLayout = {
    version: 1
    label?: string
    moduleTypeKey: string
    nativeTemplateKey?: string
    printLanguage?: CustomTemplatePrintLanguage
    page: {
        widthMm: number
        heightMm: number
    }
    fields: Record<string, string>
    fieldTokenTemplates?: Record<string, string>
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    hiddenFields?: Record<string, boolean>
    fieldOrders?: Record<string, string[]>
    fieldLabelOverrides?: Record<string, string>
    fieldDisplayModes?: Record<string, string>
    /** Background watermark that renders behind every component of this preview. */
    background?: CustomTemplateBackground
    /** Enables the common background watermark editor in the preview's edit panel. */
    supportsBackgroundEdit?: boolean
    annotations: CustomTemplateAnnotation[]
    texts: CustomTemplateText[]
    images: CustomTemplateImage[]
    shapes: CustomTemplateShape[]
    updatedAt: string
}

export const A4_PAGE_HEIGHT_MM = 297
const DEFAULT_OVERFLOW_COMPONENT_HEIGHT_MM = 40
const DEFAULT_OVERFLOW_IMAGE_HEIGHT_RATIO = 1
const PX_TO_MM = 0.2645833333
const LEGACY_LOWER_PAGE_TEXT_START_OFFSET_MM = 52

export function shouldReflowCustomTemplateText(
    text: CustomTemplateText,
    pageHeightMm: number,
    enabled = false
) {
    if (!enabled || text.anchor === 'absolute') return false
    if (text.anchor === 'afterContent') return true

    return getPositiveNumber(text.y) >= pageHeightMm - LEGACY_LOWER_PAGE_TEXT_START_OFFSET_MM
}

function getPositiveNumber(value: unknown, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function estimateTextHeightMm(text: CustomTemplateText) {
    const fontSizePx = getPositiveNumber(text.fontSize, 16)
    const lineHeightMm = fontSizePx * PX_TO_MM * 1.3
    const lines = Math.max(1, text.text.split('\n').length)

    return lines * lineHeightMm
}

export function getFixedPageCountForHeight(heightMm: number, pageHeightMm = A4_PAGE_HEIGHT_MM) {
    const fixedPageHeight = Math.max(1, getPositiveNumber(pageHeightMm, A4_PAGE_HEIGHT_MM))

    return Math.max(1, Math.ceil(Math.max(0, heightMm) / fixedPageHeight))
}

export function getCustomTemplateLayoutOverflowHeightMm(layout: Pick<CustomTemplateLayout, 'annotations' | 'texts' | 'images' | 'shapes' | 'componentPositions'>) {
    let maxBottomMm = 0

    layout.annotations?.forEach((annotation) => {
        annotation.points.forEach((point) => {
            maxBottomMm = Math.max(
                maxBottomMm,
                getPositiveNumber(point.y) + getPositiveNumber(annotation.brushSize)
            )
        })
    })

    layout.images?.forEach((image) => {
        maxBottomMm = Math.max(
            maxBottomMm,
            getPositiveNumber(image.y) + (getPositiveNumber(image.width) * DEFAULT_OVERFLOW_IMAGE_HEIGHT_RATIO)
        )
    })

    layout.shapes?.forEach((shape) => {
        maxBottomMm = Math.max(
            maxBottomMm,
            getPdfShapeBottom(shape)
        )
    })

    layout.texts?.forEach((text) => {
        maxBottomMm = Math.max(
            maxBottomMm,
            getPositiveNumber(text.y) + estimateTextHeightMm(text)
        )
    })

    Object.values(layout.componentPositions || {}).forEach((position) => {
        maxBottomMm = Math.max(
            maxBottomMm,
            getPositiveNumber(position.y) + DEFAULT_OVERFLOW_COMPONENT_HEIGHT_MM
        )
    })

    return maxBottomMm
}

export function getCustomTemplateLayoutHeightMm(layout: Pick<CustomTemplateLayout, 'page' | 'annotations' | 'texts' | 'images' | 'shapes' | 'componentPositions'>) {
    const pageHeightMm = getPositiveNumber(layout.page?.heightMm, A4_PAGE_HEIGHT_MM)
    return Math.max(pageHeightMm, getCustomTemplateLayoutOverflowHeightMm(layout))
}

export function getCustomTemplateLayoutPageCount(layout: Pick<CustomTemplateLayout, 'page' | 'annotations' | 'texts' | 'images' | 'shapes' | 'componentPositions'>) {
    return getFixedPageCountForHeight(
        getCustomTemplateLayoutHeightMm(layout),
        getPositiveNumber(layout.page?.heightMm, A4_PAGE_HEIGHT_MM)
    )
}

export type CustomTemplatePreviewTarget = {
    moduleTypeKey: string
    nativeTemplateKey?: string
    templateId?: string
    label?: string
}

export type PrintPreviewEditorSource = {
    data?: UniversalInvoice
    features?: any
    workspaceId?: string
    workspaceName?: string
    workspaceFooterContacts?: any
    printFormat?: PrintFormat
    title: string
    onSave?: (blob: Blob) => Promise<string | undefined | void>
    /** Opens the browser/native print dialog without persisting the generated document. */
    onPrint?: (blob: Blob) => Promise<void>
    printActionLabel?: string
    invoiceData?: any
    effectiveId?: string
    generatePdfBlob?: (editedData: UniversalInvoice, printLangOverride?: string) => Promise<Blob>
    /** Fallback: PDF blob/data URL for read-only viewing when structured data isn't available */
    url?: string
    /** In-memory PDF bytes for read-only viewing without creating a long-lived object URL. */
    pdfBytes?: Uint8Array
    /** Restricts a native PDF source to navigation, zoom, back, and print controls. */
    interactionMode?: 'default' | 'read-only-print'
    /** Template preview mode for editable inline preview of custom templates (loans, orders, budget) */
    templatePreview?: TemplatePreview
    customTemplate?: CustomTemplatePreviewTarget
    templateFieldValues?: Record<string, string>
    initialTemplateLayout?: CustomTemplateLayout | null
    allowTemplateFieldEditing?: boolean
    templatePrimaryActionLabel?: string
    generateTemplateLayoutBlob?: (layout: CustomTemplateLayout, printLangOverride?: string, effectiveId?: string) => Promise<Blob>
    onSaveTemplateLayout?: (layout: CustomTemplateLayout, options?: { label?: string }) => Promise<void>
}

let _printPreviewEditorSource: PrintPreviewEditorSource | null = null

export function setPrintPreviewEditorSource(source: PrintPreviewEditorSource) {
    _printPreviewEditorSource = source
}

export function getPrintPreviewEditorSource(): PrintPreviewEditorSource | null {
    return _printPreviewEditorSource
}

export function clearPrintPreviewEditorSource() {
    _printPreviewEditorSource = null
}

export type PendingPrintPreviewEditorView = {
    url: string
    title: string
}

let _pendingPrintPreviewEditorView: PendingPrintPreviewEditorView | null = null
const _pendingPrintPreviewEditorViewListeners = new Set<() => void>()

function notifyPendingPrintPreviewEditorViewListeners() {
    _pendingPrintPreviewEditorViewListeners.forEach(cb => cb())
}

export function subscribeToPendingPrintPreviewEditorView(callback: () => void): () => void {
    _pendingPrintPreviewEditorViewListeners.add(callback)
    return () => { _pendingPrintPreviewEditorViewListeners.delete(callback) }
}

export function setPendingPrintPreviewEditorView(view: PendingPrintPreviewEditorView) {
    _pendingPrintPreviewEditorView = view
    notifyPendingPrintPreviewEditorViewListeners()
}

export function getPendingPrintPreviewEditorView(): PendingPrintPreviewEditorView | null {
    return _pendingPrintPreviewEditorView
}

export function clearPendingPrintPreviewEditorView() {
    _pendingPrintPreviewEditorView = null
    notifyPendingPrintPreviewEditorViewListeners()
}
