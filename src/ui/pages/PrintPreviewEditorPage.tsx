import { type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Printer, Loader2, Edit3, X, ZoomIn, ZoomOut, Maximize, ImagePlus, Trash2, PenTool, Brush, Palette, Eraser, Hand, Type, RotateCw, Scaling, Move, Languages, Check, Shapes } from 'lucide-react'
import {
    A4_PAGE_HEIGHT_MM,
    getPrintPreviewEditorSource,
    clearPrintPreviewEditorSource,
    setPendingPrintPreviewEditorView,
    getCustomTemplateLayoutHeightMm,
    getFixedPageCountForHeight,
    shouldReflowCustomTemplateText,
    type CustomTemplateAnnotation,
    type CustomTemplateBackground,
    type CustomTemplateComponentPosition,
    type CustomTemplateImage,
    type CustomTemplateLayout,
    type CustomTemplateShape,
    type CustomTemplateText
} from '@/lib/printPreviewEditorStore'
import { platformService } from '@/services/platformService'
import { paginateOrderItemsStatementPages, paginateOrderItemsTables } from '@/lib/orderItemsTablePagination'
import { centerTablesOnPages } from '@/lib/centeredTablePagination'
import { EditableField } from '@/ui/components/EditableField'
import {
    A4InvoiceTemplate,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    ModernA4InvoiceTemplate,
    ProfessionalA4InvoiceTemplate,
    RefundA4InvoiceTemplate,
    RefundPrimaryA4InvoiceTemplate,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger
} from '@/ui/components'
import { SaleReceiptBase } from '@/ui/components/SaleReceipt'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { cn } from '@/lib/utils'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'
import type { UniversalInvoice } from '@/types'
import { useAuth } from '@/auth/AuthContext'
import { usePartnerAccountStatementPrintBalances } from '@/hooks/usePartnerAccountStatement'
import { UiAccessGate, useUiAccess } from '@/context/UiAccessContext'
import { AttachedShapesOverlay } from '@/ui/components/AttachedShapesOverlay'
import { PDF_SHAPE_OPTIONS } from '@/ui/components/PdfShapeGraphic'
import { PdfJsViewer } from '@/ui/components/PdfJsViewer'
import { useToast } from '@/ui/components/use-toast'
import { ProgressToast } from '@/ui/components/ProgressToast'
import { subscribePdfProgress } from '@/services/pdfProgress'
import { printPdfBlob } from '@/services/pdfPrintService'
import { resolvePdfBytes } from '@/lib/pdfViewerBytes'
import type { PdfShapeKind } from '@/types'

const PREVIEW_PAGE_BREAK_SELECTOR = [
    '[data-pdf-keep-together]',
    '[data-qr-sharp="true"]',
    'table',
    '.break-inside-avoid',
    '.page-break-inside-avoid'
].join(', ')
const PREVIEW_PAGE_BREAK_MARGIN = 'printPreviewEditorPageBreakMargin'
const PREVIEW_PAGE_BREAK_ORIGINAL_MARGIN = 'printPreviewEditorPageBreakOriginalMargin'
const PREVIEW_PAGE_BREAK_MARGIN_ATTRIBUTE = 'data-print-preview-editor-page-break-margin'
const PREVIEW_PAGE_BREAK_TRANSFORM = 'printPreviewEditorPageBreakTransform'
const PREVIEW_PAGE_BREAK_ORIGINAL_TRANSLATE = 'printPreviewEditorPageBreakOriginalTranslate'
const PREVIEW_PAGE_BREAK_TRANSFORM_ATTRIBUTE = 'data-print-preview-editor-page-break-transform'
const PAGE_BREAK_EPSILON_MM = 0.05

function getClipboardImageFile(event: ClipboardEvent): File | null {
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) => (
        item.kind === 'file' && item.type.startsWith('image/')
    ))

    return imageItem?.getAsFile() || null
}

function isTextPasteTarget(target: EventTarget | null) {
    return target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
}

function resetPreviewPageBreakMargins(contentLayer: HTMLElement) {
    contentLayer.querySelectorAll<HTMLElement>([
        `[${PREVIEW_PAGE_BREAK_MARGIN_ATTRIBUTE}]`,
        `[${PREVIEW_PAGE_BREAK_TRANSFORM_ATTRIBUTE}]`
    ].join(', ')).forEach((element) => {
        if (element.dataset[PREVIEW_PAGE_BREAK_MARGIN]) {
            element.style.marginTop = element.dataset[PREVIEW_PAGE_BREAK_ORIGINAL_MARGIN] || ''
            delete element.dataset[PREVIEW_PAGE_BREAK_MARGIN]
            delete element.dataset[PREVIEW_PAGE_BREAK_ORIGINAL_MARGIN]
        }
        if (element.dataset[PREVIEW_PAGE_BREAK_TRANSFORM]) {
            element.style.setProperty('translate', element.dataset[PREVIEW_PAGE_BREAK_ORIGINAL_TRANSLATE] || '')
            delete element.dataset[PREVIEW_PAGE_BREAK_TRANSFORM]
            delete element.dataset[PREVIEW_PAGE_BREAK_ORIGINAL_TRANSLATE]
        }
    })
}

function getPreviewPageBreakAnchor(
    block: HTMLElement,
    stage: HTMLElement,
    millimetersPerPixel: number
) {
    const movableComponent = block.closest<HTMLElement>('[data-order-print-component]')
    if (!movableComponent || !stage.contains(movableComponent)) return block

    const parent = movableComponent.parentElement
    if (!parent || parent === stage) return movableComponent

    const display = window.getComputedStyle(parent).display
    if (!display.includes('grid') && !display.includes('flex')) return movableComponent

    const stageTop = stage.getBoundingClientRect().top
    const parentTopMm = (parent.getBoundingClientRect().top - stageTop) * millimetersPerPixel
    const componentTopMm = (movableComponent.getBoundingClientRect().top - stageTop) * millimetersPerPixel

    // Grid/flex siblings that begin on the same line are exported together by
    // the PDF paginator. Move the shared row to keep the preview in sync.
    return Math.abs(parentTopMm - componentTopMm) < PAGE_BREAK_EPSILON_MM
        ? parent
        : movableComponent
}

/**
 * Native templates keep their watermark inside an opaque white document root.
 * The editor's page cards therefore cannot own the watermark themselves. Hide
 * the single document-height image and temporarily add a clipped, centered
 * copy inside that root for each visible A4 page instead.
 */
function repeatPreviewA4Watermarks(
    stage: HTMLElement,
    contentLayer: HTMLElement,
    pageCount: number,
    pageHeightMm: number,
    pageWidthMm: number
) {
    const watermarks = Array.from(
        contentLayer.querySelectorAll<HTMLImageElement>(
            '[data-atlas-standard-background]:not([data-print-preview-repeated-watermark])'
        )
    )
    if (watermarks.length === 0 || pageCount < 1) return () => undefined

    const stageRect = stage.getBoundingClientRect()
    if (stageRect.width <= 0) return () => undefined

    const pixelsToMm = pageWidthMm / stageRect.width
    const restoreWatermarks: Array<() => void> = []

    watermarks.forEach((watermark) => {
        const host = watermark.parentElement
        if (!(host instanceof HTMLElement)) return

        const hostTopMm = (host.getBoundingClientRect().top - stageRect.top) * pixelsToMm
        const originalVisibility = watermark.style.visibility
        const layers: HTMLElement[] = []

        watermark.style.visibility = 'hidden'

        Array.from({ length: pageCount }).forEach((_, pageIndex) => {
            const layer = document.createElement('div')
            layer.dataset.printPreviewWatermarkLayer = String(pageIndex + 1)
            Object.assign(layer.style, {
                position: 'absolute',
                left: '0',
                top: `${pageIndex * pageHeightMm - hostTopMm}mm`,
                width: '100%',
                height: `${pageHeightMm}mm`,
                overflow: 'hidden',
                pointerEvents: 'none',
                zIndex: '-10'
            })

            const pageWatermark = watermark.cloneNode(false) as HTMLImageElement
            pageWatermark.removeAttribute('id')
            pageWatermark.dataset.printPreviewRepeatedWatermark = 'true'
            Object.assign(pageWatermark.style, {
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 'auto',
                visibility: 'visible'
            })

            layer.appendChild(pageWatermark)
            host.appendChild(layer)
            layers.push(layer)
        })

        restoreWatermarks.push(() => {
            watermark.style.visibility = originalVisibility
            layers.forEach((layer) => layer.remove())
        })
    })

    return () => restoreWatermarks.forEach((restore) => restore())
}

const LanguageSelector = ({ value, onChange }: { value: string, onChange: (val: string) => void }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const languages = [
        { id: 'auto', label: 'Auto Lang' },
        { id: 'en', label: 'English' },
        { id: 'ar', label: 'العربية' },
        { id: 'ku', label: 'Kurdish' }
    ];

    const currentLabel = languages.find(l => l.id === value)?.label || 'Auto Lang';

    return (
        <div className="relative" ref={containerRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    "h-7 px-2 flex items-center gap-2 rounded transition-all outline-none",
                    isOpen ? "bg-accent text-accent-foreground shadow-inner" : "hover:bg-accent text-muted-foreground"
                )}
                title="Temporary Print Language"
            >
                <Languages className="h-3.5 w-3.5" />
                <span className="text-[11px] font-bold whitespace-nowrap">{currentLabel}</span>
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 mt-1.5 w-32 bg-card border rounded-lg shadow-xl py-1 z-50 animate-in fade-in zoom-in duration-100">
                    {languages.map((lang) => (
                        <button
                            key={lang.id}
                            onClick={() => {
                                onChange(lang.id);
                                setIsOpen(false);
                            }}
                            className={cn(
                                "w-full px-3 py-1.5 flex items-center justify-between text-[11px] transition-colors",
                                value === lang.id ? "bg-primary/10 text-primary font-bold" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                            )}
                        >
                            <span>{lang.label}</span>
                            {value === lang.id && <Check className="h-3 w-3" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

const ShapeToolbarButton = ({ onAdd }: { onAdd: (kind: PdfShapeKind) => void }) => {
    const [isOpen, setIsOpen] = useState(false)

    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setIsOpen((current) => !current)}
                className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-primary md:w-auto md:gap-1.5 md:px-2 md:text-[11px] md:font-bold"
                title="Add Shape"
                aria-label="Add Shape"
                aria-expanded={isOpen}
            >
                <Shapes className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Add Shape</span>
            </button>
            {isOpen && (
                <div className="absolute left-0 top-full z-50 mt-1.5 flex gap-1 rounded-md border bg-card p-1.5 shadow-lg">
                    {PDF_SHAPE_OPTIONS.map(({ kind, label, Icon }) => (
                        <button
                            key={kind}
                            type="button"
                            onClick={() => {
                                onAdd(kind)
                                setIsOpen(false)
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
                            title={label}
                            aria-label={`Add ${label}`}
                        >
                            <Icon className="h-4 w-4" />
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}


function EditablePrintPreviewEditor({
    data,
    features,
    workspaceId,
    workspaceName,
    workspaceFooterContacts,
    printFormat,
    onDataChange,
    drawingMode,
    hideUnit,
    hideDiscount,
    showNotes,
    tableRowCount,
    hiddenFields,
    onHiddenFieldChange,
}: {
    data: UniversalInvoice
    features: any
    workspaceId?: string
    workspaceName?: string
    workspaceFooterContacts?: any
    printFormat: 'a4' | 'receipt'
    onDataChange?: (data: UniversalInvoice) => void
    drawingMode?: string
    hideUnit?: boolean
    hideDiscount?: boolean
    showNotes?: boolean
    tableRowCount?: number
    hiddenFields?: Record<string, boolean>
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
}) {
    const { i18n } = useTranslation()
    const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const isRTL = printLang === 'ar' || printLang === 'ku'


    if (printFormat === 'receipt') {
        return (
            <div className="mx-auto" style={{ width: '80mm', maxWidth: '100%' }}>
                <SaleReceiptBase
                    data={data}
                    features={features}
                    workspaceName={workspaceName || 'Atlas'}
                    workspaceId={workspaceId}
                />
            </div>
        )
    }

    if (data.is_refund_invoice) {
        if (features.a4_template === 'modern') {
            return (
                <div className="max-w-[900px] mx-auto">
                    <RefundA4InvoiceTemplate
                        data={data}
                        features={features}
                        workspaceId={workspaceId}
                        workspaceName={workspaceName || 'Atlas'}
                        drawingMode={drawingMode}
                    />
                </div>
            )
        }
        return (
            <div dir={isRTL ? 'rtl' : 'ltr'} className="bg-white text-black text-sm font-sans max-w-[900px] mx-auto shadow-sm border border-gray-200">
                <RefundPrimaryA4InvoiceTemplate
                    data={data}
                    features={features}
                    workspaceId={workspaceId}
                    workspaceName={workspaceName || 'Atlas'}
                    workspaceFooterContacts={workspaceFooterContacts}
                    drawingMode={drawingMode}
                />
            </div>
        )
    }

    if (features.a4_template === 'professional') {
        return (
            <div className="max-w-[900px] mx-auto">
                <ProfessionalA4InvoiceTemplate
                    data={data}
                    features={features}
                    workspaceId={workspaceId}
                    workspaceName={workspaceName || 'Atlas'}
                    workspaceFooterContacts={workspaceFooterContacts}
                    onDataChange={onDataChange}
                    drawingMode={drawingMode}
                    hideUnit={hideUnit}
                    hideDiscount={hideDiscount}
                    showNotes={showNotes}
                    hiddenFields={hiddenFields || data.hiddenPrintFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                />
            </div>
        )
    }

    if (features.a4_template === 'modern') {
        return (
            <div className="max-w-[900px] mx-auto">
                <ModernA4InvoiceTemplate
                    data={data}
                    features={features}
                    workspaceId={workspaceId}
                    workspaceName={workspaceName || 'Atlas'}
                    workspaceFooterContacts={workspaceFooterContacts}
                    onDataChange={onDataChange}
                    drawingMode={drawingMode}
                    hideUnit={hideUnit}
                    hideDiscount={hideDiscount}
                />
            </div>
        )
    }

    return (
        <div dir={isRTL ? 'rtl' : 'ltr'} className="bg-white text-black text-sm font-sans max-w-[900px] mx-auto shadow-sm border border-gray-200">
            <A4InvoiceTemplate
                data={data}
                features={features}
                workspaceId={workspaceId}
                workspaceName={workspaceName || 'Atlas'}
                workspaceFooterContacts={workspaceFooterContacts}
                onDataChange={onDataChange}
                drawingMode={drawingMode}
                hideUnit={hideUnit}
                hideDiscount={hideDiscount}
                tableRowCount={tableRowCount}
            />
        </div>
    )
}

export function PrintPreviewEditorPage() {
    const { t } = useTranslation()
    const { hasRole } = useAuth()
    const isAdmin = hasRole(['admin'])
    const { isAccessKeyHeld } = useUiAccess()
    const [isSaving, setIsSaving] = useState(false)
    const [tempPrintLang, setTempPrintLang] = useState<string>('auto')
    const { toast, dismiss } = useToast()

    const progressToastRef = useRef<ReturnType<typeof toast> | null>(null)
    const unsubscribeProgressRef = useRef<(() => void) | null>(null)
    const lastProgressPercentRef = useRef(-1)
    const lastProgressStageRef = useRef('')

    const finishProgressToast = useCallback(() => {
        unsubscribeProgressRef.current?.()
        unsubscribeProgressRef.current = null
        if (progressToastRef.current) {
            dismiss(progressToastRef.current.id)
            progressToastRef.current = null
        }
    }, [dismiss])

    const beginProgressToast = useCallback((toastTitle: string) => {
        finishProgressToast()
        lastProgressPercentRef.current = -1
        lastProgressStageRef.current = ''
        progressToastRef.current = toast({
            title: toastTitle,
            description: <ProgressToast fraction={0} />,
            duration: 600000,
            placement: 'floating',
        })
        const progressToast = progressToastRef.current
        unsubscribeProgressRef.current = subscribePdfProgress((report) => {
            const percent = Math.floor(report.fraction * 100)
            const stageChanged = report.stageKey !== lastProgressStageRef.current
            if (percent === lastProgressPercentRef.current && !stageChanged) return
            lastProgressPercentRef.current = percent
            lastProgressStageRef.current = report.stageKey
            progressToastRef.current?.update({
                id: progressToast.id,
                description: (
                    <ProgressToast
                        fraction={report.fraction}
                        stageKey={report.stageKey}
                        page={report.page}
                        total={report.total}
                    />
                )
            })
        })
    }, [finishProgressToast, toast])

    useEffect(() => () => {
        unsubscribeProgressRef.current?.()
    }, [])

    const sourceRef = useRef(getPrintPreviewEditorSource())
    const source = sourceRef.current
    const templateStageRef = useRef<HTMLDivElement>(null)
    const templateContentLayerRef = useRef<HTMLDivElement>(null)
    const [editableData, setEditableData] = useState<UniversalInvoice | null>(null)
    const [zoom, setZoom] = useState(100)
    const [isFitToWidth, setIsFitToWidth] = useState(false)
    const [drawingMode, setDrawingMode] = useState<'none' | 'pen' | 'brush' | 'eraser'>('none')
    const [brushColor, setBrushColor] = useState('#ef4444')
    const [brushSize, setBrushSize] = useState(2)
    const [isDrawing, setIsDrawing] = useState(false)
    const [currentPath, setCurrentPath] = useState<{ x: number, y: number }[] | null>(null)
    const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false)
    const [isTemplateLabelDialogOpen, setIsTemplateLabelDialogOpen] = useState(false)
    const [templateSaveLabel, setTemplateSaveLabel] = useState('')
    const [pendingTemplateLayout, setPendingTemplateLayout] = useState<CustomTemplateLayout | null>(null)
    const [measuredTemplateHeightMm, setMeasuredTemplateHeightMm] = useState(0)
    const title = source?.title || t('printPreviewEditor.title') || 'Print Preview Editor'

    const handleZoomIn = useCallback(() => {
        setZoom(prev => Math.min(prev + 10, 200))
        setIsFitToWidth(false)
    }, [])

    const handleZoomOut = useCallback(() => {
        setZoom(prev => Math.max(prev - 10, 50))
        setIsFitToWidth(false)
    }, [])

    const handleZoomReset = useCallback(() => {
        setZoom(100)
        setIsFitToWidth(false)
    }, [])

    const handleFitToWidth = useCallback(() => {
        setIsFitToWidth(prev => !prev)
    }, [])

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
                e.preventDefault()
                return
            }
            if (e.ctrlKey || e.metaKey) {
                if (e.key === '=' || e.key === '+') {
                    e.preventDefault()
                    handleZoomIn()
                } else if (e.key === '-') {
                    e.preventDefault()
                    handleZoomOut()
                } else if (e.key === '0') {
                    e.preventDefault()
                    handleZoomReset()
                }
            }
        }

        const handleWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault()
                if (e.deltaY < 0) {
                    handleZoomIn()
                } else {
                    handleZoomOut()
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        window.addEventListener('wheel', handleWheel, { passive: false })

        return () => {
            window.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('wheel', handleWheel)
        }
    }, [handleZoomIn, handleZoomOut, handleZoomReset])

    const initialized = useRef(false)
    if (source && source.data && !initialized.current) {
        editableData === null && setEditableData({ ...source.data })
        initialized.current = true
    }

    // Template preview mode (loans, orders, budget)
    const templatePreview = source?.templatePreview
    const [freshPartnerBalanceState, setFreshPartnerBalanceState] = useState<'loading' | 'ready' | 'error'>(
        () => templatePreview?.requiresFreshPartnerBalance ? 'loading' : 'ready'
    )
    const freshPartnerBalanceRequest = templatePreview?.freshPartnerBalanceRequest
    const {
        currentBalances: freshPartnerBalances,
        isRefreshing: isFreshPartnerBalanceRefreshing,
        refreshError: freshPartnerBalanceRefreshError
    } = usePartnerAccountStatementPrintBalances(
        freshPartnerBalanceRequest?.workspaceId,
        freshPartnerBalanceRequest?.partnerId,
        undefined
    )
    const nextFreshPartnerBalanceState: 'loading' | 'ready' | 'error' = !templatePreview?.requiresFreshPartnerBalance
        ? 'ready'
        : !freshPartnerBalanceRequest || freshPartnerBalanceRefreshError
            ? 'error'
            : isFreshPartnerBalanceRefreshing || freshPartnerBalances === undefined
                ? 'loading'
                : 'ready'

    useEffect(() => {
        templatePreview?.onFreshPartnerBalanceStateChange?.(
            nextFreshPartnerBalanceState,
            nextFreshPartnerBalanceState === 'ready' ? freshPartnerBalances : undefined
        )
        setFreshPartnerBalanceState((current) => (
            current === nextFreshPartnerBalanceState ? current : nextFreshPartnerBalanceState
        ))
    }, [freshPartnerBalances, nextFreshPartnerBalanceState, templatePreview])

    const isTemplatePrintReady = !templatePreview?.requiresFreshPartnerBalance
        || freshPartnerBalanceState === 'ready'
    const fixedTemplatePrintLang = templatePreview?.fixedPrintLang
    const initialTemplateLayout = source?.initialTemplateLayout
    const templatePage = initialTemplateLayout?.page || templatePreview?.page || {
        widthMm: 210,
        heightMm: 297
    }
    const templatePageWidth = templatePage.widthMm
    const templatePageHeight = templatePage.heightMm
    const canEditTemplateFields = Boolean(source?.allowTemplateFieldEditing || isAdmin)
    const sourceWorkspaceFooterContacts = source?.workspaceFooterContacts
    const [fieldValues, setFieldValues] = useState<Record<string, string>>(
        () => {
            const initial: Record<string, string> = {
                hideUnit: localStorage.getItem('atlas_print_hide_unit') || 'false',
                hideDiscount: localStorage.getItem('atlas_print_hide_discount') || 'false',
                showNotes: localStorage.getItem('atlas_print_show_notes') || 'false',
                hideNextDue: localStorage.getItem('atlas_print_hide_next_due') || 'false',
                hideDueDate: localStorage.getItem('atlas_print_hide_due_date') || 'false',
                tableRowCount: localStorage.getItem('atlas_print_table_row_count') || '10',
            }
            if (templatePreview) {
                templatePreview.fields.forEach(f => {
                    initial[f.key] = f.value
                })
                if (source?.templateFieldValues) {
                    Object.assign(initial, source.templateFieldValues)
                }
                if (initialTemplateLayout?.fields) {
                    Object.assign(initial, initialTemplateLayout.fields)
                }
            }
            return initial
        }
    )
    const [editPanelOpen, setEditPanelOpen] = useState(false)

    const [templateAnnotations, setTemplateAnnotations] = useState<CustomTemplateAnnotation[]>(() => initialTemplateLayout?.annotations || [])
    const [templateTexts, setTemplateTexts] = useState<CustomTemplateText[]>(() => initialTemplateLayout?.texts || [])
    const [templateTextFlowStartMm, setTemplateTextFlowStartMm] = useState<number | null>(null)
    const [templateImages, setTemplateImages] = useState<CustomTemplateImage[]>(() => initialTemplateLayout?.images || [])
    const [templateShapes, setTemplateShapes] = useState<CustomTemplateShape[]>(() => initialTemplateLayout?.shapes || [])
    const [selectedTemplateObjectId, setSelectedTemplateObjectId] = useState<string | null>(null)
    const [templateComponentPositions, setTemplateComponentPositions] = useState<Record<string, CustomTemplateComponentPosition>>(() => ({
        ...Object.fromEntries((templatePreview?.movableComponents || []).map((component) => [
            component.key,
            component.defaultPosition || { x: 0, y: 0 }
        ])),
        ...(initialTemplateLayout?.componentPositions || {})
    }))
    const [templateHiddenFields, setTemplateHiddenFields] = useState<Record<string, boolean>>(() => initialTemplateLayout?.hiddenFields || {})
    const [templateFieldOrders, setTemplateFieldOrders] = useState<Record<string, string[]>>(() => initialTemplateLayout?.fieldOrders || {})
    const [templateFieldLabelOverrides, setTemplateFieldLabelOverrides] = useState<Record<string, string>>(() => initialTemplateLayout?.fieldLabelOverrides || {})
    const [templateFieldDisplayModes, setTemplateFieldDisplayModes] = useState<Record<string, string>>(() => initialTemplateLayout?.fieldDisplayModes || {})
    const [templateBackground, setTemplateBackground] = useState<CustomTemplateBackground | null>(() => initialTemplateLayout?.background || null)
    useEffect(() => {
        if (!selectedTemplateObjectId) return

        const clearSelectionOutsidePrint = (event: PointerEvent) => {
            if (!templateStageRef.current?.contains(event.target as Node)) {
                setSelectedTemplateObjectId(null)
            }
        }

        window.addEventListener('pointerdown', clearSelectionOutsidePrint)
        return () => window.removeEventListener('pointerdown', clearSelectionOutsidePrint)
    }, [selectedTemplateObjectId])
    const handleTemplateComponentPositionChange = useCallback((
        key: string,
        position: CustomTemplateComponentPosition
    ) => {
        setTemplateComponentPositions((current) => ({
            ...current,
            [key]: position
        }))
    }, [])
    const handleTemplateStackSelection = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const clickedObject = (event.target as HTMLElement).closest<HTMLElement>('[data-pdf-template-object-id]')

        if (!event.shiftKey || drawingMode !== 'none') {
            if (selectedTemplateObjectId && clickedObject?.dataset.pdfTemplateObjectId !== selectedTemplateObjectId) {
                setSelectedTemplateObjectId(null)
            }
            return
        }

        const objectsUnderPointer: HTMLElement[] = []
        document.elementsFromPoint(event.clientX, event.clientY).forEach((element) => {
            const object = element.closest<HTMLElement>('[data-pdf-template-object-id]')
            if (object && !objectsUnderPointer.includes(object)) {
                objectsUnderPointer.push(object)
            }
        })

        if (objectsUnderPointer.length < 2) return

        const selectedIndex = selectedTemplateObjectId
            ? objectsUnderPointer.findIndex((object) => object.dataset.pdfTemplateObjectId === selectedTemplateObjectId)
            : -1
        const nextObject = objectsUnderPointer
            .slice(selectedIndex >= 0 ? selectedIndex + 1 : 1)
            .find((object) => object.dataset.pdfTemplateObjectKind !== 'component')
        const nextObjectId = nextObject?.dataset.pdfTemplateObjectId

        if (!nextObjectId) return

        event.preventDefault()
        event.stopPropagation()
        setSelectedTemplateObjectId(nextObjectId)
    }, [drawingMode, selectedTemplateObjectId])
    // Thermal receipts grow with their content; they do not have fixed page breaks.
    // The width fallback keeps older saved receipt templates free of A4-style guides.
    const isFixedPageTemplatePreview = source?.printFormat !== 'receipt' && templatePageWidth > 80
    const templateLayoutForMeasurement = {
        page: {
            widthMm: templatePageWidth,
            heightMm: templatePageHeight || A4_PAGE_HEIGHT_MM
        },
        annotations: templateAnnotations,
        texts: templateTexts,
        images: templateImages,
        shapes: templateShapes,
        componentPositions: templateComponentPositions
    }
    const estimatedTemplateHeightMm = getCustomTemplateLayoutHeightMm(templateLayoutForMeasurement)
    const templateContentHeightMm = isFixedPageTemplatePreview
        ? Math.max(
            templatePageHeight,
            estimatedTemplateHeightMm,
            measuredTemplateHeightMm
        )
        : Math.max(1, measuredTemplateHeightMm)
    const templatePageCount = isFixedPageTemplatePreview
        ? getFixedPageCountForHeight(templateContentHeightMm, templatePageHeight || A4_PAGE_HEIGHT_MM)
        : 1
    const templateStackHeight = isFixedPageTemplatePreview
        ? templatePageCount * (templatePageHeight || A4_PAGE_HEIGHT_MM)
        : templateContentHeightMm
    const drawingCoordinateHeight = templatePreview ? templateStackHeight : templatePageHeight
    const measureTemplateTextFlowStart = useCallback(() => {
        if (!templatePreview?.reflowLowerPageText) {
            setTemplateTextFlowStartMm((current) => current === null ? current : null)
            return
        }

        const stage = templateStageRef.current
        const contentLayer = templateContentLayerRef.current
        const anchor = contentLayer?.querySelector<HTMLElement>('[data-template-text-flow-anchor]')
        if (!stage || !anchor) {
            setTemplateTextFlowStartMm((current) => current === null ? current : null)
            return
        }

        const stageRect = stage.getBoundingClientRect()
        if (stageRect.width <= 0) return

        const anchorRect = anchor.getBoundingClientRect()
        const nextStartMm = ((anchorRect.bottom - stageRect.top) * templatePageWidth / stageRect.width) + 1
        if (!Number.isFinite(nextStartMm)) return

        setTemplateTextFlowStartMm((current) => (
            current !== null && Math.abs(current - nextStartMm) < 0.25 ? current : nextStartMm
        ))
    }, [templatePageWidth, templatePreview?.reflowLowerPageText])
    const measureTemplatePreviewHeight = useCallback(() => {
        const stage = templateStageRef.current
        if (!stage || !templatePreview) return

        const stageRect = stage.getBoundingClientRect()
        if (stageRect.width <= 0) return

        const pxToMm = templatePageWidth / stageRect.width
        let maxBottomMm = isFixedPageTemplatePreview ? templatePageHeight : 0
        const contentLayer = templateContentLayerRef.current
        if (contentLayer) {
            maxBottomMm = Math.max(maxBottomMm, contentLayer.scrollHeight * pxToMm)
        }

        stage.querySelectorAll<HTMLElement>('[data-template-overflow-measure], [data-order-print-component]').forEach((element) => {
            const rect = element.getBoundingClientRect()
            const bottomMm = (rect.bottom - stageRect.top) * pxToMm
            if (Number.isFinite(bottomMm)) {
                maxBottomMm = Math.max(maxBottomMm, bottomMm)
            }
        })

        setMeasuredTemplateHeightMm((current) => (
            Math.abs(current - maxBottomMm) < 0.5 ? current : maxBottomMm
        ))
    }, [isFixedPageTemplatePreview, templatePageHeight, templatePageWidth, templatePreview])

    const syncPreviewPageBreaks = useCallback(() => {
        const stage = templateStageRef.current
        const contentLayer = templateContentLayerRef.current
        if (!stage || !contentLayer || !templatePreview || !isFixedPageTemplatePreview) return

        resetPreviewPageBreakMargins(contentLayer)

        const stageRect = stage.getBoundingClientRect()
        if (stageRect.width <= 0) return

        const millimetersPerPixel = templatePageWidth / stageRect.width
        const pageHeightMm = templatePageHeight || A4_PAGE_HEIGHT_MM

        paginateOrderItemsStatementPages(contentLayer, {
            pageHeightMm,
            pageWidthMm: templatePageWidth
        })

        paginateOrderItemsTables(contentLayer, {
            pageHeightMm,
            pageWidthMm: templatePageWidth
        })

        centerTablesOnPages(contentLayer, {
            pageHeightMm,
            pageWidthMm: templatePageWidth
        })

        const blocks = Array.from(contentLayer.querySelectorAll<HTMLElement>(PREVIEW_PAGE_BREAK_SELECTOR))
            .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)

        blocks.forEach((block) => {
            const rect = block.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) return

            const topMm = (rect.top - stageRect.top) * millimetersPerPixel
            const bottomMm = (rect.bottom - stageRect.top) * millimetersPerPixel
            const heightMm = bottomMm - topMm
            const currentPageStartMm = Math.floor(topMm / pageHeightMm) * pageHeightMm
            const currentPageEndMm = currentPageStartMm + pageHeightMm
            const crossesPageBoundary = topMm > currentPageStartMm + PAGE_BREAK_EPSILON_MM
                && topMm < currentPageEndMm - PAGE_BREAK_EPSILON_MM
                && bottomMm > currentPageEndMm + PAGE_BREAK_EPSILON_MM
                && heightMm <= pageHeightMm + PAGE_BREAK_EPSILON_MM

            if (!crossesPageBoundary) return

            const movableComponent = block.closest<HTMLElement>('[data-order-print-component]')
            const independentlyPositionedComponent = movableComponent?.closest<HTMLElement>(
                '[data-print-preview-editor-isolate-components]'
            )
                ? movableComponent
                : block.closest<HTMLElement>('[data-print-preview-editor-page-break-mode="transform"]')
            const anchor = independentlyPositionedComponent
                || getPreviewPageBreakAnchor(block, stage, millimetersPerPixel)
            const pageBreakOffsetMm = currentPageEndMm - topMm

            if (independentlyPositionedComponent) {
                if (!anchor.dataset[PREVIEW_PAGE_BREAK_TRANSFORM]) {
                    anchor.dataset[PREVIEW_PAGE_BREAK_TRANSFORM] = 'true'
                    anchor.dataset[PREVIEW_PAGE_BREAK_ORIGINAL_TRANSLATE] = anchor.style.getPropertyValue('translate')
                }
                // This keeps a manually positioned component out of the red-line area
                // without changing document flow and dragging its later siblings with it.
                anchor.style.setProperty('translate', `0 ${pageBreakOffsetMm}mm`)
                return
            }

            if (!anchor.dataset[PREVIEW_PAGE_BREAK_MARGIN]) {
                anchor.dataset[PREVIEW_PAGE_BREAK_MARGIN] = 'true'
                anchor.dataset[PREVIEW_PAGE_BREAK_ORIGINAL_MARGIN] = anchor.style.marginTop
            }
            anchor.style.marginTop = `${pageBreakOffsetMm}mm`
        })

        measureTemplatePreviewHeight()
        measureTemplateTextFlowStart()

    }, [
        isFixedPageTemplatePreview,
        measureTemplatePreviewHeight,
        measureTemplateTextFlowStart,
        templatePageHeight,
        templatePageWidth,
        templatePreview
    ])

    useLayoutEffect(() => {
        const contentLayer = templateContentLayerRef.current
        if (!contentLayer || !templatePreview || !isFixedPageTemplatePreview) return

        syncPreviewPageBreaks()
        const frame = window.requestAnimationFrame(syncPreviewPageBreaks)

        return () => {
            window.cancelAnimationFrame(frame)
            resetPreviewPageBreakMargins(contentLayer)
        }
    }, [
        fieldValues,
        isFixedPageTemplatePreview,
        measuredTemplateHeightMm,
        templateAnnotations,
        templateComponentPositions,
        templateHiddenFields,
        templateImages,
        templatePageHeight,
        templatePageWidth,
        templatePreview,
        templateShapes,
        templateTexts,
        syncPreviewPageBreaks
    ])

    useLayoutEffect(() => {
        const stage = templateStageRef.current
        const contentLayer = templateContentLayerRef.current
        if (!stage || !contentLayer || !templateBackground || !isFixedPageTemplatePreview) return

        return repeatPreviewA4Watermarks(
            stage,
            contentLayer,
            templatePageCount,
            templatePageHeight || A4_PAGE_HEIGHT_MM,
            templatePageWidth
        )
    }, [
        isFixedPageTemplatePreview,
        templateBackground,
        templatePageCount,
        templatePageHeight,
        templatePageWidth,
        templatePreview
    ])

    useEffect(() => {
        const stage = templateStageRef.current
        const contentLayer = templateContentLayerRef.current
        if (!stage || !contentLayer || !templatePreview || !isFixedPageTemplatePreview) return

        let frame: number | null = null
        const schedulePaginationSync = () => {
            if (frame !== null) window.cancelAnimationFrame(frame)
            frame = window.requestAnimationFrame(() => {
                frame = null
                syncPreviewPageBreaks()
            })
        }
        const observer = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(schedulePaginationSync)

        observer?.observe(stage)
        observer?.observe(contentLayer)

        const images = Array.from(contentLayer.querySelectorAll('img'))
        images.forEach((image) => {
            image.addEventListener('load', schedulePaginationSync)
            image.addEventListener('error', schedulePaginationSync)
        })
        void document.fonts?.ready.then(schedulePaginationSync)
        schedulePaginationSync()
        const settledLayoutTimeout = window.setTimeout(schedulePaginationSync, 150)

        return () => {
            if (frame !== null) window.cancelAnimationFrame(frame)
            window.clearTimeout(settledLayoutTimeout)
            observer?.disconnect()
            images.forEach((image) => {
                image.removeEventListener('load', schedulePaginationSync)
                image.removeEventListener('error', schedulePaginationSync)
            })
        }
    }, [isFixedPageTemplatePreview, syncPreviewPageBreaks, templatePreview])

    useEffect(() => {
        if (!templatePreview) return

        let frame = window.requestAnimationFrame(measureTemplatePreviewHeight)
        let observer: ResizeObserver | null = null

        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measureTemplatePreviewHeight)
            if (templateStageRef.current) observer.observe(templateStageRef.current)
            if (templateContentLayerRef.current) observer.observe(templateContentLayerRef.current)
        }

        window.addEventListener('resize', measureTemplatePreviewHeight)

        return () => {
            window.cancelAnimationFrame(frame)
            observer?.disconnect()
            window.removeEventListener('resize', measureTemplatePreviewHeight)
        }
    }, [
        fieldValues,
        measureTemplatePreviewHeight,
        templateAnnotations,
        templateComponentPositions,
        templateImages,
        templateShapes,
        templateHiddenFields,
        templatePreview,
        templateTexts
    ])

    const showNativePdf = Boolean((source?.url || source?.pdfBytes) && !source?.data)
    const hasTemplatePrimaryAction = Boolean(
        source?.onSaveTemplateLayout
        || source?.onSave
        || source?.onPrint
        || source?.generateTemplateLayoutBlob
    )

    const handleBack = useCallback(() => {
        clearPrintPreviewEditorSource()
        window.history.back()
    }, [])

    const handleSave = useCallback(async () => {
        if (!source || !editableData || isSaving) return
        beginProgressToast(title || t('print.progressTitle', { defaultValue: 'Saving & Printing' }))
        setIsSaving(true)
        try {
            if (source.generatePdfBlob) {
                const langOverride = tempPrintLang !== 'auto' ? tempPrintLang : undefined
                const blob = await source.generatePdfBlob(editableData, langOverride)
                const invoiceId = await source.onSave?.(blob)
                setPendingPrintPreviewEditorView({ url: URL.createObjectURL(blob), title: invoiceId ? `Invoice ${invoiceId}` : title })
                return
            } else {
                await source.onSave?.(new Blob())
            }
        } catch (err) {
            console.error('Failed to save:', err)
        } finally {
            finishProgressToast()
            setIsSaving(false)
            clearPrintPreviewEditorSource()
            window.history.back()
        }
    }, [source, editableData, isSaving, tempPrintLang, beginProgressToast, finishProgressToast, title, t])

    if (!source) {
        return (
            <div className="flex h-screen items-center justify-center bg-background"
                style={{ marginTop: 'var(--titlebar-height)', height: 'calc(100vh - var(--titlebar-height))' }}>
                <p className="text-muted-foreground">{t('common.noData') || 'No data'}</p>
            </div>
        )
    }

    const handleNativePrint = async () => {
        if ((!source?.url && !source?.pdfBytes) || isSaving) return

        setIsSaving(true)
        try {
            const bytes = source.pdfBytes?.slice()
                || (source.url ? await resolvePdfBytes(source.url) : null)
            if (!bytes) throw new Error('Failed to load PDF for printing.')

            const blob = new Blob([bytes], { type: 'application/pdf' })
            if (source.onPrint) await source.onPrint(blob)
            else await printPdfBlob(blob, { title })
        } catch (err) {
            console.error('Failed to print PDF:', err)
        } finally {
            setIsSaving(false)
        }
    }

    const buildTemplateLayout = useCallback((): CustomTemplateLayout | null => {
        if (!source || !templatePreview || !fieldValues || !source.customTemplate?.moduleTypeKey) {
            return null
        }

        return {
            version: 1,
            label: source.customTemplate.label || initialTemplateLayout?.label,
            moduleTypeKey: source.customTemplate.moduleTypeKey,
            nativeTemplateKey: source.customTemplate.nativeTemplateKey,
            page: {
                widthMm: templatePageWidth,
                heightMm: templatePageHeight
            },
            fields: fieldValues,
            fieldTokenTemplates: initialTemplateLayout?.fieldTokenTemplates,
            componentPositions: templateComponentPositions,
            hiddenFields: templateHiddenFields,
            fieldOrders: templateFieldOrders,
            fieldLabelOverrides: templateFieldLabelOverrides,
            fieldDisplayModes: templateFieldDisplayModes,
            background: templateBackground ?? undefined,
            annotations: templateAnnotations,
            texts: templateTexts,
            images: templateImages,
            shapes: templateShapes,
            updatedAt: new Date().toISOString()
        }
    }, [source, templatePreview, fieldValues, initialTemplateLayout?.label, templateAnnotations, templateComponentPositions, templateHiddenFields, templateFieldOrders, templateFieldLabelOverrides, templateFieldDisplayModes, templateBackground, templateTexts, templateImages, templateShapes, templatePageHeight, templatePageWidth])

    const saveTemplatePreview = useCallback(async (layout?: CustomTemplateLayout, label?: string) => {
        if (!source || !templatePreview || !fieldValues || isSaving || !isTemplatePrintReady) return
        beginProgressToast(title || t('print.progressTitle', { defaultValue: 'Saving & Printing' }))
        let shouldCloseAfterAction = true
        setIsSaving(true)
        try {
            if (layout && source.onSaveTemplateLayout) {
                await source.onSaveTemplateLayout(layout, { label })
            }

            const shouldBuildPrintBlob = source.onSave || source.onPrint || source.generateTemplateLayoutBlob
            if (shouldBuildPrintBlob) {
                const overrideLang = fixedTemplatePrintLang || (tempPrintLang !== 'auto' ? tempPrintLang : undefined)
                const layoutForBlob = source.generateTemplateLayoutBlob
                    ? layout || buildTemplateLayout()
                    : null
                if (source.generateTemplateLayoutBlob && !layoutForBlob) {
                    throw new Error('Missing template layout for print preview.')
                }
                const blob = source.generateTemplateLayoutBlob && layoutForBlob
                    ? await source.generateTemplateLayoutBlob(layoutForBlob, overrideLang, source.effectiveId)
                    : await templatePreview.buildPdf(
                        templatePreview.createElement(fieldValues, source.effectiveId, overrideLang, {
                            hiddenFields: templateHiddenFields,
                            fieldOrders: templateFieldOrders,
                            fieldLabelOverrides: templateFieldLabelOverrides,
                            fieldDisplayModes: templateFieldDisplayModes,
                            background: templateBackground ?? undefined,
                            workspaceFooterContacts: sourceWorkspaceFooterContacts
                        }),
                        overrideLang,
                        fieldValues
                    )

                if (source.onPrint) {
                    await source.onPrint(blob)
                    shouldCloseAfterAction = false
                    return
                }

                if (!source.onSave) {
                    const url = URL.createObjectURL(blob)
                    window.open(url, '_blank', 'noopener,noreferrer')
                    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
                    shouldCloseAfterAction = false
                    return
                }

                const invoiceId = await source.onSave(blob)
                setPendingPrintPreviewEditorView({ url: URL.createObjectURL(blob), title: invoiceId ? `Invoice ${invoiceId}` : title })
                setIsSaving(false)
                setIsTemplateLabelDialogOpen(false)
                setPendingTemplateLayout(null)
                clearPrintPreviewEditorSource()
                window.history.back()
                return
            }
        } catch (err) {
            console.error('Failed to save template preview:', err)
            shouldCloseAfterAction = false
        } finally {
            finishProgressToast()
            setIsSaving(false)
            if (shouldCloseAfterAction) {
                setIsTemplateLabelDialogOpen(false)
                setPendingTemplateLayout(null)
                clearPrintPreviewEditorSource()
                window.history.back()
            }
        }
    }, [source, templatePreview, fieldValues, isSaving, isTemplatePrintReady, fixedTemplatePrintLang, tempPrintLang, buildTemplateLayout, sourceWorkspaceFooterContacts, templateHiddenFields, templateFieldOrders, templateFieldLabelOverrides, templateBackground, beginProgressToast, finishProgressToast, title, t])

    const handleTemplatePreviewSave = useCallback(async () => {
        if (!source || !templatePreview || !fieldValues || isSaving || !isTemplatePrintReady) return

        if (source.onSaveTemplateLayout) {
            const layout = buildTemplateLayout()
            if (!layout) {
                console.error('Failed to save template preview:', new Error('Missing custom template module/type key.'))
                return
            }

            const defaultLabel = layout.label?.trim()
                || source.customTemplate?.label?.trim()
                || title
            setPendingTemplateLayout(layout)
            setTemplateSaveLabel(defaultLabel)
            setIsTemplateLabelDialogOpen(true)
            return
        }

        await saveTemplatePreview()
    }, [source, templatePreview, fieldValues, isSaving, isTemplatePrintReady, buildTemplateLayout, saveTemplatePreview, title])

    const handleConfirmTemplateLayoutSave = useCallback(async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!pendingTemplateLayout || isSaving) return

        const label = templateSaveLabel.trim()
        if (!label) return

        await saveTemplatePreview({
            ...pendingTemplateLayout,
            label,
            updatedAt: new Date().toISOString()
        }, label)
    }, [pendingTemplateLayout, isSaving, saveTemplatePreview, templateSaveLabel])

    const handleFieldChange = useCallback((key: string, value: string) => {
        if (key === 'hideNextDue') {
            localStorage.setItem('atlas_print_hide_next_due', value)
        } else if (key === 'hideDueDate') {
            localStorage.setItem('atlas_print_hide_due_date', value)
        } else if (key === 'hideUnit') {
            localStorage.setItem('atlas_print_hide_unit', value)
        } else if (key === 'hideDiscount') {
            localStorage.setItem('atlas_print_hide_discount', value)
        } else if (key === 'showNotes') {
            localStorage.setItem('atlas_print_show_notes', value)
        } else if (key === 'tableRowCount') {
            localStorage.setItem('atlas_print_table_row_count', value)
        }
        setFieldValues(prev => ({ ...prev, [key]: value }))
    }, [])

    const handleTemplateHiddenFieldChange = useCallback((key: string, hidden: boolean) => {
        setTemplateHiddenFields((current) => {
            const next = { ...current }
            if (hidden) {
                next[key] = true
            } else {
                delete next[key]
            }
            return next
        })
    }, [])

    const handleTemplateFieldOrderChange = useCallback((sectionKey: string, fieldKeys: string[]) => {
        setTemplateFieldOrders((current) => ({
            ...current,
            [sectionKey]: fieldKeys
        }))
    }, [])

    const handleTemplateFieldLabelChange = useCallback((fieldKey: string, label: string) => {
        setTemplateFieldLabelOverrides((current) => {
            const next = { ...current }
            const title = label.trim()
            if (title) {
                next[fieldKey] = title
            } else {
                delete next[fieldKey]
            }
            return next
        })
    }, [])

    const handleTemplateFieldDisplayModeChange = useCallback((fieldKey: string, mode: string) => {
        setTemplateFieldDisplayModes((current) => {
            const next = { ...current }
            if (mode.trim()) {
                next[fieldKey] = mode.trim()
            } else {
                delete next[fieldKey]
            }
            return next
        })
    }, [])

    const handleInvoiceHiddenFieldChange = useCallback((key: string, hidden: boolean) => {
        setEditableData((current) => {
            if (!current) return current
            const nextHiddenFields = { ...(current.hiddenPrintFields || {}) }
            if (hidden) {
                nextHiddenFields[key] = true
            } else {
                delete nextHiddenFields[key]
            }
            return {
                ...current,
                hiddenPrintFields: nextHiddenFields
            }
        })
    }, [])

    const addTemplateImage = useCallback((path: string) => {
        setTemplateImages(prev => [...prev, {
            path,
            x: Math.max(5, templatePageWidth * 0.2),
            y: 50,
            width: Math.max(15, templatePageWidth * 0.3)
        }])
    }, [templatePageWidth])

    const handleAddTemplateImage = useCallback(async () => {
        if (!source?.workspaceId) return
        try {
            const relPath = await platformService.pickAndSaveImage(source.workspaceId, 'attached-images')
            if (relPath) {
                addTemplateImage(relPath)
            }
        } catch (error) {
            error instanceof Error && console.error('Failed to add image:', error.message)
        }
    }, [addTemplateImage, source?.workspaceId])

    const handlePasteTemplateImage = useCallback(async (image: File) => {
        if (!source?.workspaceId) return
        try {
            const relPath = await platformService.saveImageFile(image, source.workspaceId, 'attached-images')
            if (relPath) addTemplateImage(relPath)
        } catch (error) {
            error instanceof Error && console.error('Failed to paste image:', error.message)
        }
    }, [addTemplateImage, source?.workspaceId])

    const handleUploadTemplateBackground = useCallback(async () => {
        if (!source?.workspaceId) return
        try {
            const relPath = await platformService.pickAndSaveImage(source.workspaceId, 'attached-images')
            if (relPath) {
                setTemplateBackground({ path: relPath, opacity: 15, size: 100 })
            }
        } catch (error) {
            error instanceof Error && console.error('Failed to upload background watermark:', error.message)
        }
    }, [source?.workspaceId])

    const handleAddTemplateText = useCallback(() => {
        setTemplateTexts(prev => [...prev, {
            id: Math.random().toString(36).substr(2, 9),
            text: 'NEW TEXT',
            x: Math.max(5, templatePageWidth * 0.2),
            y: 60,
            width: Math.max(20, templatePageWidth * 0.4),
            rotation: 0,
            fontSize: 16,
            color: brushColor
        }])
    }, [brushColor, templatePageWidth])

    const handleAddTemplateShape = useCallback((kind: PdfShapeKind) => {
        const width = Math.max(12, templatePageWidth * 0.2)
        const x = templatePageWidth / 2
        const y = 70
        setTemplateShapes(prev => [...prev, {
            id: Math.random().toString(36).slice(2, 11),
            kind,
            x,
            y,
            width,
            height: width,
            rotation: 0,
            color: brushColor
        }])
    }, [brushColor, templatePageWidth])

    const addImage = useCallback((path: string) => {
        setEditableData(prev => {
            if (!prev) return null
            const current = prev.attached_images || []
            return {
                ...prev,
                attached_images: [...current, {
                    path,
                    x: 50, // Default mid X (mm)
                    y: 50, // Default mid Y (mm)
                    width: 60, // Default width (mm)
                }]
            }
        })
    }, [])

    const handleAddImage = useCallback(async () => {
        if (!source?.workspaceId) return
        try {
            const relPath = await platformService.pickAndSaveImage(source.workspaceId, 'attached-images')
            if (relPath) {
                addImage(relPath)
            }
        } catch (error) {
            error instanceof Error && console.error('Failed to add image:', error.message)
        }
    }, [addImage, source?.workspaceId])

    const handlePasteImage = useCallback(async (image: File) => {
        if (!source?.workspaceId) return
        try {
            const relPath = await platformService.saveImageFile(image, source.workspaceId, 'attached-images')
            if (relPath) addImage(relPath)
        } catch (error) {
            error instanceof Error && console.error('Failed to paste image:', error.message)
        }
    }, [addImage, source?.workspaceId])

    const handleRemoveImage = useCallback((path: string) => {
        setEditableData(prev => {
            if (!prev) return null
            const current = prev.attached_images || []
            return {
                ...prev,
                attached_images: current.filter(p => p.path !== path)
            }
        })
    }, [])

    const handleAddText = useCallback(() => {
        setEditableData(prev => {
            if (!prev) return null
            const current = prev.attached_texts || []
            return {
                ...prev,
                attached_texts: [...current, {
                    id: Math.random().toString(36).substr(2, 9),
                    text: 'NEW TEXT',
                    x: 60,
                    y: 60,
                    width: 80,
                    rotation: 0,
                    fontSize: 16,
                    color: brushColor
                }]
            }
        })
    }, [brushColor])

    const handleAddShape = useCallback((kind: PdfShapeKind) => {
        setEditableData(prev => {
            if (!prev) return null
            const width = 40
            const x = 105
            const y = 100
            return {
                ...prev,
                attached_shapes: [...(prev.attached_shapes || []), {
                    id: Math.random().toString(36).slice(2, 11),
                    kind,
                    x,
                    y,
                    width,
                    height: width,
                    rotation: 0,
                    color: brushColor
                }]
            }
        })
    }, [brushColor])

    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            if (!isAdmin || !source?.workspaceId || (!templatePreview && !editableData)) return
            if (isTextPasteTarget(event.target)) return

            const image = getClipboardImageFile(event)
            if (!image) return

            event.preventDefault()
            void (templatePreview ? handlePasteTemplateImage(image) : handlePasteImage(image))
        }

        window.addEventListener('paste', handlePaste)
        return () => window.removeEventListener('paste', handlePaste)
    }, [editableData, handlePasteImage, handlePasteTemplateImage, isAdmin, source?.workspaceId, templatePreview])

    const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
        if (drawingMode === 'none') return
        setIsDrawing(true)
        const svg = e.currentTarget
        const rect = svg.getBoundingClientRect()
        const x = (e.clientX - rect.left) * (templatePageWidth / rect.width)
        const y = (e.clientY - rect.top) * (drawingCoordinateHeight / rect.height)
        setCurrentPath([{ x, y }])
    }, [drawingCoordinateHeight, drawingMode, templatePageWidth])

    const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
        if (!isDrawing || !currentPath || drawingMode === 'none') return
        const svg = e.currentTarget
        const rect = svg.getBoundingClientRect()
        const x = (e.clientX - rect.left) * (templatePageWidth / rect.width)
        const y = (e.clientY - rect.top) * (drawingCoordinateHeight / rect.height)
        setCurrentPath(prev => prev ? [...prev, { x, y }] : [{ x, y }])
    }, [isDrawing, currentPath, drawingMode, drawingCoordinateHeight, templatePageWidth])

    const handlePointerUp = useCallback(() => {
        if (!isDrawing || !currentPath) return
        setIsDrawing(false)
        setEditableData(prev => {
            if (!prev) return null
            const newAnnotations = [...(prev.annotations || []), {
                type: drawingMode as 'pen' | 'brush',
                points: currentPath,
                color: brushColor,
                brushSize: brushSize
            }]
            return { ...prev, annotations: newAnnotations }
        })
        setCurrentPath(null)
    }, [isDrawing, currentPath, drawingMode, brushColor, brushSize])

    if (templatePreview && fieldValues) {
    return (
        <div className="flex h-screen w-screen flex-col bg-gray-50 overflow-hidden"
            style={{ marginTop: 'var(--titlebar-height)', height: 'calc(100vh - var(--titlebar-height))' }}>
                <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1.5 shrink-0 bg-card z-20 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:px-4 md:py-2">
                    <div className="order-1 flex min-w-0 flex-1 items-center gap-2 md:order-none md:justify-self-start md:gap-3">
                        <button
                            className="inline-flex items-center justify-center rounded-md h-8 w-8 hover:bg-accent transition-colors shrink-0"
                            onClick={handleBack}
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                        <h1 className="text-sm font-semibold truncate">{title}</h1>
                    </div>

                    <div className="order-3 flex w-full min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain touch-pan-x bg-secondary/50 rounded-md p-0.5 border border-border [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 md:order-none md:w-auto md:justify-self-center md:overflow-visible">
                        {isAdmin && (
                            <>
                                {!fixedTemplatePrintLang && (
                                    <UiAccessGate>
                                        <LanguageSelector
                                            value={tempPrintLang}
                                            onChange={(val) => setTempPrintLang(val)}
                                        />
                                        <div className="w-px h-4 bg-border mx-0.5" />
                                    </UiAccessGate>
                                )}
                                <button
                                    onClick={handleAddTemplateImage}
                                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-primary md:w-auto md:gap-1.5 md:px-2 md:text-[11px] md:font-bold"
                                    title="Add Picture"
                                    aria-label="Add Picture"
                                >
                                    <ImagePlus className="h-3.5 w-3.5" />
                                    <span className="hidden md:inline">Add Photo</span>
                                </button>
                                <ShapeToolbarButton onAdd={handleAddTemplateShape} />
                                <div className="w-px h-4 bg-border mx-0.5" />
                                <button
                                    onClick={handleAddTemplateText}
                                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-primary md:w-auto md:gap-1.5 md:px-2 md:text-[11px] md:font-bold"
                                    title="Add Text Field"
                                    aria-label="Add Text Field"
                                >
                                    <Type className="h-3.5 w-3.5" />
                                    <span className="hidden md:inline">Add Text</span>
                                </button>
                                <div className="w-px h-4 bg-border mx-0.5" />
                            </>
                        )}
                        <button
                            onClick={handleZoomOut}
                            className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                            title={t('preview.zoomOut') || 'Zoom Out'}
                        >
                            <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <button
                            onClick={handleZoomReset}
                            className="h-7 px-2 inline-flex items-center justify-center rounded hover:bg-accent text-[11px] font-medium min-w-[45px]"
                            title={t('preview.zoomReset') || 'Reset Zoom'}
                        >
                            {zoom}%
                        </button>
                        <button
                            onClick={handleZoomIn}
                            className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                            title={t('preview.zoomIn') || 'Zoom In'}
                        >
                            <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                        <div className="w-px h-4 bg-border mx-0.5" />
                        <button
                            onClick={handleFitToWidth}
                            className={cn(
                                "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                isFitToWidth ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                            )}
                            title={t('preview.fitToWidth') || 'Fit to Width'}
                        >
                            <Maximize className="h-3.5 w-3.5" />
                        </button>
                        <div className="w-px h-4 bg-border mx-0.5" />
                        <div className="flex items-center gap-0.5">
                            <button
                                onClick={() => setDrawingMode('none')}
                                className={cn(
                                    "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                    drawingMode === 'none' ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                                )}
                                title="Hand Mode (Edit Fields)"
                            >
                                <Hand className="h-3.5 w-3.5" />
                            </button>
                            <div className="w-px h-3 bg-border mx-0.5" />
                            {isAdmin && (
                                <>
                                    <div className="relative group/tool">
                                        <button
                                            onClick={() => {
                                                setDrawingMode(prev => prev === 'pen' ? 'none' : 'pen')
                                                setBrushSize(2)
                                            }}
                                            className={cn(
                                                "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                                drawingMode === 'pen' ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                                            )}
                                            title="Pen Tool"
                                        >
                                            <PenTool className="h-3.5 w-3.5" />
                                        </button>
                                        <div className="absolute top-full left-1/2 -translate-x-1/2 pt-1.5 opacity-0 pointer-events-none group-hover/tool:opacity-100 group-hover/tool:pointer-events-auto transition-all z-50">
                                            <div className="bg-card border rounded-lg shadow-xl p-1 flex flex-col gap-0.5 min-w-[40px] items-center">
                                                {[1, 2, 3, 5].map(size => (
                                                    <button
                                                        key={size}
                                                        onClick={() => {
                                                            setBrushSize(size)
                                                            setDrawingMode('pen')
                                                        }}
                                                        className={cn(
                                                            "w-8 h-6 flex items-center justify-center rounded hover:bg-accent text-[10px] font-bold transition-colors",
                                                            brushSize === size && drawingMode === 'pen' ? "text-primary" : "text-muted-foreground"
                                                        )}
                                                    >
                                                        {size}px
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="relative group/tool">
                                        <button
                                            onClick={() => {
                                                setDrawingMode(prev => prev === 'brush' ? 'none' : 'brush')
                                                setBrushSize(10)
                                            }}
                                            className={cn(
                                                "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                                drawingMode === 'brush' ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                                            )}
                                            title="Brush Tool"
                                        >
                                            <Brush className="h-3.5 w-3.5" />
                                        </button>
                                        <div className="absolute top-full left-1/2 -translate-x-1/2 pt-1.5 opacity-0 pointer-events-none group-hover/tool:opacity-100 group-hover/tool:pointer-events-auto transition-all z-50">
                                            <div className="bg-card border rounded-lg shadow-xl p-1 flex flex-col gap-0.5 min-w-[40px] items-center">
                                                {[8, 12, 16, 24].map(size => (
                                                    <button
                                                        key={size}
                                                        onClick={() => {
                                                            setBrushSize(size)
                                                            setDrawingMode('brush')
                                                        }}
                                                        className={cn(
                                                            "w-8 h-6 flex items-center justify-center rounded hover:bg-accent text-[10px] font-bold transition-colors",
                                                            brushSize === size && drawingMode === 'brush' ? "text-primary" : "text-muted-foreground"
                                                        )}
                                                    >
                                                        {size}px
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="relative group">
                                        <button className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground transition-colors group-hover:bg-accent">
                                            <Palette className="h-3.5 w-3.5" style={{ color: brushColor }} />
                                        </button>
                                        <div className="absolute top-full left-0 pt-1.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all z-50">
                                            <div className="p-2 bg-card border rounded-md shadow-lg flex gap-1 items-center">
                                                {['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#000000'].map(c => (
                                                    <button
                                                        key={c}
                                                        onClick={() => setBrushColor(c)}
                                                        className="w-5 h-5 rounded-full border border-border hover:scale-110 transition-transform"
                                                        style={{ backgroundColor: c }}
                                                    />
                                                ))}
                                                <div className="w-px h-4 bg-border mx-1" />
                                                <input
                                                    type="color"
                                                    value={brushColor}
                                                    onChange={(e) => setBrushColor(e.target.value)}
                                                    className="w-5 h-5 border-none p-0 cursor-pointer bg-transparent"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="relative group/tool">
                                        <button
                                            onClick={() => {
                                                setDrawingMode(prev => prev === 'eraser' ? 'none' : 'eraser')
                                            }}
                                            className={cn(
                                                "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                                drawingMode === 'eraser' ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                                            )}
                                            title="Eraser Tool"
                                        >
                                            <Eraser className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => setIsClearConfirmOpen(true)}
                                        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-destructive"
                                        title="Clear All Annotations"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="order-2 flex shrink-0 items-center gap-1 md:order-none md:justify-self-end md:gap-2">
                        {(templatePreview.fields.length > 0 || templatePreview.supportsBackgroundEdit) && canEditTemplateFields && (
                            <button
                                className="inline-flex items-center justify-center rounded-md h-8 w-8 px-0 text-xs font-medium transition-colors gap-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 md:w-auto md:px-3"
                                onClick={() => setEditPanelOpen(o => !o)}
                                aria-label={editPanelOpen ? (t('common.close') || 'Close') : (t('common.fields') || 'Editable Fields')}
                            >
                                <Edit3 className="h-3.5 w-3.5" />
                                <span className="hidden md:inline">
                                    {editPanelOpen ? (t('common.close') || 'Close') : (t('common.fields') || 'Editable Fields')}
                                </span>
                            </button>
                        )}
                        {hasTemplatePrimaryAction && (
                            <button
                                className="inline-flex items-center justify-center rounded-md h-8 w-8 px-0 text-xs font-medium transition-colors gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 md:w-auto md:px-3"
                                onClick={handleTemplatePreviewSave}
                                disabled={isSaving || !isTemplatePrintReady}
                                aria-label={source.onSaveTemplateLayout
                                    ? t('customTemplates.saveLayout', { defaultValue: 'Save Layout' })
                                    : source.templatePrimaryActionLabel || source.printActionLabel || (source.onSave ? (t('print.printAndSave') || 'Print & Save') : (t('common.print') || 'Print'))}
                            >
                                {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : source.onSaveTemplateLayout ? <Check className="h-3.5 w-3.5" /> : <Printer className="h-3.5 w-3.5" />}
                                <span className="hidden md:inline">
                                    {source.onSaveTemplateLayout
                                        ? t('customTemplates.saveLayout', { defaultValue: 'Save Layout' })
                                        : source.templatePrimaryActionLabel || source.printActionLabel || (source.onSave ? (t('print.printAndSave') || 'Print & Save') : (t('common.print') || 'Print'))}
                                </span>
                            </button>
                        )}
                    </div>
                </header>
                <div className="flex flex-1 overflow-hidden">
                    <div className="flex-1 overflow-hidden light" style={{ colorScheme: 'light' }}>
                        <div className="h-full w-full overflow-auto p-6 bg-slate-100/50 flex flex-col items-center">
                            <div
                                className={cn(
                                    "mx-auto transition-all duration-200 ease-in-out origin-top relative group",
                                    isFitToWidth ? "w-full" : "w-fit"
                                )}
                                style={{
                                    transform: isFitToWidth ? 'none' : `scale(${zoom / 100})`,
                                }}
                            >
                                <div
                                    ref={templateStageRef}
                                    className="relative mx-auto overflow-visible text-black"
                                    onPointerDownCapture={handleTemplateStackSelection}
                                    style={{
                                        width: `${templatePageWidth}mm`,
                                        height: `${templateStackHeight}mm`
                                    }}
                                >
                                    {Array.from({ length: templatePageCount }).map((_, pageIndex) => (
                                        <div
                                            key={`template-preview-page-${pageIndex}`}
                                            className="absolute left-0 z-0 overflow-hidden bg-white shadow-sm ring-1 ring-slate-200"
                                            style={{
                                                top: `${isFixedPageTemplatePreview ? pageIndex * templatePageHeight : 0}mm`,
                                                width: `${templatePageWidth}mm`,
                                                height: `${isFixedPageTemplatePreview ? templatePageHeight : templateStackHeight}mm`
                                            }}
                                        >
                                            {templatePageCount > 1 ? (
                                                <div className="absolute end-2 top-2 rounded bg-slate-900/60 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                                                    {pageIndex + 1}
                                                </div>
                                            ) : null}
                                        </div>
                                    ))}
                                    {templatePageCount > 1 ? Array.from({ length: templatePageCount - 1 }).map((_, pageIndex) => (
                                        <div
                                            key={`template-preview-break-${pageIndex}`}
                                            className="pointer-events-none absolute left-0 right-0 z-[45] border-t border-dashed border-red-400"
                                            style={{ top: `${(pageIndex + 1) * templatePageHeight}mm` }}
                                        />
                                    )) : null}
                                {/* Drawing Overlay for templatePreview */}
                                <svg
                                    className={cn(
                                        "absolute inset-0 z-[40] touch-none",
                                        drawingMode !== 'none' ? "cursor-crosshair" : "pointer-events-none"
                                    )}
                                    viewBox={`0 0 ${templatePageWidth} ${templateStackHeight}`}
                                    onPointerDown={handlePointerDown}
                                    onPointerMove={handlePointerMove}
                                    onPointerUp={() => {
                                        if (!isDrawing || !currentPath) return
                                        setIsDrawing(false)
                                        setTemplateAnnotations(prev => [...prev, {
                                            type: drawingMode as 'pen' | 'brush',
                                            points: currentPath,
                                            color: brushColor,
                                            brushSize: brushSize
                                        }])
                                        setCurrentPath(null)
                                    }}
                                    onPointerLeave={() => {
                                        if (!isDrawing || !currentPath) return
                                        setIsDrawing(false)
                                        setTemplateAnnotations(prev => [...prev, {
                                            type: drawingMode as 'pen' | 'brush',
                                            points: currentPath,
                                            color: brushColor,
                                            brushSize: brushSize
                                        }])
                                        setCurrentPath(null)
                                    }}
                                >
                                    {/* Saved annotations */}
                                    {templateAnnotations.map((ann, idx) => (
                                        <path
                                            key={idx}
                                            d={`M ${ann.points.map(p => `${p.x},${p.y}`).join(' L ')}`}
                                            stroke={ann.color}
                                            strokeWidth={ann.brushSize}
                                            fill="none"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            opacity={ann.type === 'brush' ? 0.5 : 1}
                                            onPointerDown={(e) => {
                                                if (drawingMode === 'eraser') {
                                                    e.stopPropagation();
                                                    setTemplateAnnotations(prev => prev.filter((_, i) => i !== idx));
                                                }
                                            }}
                                            className={cn(drawingMode === 'eraser' && "cursor-pointer hover:stroke-destructive transition-colors")}
                                            style={{ pointerEvents: drawingMode === 'eraser' ? 'all' : 'auto' }}
                                        />
                                    ))}
                                    {/* Current active path preview */}
                                    {currentPath && (
                                        <path
                                            d={`M ${currentPath.map(p => `${p.x},${p.y}`).join(' L ')}`}
                                            stroke={brushColor}
                                            strokeWidth={brushSize}
                                            fill="none"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            opacity={drawingMode === 'brush' ? 0.5 : 1}
                                            style={{ pointerEvents: 'none' }}
                                        />
                                    )}
                                </svg>

                                {/* Attached images overlay */}
                                {templateImages.map((img, idx) => (
                                    <div
                                        key={`timg-${idx}`}
                                        data-template-overflow-measure=""
                                        data-pdf-template-object-id={`image:${idx}`}
                                        data-pdf-template-object-kind="image"
                                        className={cn("absolute z-[35] cursor-move group/img", selectedTemplateObjectId === `image:${idx}` && "ring-1 ring-primary")}
                                        style={{
                                            left: `${(img.x / templatePageWidth) * 100}%`,
                                            top: `${(img.y / templateStackHeight) * 100}%`,
                                            width: `${(img.width / templatePageWidth) * 100}%`,
                                            transform: `rotate(${img.rotation || 0}deg)`,
                                            transformOrigin: 'top left',
                                            zIndex: selectedTemplateObjectId === `image:${idx}` ? 200 : 50 + idx,
                                        }}
                                        onPointerDown={(e) => {
                                            if (drawingMode !== 'none') return
                                            e.preventDefault()
                                            e.stopPropagation()
                                            const startX = e.clientX
                                            const startY = e.clientY
                                            const origX = img.x
                                            const origY = img.y
                                            const container = (e.currentTarget.parentElement as HTMLElement)
                                            const cRect = container.getBoundingClientRect()
                                            const scaleX = templatePageWidth / cRect.width
                                            const scaleY = templateStackHeight / cRect.height
                                            const onMove = (ev: PointerEvent) => {
                                                const dx = (ev.clientX - startX) * scaleX
                                                const dy = (ev.clientY - startY) * scaleY
                                                setTemplateImages(prev => prev.map((im, i) => i === idx ? { ...im, x: origX + dx, y: origY + dy } : im))
                                            }
                                            const onUp = () => {
                                                window.removeEventListener('pointermove', onMove)
                                                window.removeEventListener('pointerup', onUp)
                                            }
                                            window.addEventListener('pointermove', onMove)
                                            window.addEventListener('pointerup', onUp)
                                        }}
                                    >
                                        <img
                                            src={platformService.convertFileSrc(img.path)}
                                            alt=""
                                            className="w-full h-auto block select-none pointer-events-none ring-1 ring-transparent group-hover/img:ring-primary transition-shadow"
                                            draggable={false}
                                        />
                                        {/* Rotation Handle */}
                                        <div
                                            className="absolute -top-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-white border border-slate-200 rounded-full shadow-sm flex items-center justify-center cursor-alias opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                const rect = e.currentTarget.parentElement?.getBoundingClientRect()
                                                if (!rect) return
                                                const centerX = rect.left + rect.width / 2
                                                const centerY = rect.top + rect.height / 2
                                                const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX)
                                                const initialRotation = img.rotation || 0
                                                const onPointerMove = (mE: PointerEvent) => {
                                                    const currentAngle = Math.atan2(mE.clientY - centerY, mE.clientX - centerX)
                                                    const delta = (currentAngle - startAngle) * (180 / Math.PI)
                                                    setTemplateImages(prev => prev.map((im, i) => i === idx ? { ...im, rotation: initialRotation + delta } : im))
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <RotateCw className="w-3 h-3 text-primary" />
                                        </div>
                                        {/* Resize Handle */}
                                        <div
                                            className="absolute -bottom-2 -right-2 w-5 h-5 bg-white border border-slate-200 rounded shadow-sm flex items-center justify-center cursor-nwse-resize opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                const startX = e.clientX
                                                const initialWidth = img.width
                                                const container = (e.currentTarget.parentElement?.parentElement as HTMLElement)
                                                const cRect = container.getBoundingClientRect()
                                                const scaleX = templatePageWidth / cRect.width
                                                const onPointerMove = (mE: PointerEvent) => {
                                                    const dx = (mE.clientX - startX) * scaleX
                                                    const newWidth = Math.max(10, initialWidth + dx)
                                                    setTemplateImages(prev => prev.map((im, i) => i === idx ? { ...im, width: newWidth } : im))
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <Scaling className="w-3 h-3 text-primary" />
                                        </div>
                                        {/* Delete Handle */}
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                setTemplateImages(prev => prev.filter((_, i) => i !== idx))
                                            }}
                                            className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shadow-md hover:bg-red-600 active:scale-95 z-10"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}

                                <AttachedShapesOverlay
                                    shapes={templateShapes}
                                    onShapesChange={setTemplateShapes}
                                    pageWidthMm={templatePageWidth}
                                    selectedShapeId={selectedTemplateObjectId?.startsWith('shape:')
                                        ? selectedTemplateObjectId.slice('shape:'.length)
                                        : null}
                                    onSelectionClear={() => setSelectedTemplateObjectId(null)}
                                />

                                {/* Attached texts overlay */}
                                {templateTexts.map((txt, idx) => {
                                    const reflowsAfterContent = shouldReflowCustomTemplateText(
                                        txt,
                                        templatePageHeight,
                                        templatePreview?.reflowLowerPageText
                                    )
                                    const displayY = reflowsAfterContent && templateTextFlowStartMm !== null
                                        ? Math.max(txt.y, templateTextFlowStartMm)
                                        : txt.y

                                    return (
                                        <div
                                            key={`ttxt-${txt.id}`}
                                            data-template-overflow-measure=""
                                            data-template-text-flow={reflowsAfterContent ? 'after-content' : undefined}
                                            data-pdf-template-object-id={`text:${txt.id}`}
                                            data-pdf-template-object-kind="text"
                                            className={cn("absolute z-[35] group/txt", selectedTemplateObjectId === `text:${txt.id}` && "ring-1 ring-primary")}
                                            style={{
                                                left: `${(txt.x / templatePageWidth) * 100}%`,
                                                top: `${(displayY / templateStackHeight) * 100}%`,
                                                width: `${(txt.width / templatePageWidth) * 100}%`,
                                                transform: `rotate(${txt.rotation}deg)`,
                                                transformOrigin: 'top left',
                                                zIndex: selectedTemplateObjectId === `text:${txt.id}` ? 200 : 100 + idx,
                                            }}
                                        >
                                        <textarea
                                            value={txt.text}
                                            dir={resolveIsolatedTextDirection(txt.text)}
                                            onChange={(e) => setTemplateTexts(prev => prev.map((t, i) => i === idx ? { ...t, text: e.target.value } : t))}
                                            onBlur={() => {
                                                if (!txt.text.trim()) {
                                                    setTemplateTexts(prev => prev.filter((_, i) => i !== idx))
                                                }
                                            }}
                                            className="w-full bg-transparent border-none outline-none resize-none p-1 block ring-1 ring-transparent group-hover/txt:ring-primary transition-shadow text-inherit font-bold overflow-hidden"
                                            style={{
                                                height: 'auto',
                                                fontSize: `${txt.fontSize || 16}px`,
                                                color: txt.color,
                                                lineHeight: 1.3,
                                            }}
                                            rows={1}
                                            spellCheck={false}
                                        />
                                        {/* Font Size Handle */}
                                        <div
                                            className="absolute -top-16 left-1/2 -translate-x-1/2 h-7 bg-white border border-slate-200 rounded-md shadow-sm flex items-center justify-center opacity-0 group-hover/txt:opacity-100 group-focus-within:opacity-100 transition-opacity z-10 px-1"
                                            onPointerDown={(e) => e.stopPropagation()}
                                        >
                                            <input
                                                type="number"
                                                min="8"
                                                max="72"
                                                value={txt.fontSize === '' ? '' : (txt.fontSize ?? 16)}
                                                onChange={(e) => {
                                                    const newTexts = [...templateTexts]
                                                    const val = e.target.value
                                                    newTexts[idx] = { ...txt, fontSize: val === '' ? '' : parseInt(val) }
                                                    setTemplateTexts(newTexts)
                                                }}
                                                className="w-12 h-5 text-center text-xs outline-none font-medium text-slate-700 bg-transparent"
                                            />
                                            <span className="text-[10px] text-slate-400 font-medium pr-1 select-none pointer-events-none">px</span>
                                        </div>
                                        {/* Move Handle */}
                                        <div
                                            className="absolute -bottom-7 left-1/2 -translate-x-1/2 w-6 h-6 bg-white border border-slate-200 rounded-full shadow-sm flex items-center justify-center cursor-move opacity-0 group-hover/txt:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                if (drawingMode !== 'none') return
                                                e.preventDefault()
                                                e.stopPropagation()
                                                const startX = e.clientX
                                                const startY = e.clientY
                                                const origX = txt.x
                                                const origY = displayY
                                                const container = (e.currentTarget.parentElement?.parentElement as HTMLElement)
                                                const cRect = container.getBoundingClientRect()
                                                const scaleX = templatePageWidth / cRect.width
                                                const scaleY = templateStackHeight / cRect.height
                                                const onMoveEv = (ev: PointerEvent) => {
                                                    const dx = (ev.clientX - startX) * scaleX
                                                    const dy = (ev.clientY - startY) * scaleY
                                                    setTemplateTexts(prev => prev.map((t, i) => i === idx ? {
                                                        ...t,
                                                        x: origX + dx,
                                                        y: origY + dy,
                                                        anchor: reflowsAfterContent ? 'afterContent' : t.anchor
                                                    } : t))
                                                }
                                                const onUp = () => {
                                                    window.removeEventListener('pointermove', onMoveEv)
                                                    window.removeEventListener('pointerup', onUp)
                                                }
                                                window.addEventListener('pointermove', onMoveEv)
                                                window.addEventListener('pointerup', onUp)
                                            }}
                                        >
                                            <Move className="w-3 h-3 text-primary" />
                                        </div>
                                        {/* Rotation Handle */}
                                        <div
                                            className="absolute -top-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-white border border-slate-200 rounded-full shadow-sm flex items-center justify-center cursor-alias opacity-0 group-hover/txt:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                const rect = e.currentTarget.parentElement?.getBoundingClientRect()
                                                if (!rect) return
                                                const centerX = rect.left + rect.width / 2
                                                const centerY = rect.top + rect.height / 2
                                                const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX)
                                                const initialRotation = txt.rotation || 0
                                                const onPointerMove = (mE: PointerEvent) => {
                                                    const currentAngle = Math.atan2(mE.clientY - centerY, mE.clientX - centerX)
                                                    const delta = (currentAngle - startAngle) * (180 / Math.PI)
                                                    setTemplateTexts(prev => prev.map((t, i) => i === idx ? { ...t, rotation: initialRotation + delta } : t))
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <RotateCw className="w-3 h-3 text-primary" />
                                        </div>
                                        {/* Resize Handle */}
                                        <div
                                            className="absolute -bottom-2 -right-2 w-5 h-5 bg-white border border-slate-200 rounded shadow-sm flex items-center justify-center cursor-nwse-resize opacity-0 group-hover/txt:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                const startX = e.clientX
                                                const initialWidth = txt.width
                                                const container = (e.currentTarget.parentElement?.parentElement as HTMLElement)
                                                const cRect = container.getBoundingClientRect()
                                                const scaleX = templatePageWidth / cRect.width
                                                const onPointerMove = (mE: PointerEvent) => {
                                                    const dx = (mE.clientX - startX) * scaleX
                                                    const newWidth = Math.max(20, initialWidth + dx)
                                                    setTemplateTexts(prev => prev.map((t, i) => i === idx ? { ...t, width: newWidth } : t))
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <Scaling className="w-3 h-3 text-primary" />
                                        </div>
                                        {/* Delete Handle */}
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                setTemplateTexts(prev => prev.filter((_, i) => i !== idx))
                                            }}
                                            className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover/txt:opacity-100 transition-opacity shadow-md hover:bg-red-600 active:scale-95"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                        </div>
                                    )
                                })}

                                <div ref={templateContentLayerRef} className="relative">
                                    {templatePreview.createElement(
                                        fieldValues,
                                        source.effectiveId,
                                        fixedTemplatePrintLang || (tempPrintLang !== 'auto' ? tempPrintLang : undefined),
                                        {
                                            editableFields: canEditTemplateFields && drawingMode === 'none',
                                            editableComponents: canEditTemplateFields && drawingMode === 'none' && (Boolean(source?.onSaveTemplateLayout) || isAccessKeyHeld),
                                            dataKeys: templatePreview.dataKeys,
                                            componentPositions: templateComponentPositions,
                                            hiddenFields: templateHiddenFields,
                                            fieldOrders: templateFieldOrders,
                                            fieldLabelOverrides: templateFieldLabelOverrides,
                                            fieldDisplayModes: templateFieldDisplayModes,
                                            background: templateBackground ?? undefined,
                                            onFieldChange: handleFieldChange,
                                            onComponentPositionChange: handleTemplateComponentPositionChange,
                                            onHiddenFieldChange: drawingMode === 'none' ? handleTemplateHiddenFieldChange : undefined,
                                            onFieldOrderChange: drawingMode === 'none' ? handleTemplateFieldOrderChange : undefined,
                                            onFieldLabelChange: drawingMode === 'none' ? handleTemplateFieldLabelChange : undefined,
                                            onFieldDisplayModeChange: drawingMode === 'none' ? handleTemplateFieldDisplayModeChange : undefined,
                                            workspaceFooterContacts: sourceWorkspaceFooterContacts
                                        }
                                    )}
                                </div>
                                {source.printFormat === 'a4' && (
                                    <TooltipProvider>
                                        <Tooltip delayDuration={200}>
                                            <TooltipTrigger asChild>
                                                <div className="absolute bottom-0 left-0 right-0 h-14 bg-red-500/20 z-[35] cursor-help select-none" />
                                            </TooltipTrigger>
                                            <TooltipContent side="top" className="max-w-[260px] p-3 text-xs">
                                                {t('printPreviewEditor.bottomWarning')}
                                            </TooltipContent>
                                        </Tooltip>
                                    </TooltipProvider>
                                )}
                                </div>
                            </div>
                        </div>
                    </div>
                    {editPanelOpen && canEditTemplateFields && (
                        <div className="w-72 shrink-0 border-l bg-card overflow-y-auto p-4 space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-semibold">{t('common.fields') || 'Editable Fields'}</h3>
                                <button
                                    className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent transition-colors"
                                    onClick={() => setEditPanelOpen(false)}
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                            {templatePreview.supportsBackgroundEdit ? (
                                <div className="space-y-3 border-t pt-3">
                                    <div className="flex items-center justify-between">
                                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            {t('printPreviewEditor.commonEdit', { defaultValue: 'Common edit' })}
                                        </h4>
                                        {templateBackground ? (
                                            <button
                                                type="button"
                                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                                                onClick={() => setTemplateBackground(null)}
                                            >
                                                <Trash2 className="h-3 w-3" />
                                                {t('common.remove', { defaultValue: 'Remove' })}
                                            </button>
                                        ) : null}
                                    </div>
                                    <p className="text-[11px] leading-4 text-muted-foreground">
                                        {t('printPreviewEditor.backgroundWatermarkHint', {
                                            defaultValue: 'Add a photo behind every component as a low-opacity watermark.'
                                        })}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={handleUploadTemplateBackground}
                                        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                                    >
                                        <ImagePlus className="h-3.5 w-3.5" />
                                        {templateBackground
                                            ? t('printPreviewEditor.changeBackgroundWatermark', { defaultValue: 'Change background photo' })
                                            : t('printPreviewEditor.uploadBackgroundWatermark', { defaultValue: 'Upload background photo' })}
                                    </button>
                                    {templateBackground ? (
                                        <div className="space-y-3">
                                            <div className="space-y-1.5">
                                                <div className="flex items-center justify-between gap-3">
                                                    <label className="text-[11px] font-medium text-muted-foreground" htmlFor="template-background-opacity">
                                                        {t('printPreviewEditor.watermarkOpacity', { defaultValue: 'Opacity' })}
                                                    </label>
                                                    <output className="text-xs tabular-nums text-muted-foreground">
                                                        {templateBackground.opacity}%
                                                    </output>
                                                </div>
                                                <input
                                                    id="template-background-opacity"
                                                    type="range"
                                                    min={1}
                                                    max={100}
                                                    step={1}
                                                    value={templateBackground.opacity}
                                                    className="w-full accent-primary"
                                                    onChange={(event) => setTemplateBackground((current) => current
                                                        ? { ...current, opacity: Number(event.target.value) }
                                                        : current)}
                                                />
                                            </div>
                                            <div className="space-y-1.5">
                                                <div className="flex items-center justify-between gap-3">
                                                    <label className="text-[11px] font-medium text-muted-foreground" htmlFor="template-background-size">
                                                        {t('printPreviewEditor.watermarkSize', { defaultValue: 'Size' })}
                                                    </label>
                                                    <output className="text-xs tabular-nums text-muted-foreground">
                                                        {templateBackground.size}%
                                                    </output>
                                                </div>
                                                <input
                                                    id="template-background-size"
                                                    type="range"
                                                    min={10}
                                                    max={100}
                                                    step={1}
                                                    value={templateBackground.size}
                                                    className="w-full accent-primary"
                                                    onChange={(event) => setTemplateBackground((current) => current
                                                        ? { ...current, size: Number(event.target.value) }
                                                        : current)}
                                                />
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                            {templatePreview.fields.map(f => {
                                const fieldLabel = f.label
                                    ? t(f.label, { defaultValue: f.label })
                                    : ''

                                return (
                                <div key={f.key} className="space-y-1">
                                    {f.type === 'boolean' ? (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-[11px] font-medium text-muted-foreground">
                                                {fieldLabel}
                                            </span>
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={fieldValues[f.key] !== 'false'}
                                                aria-label={fieldLabel}
                                                onClick={() => handleFieldChange(
                                                    f.key,
                                                    fieldValues[f.key] === 'false' ? 'true' : 'false'
                                                )}
                                                className={cn(
                                                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                                                    fieldValues[f.key] !== 'false' ? 'bg-primary' : 'bg-muted'
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        'absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                                                        fieldValues[f.key] !== 'false' ? 'translate-x-[18px]' : 'translate-x-0.5'
                                                    )}
                                                />
                                                <span className="sr-only">
                                                    {fieldValues[f.key] !== 'false' ? 'Enabled' : 'Disabled'}
                                                </span>
                                            </button>
                                        </div>
                                    ) : f.type === 'range' ? (
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between gap-3">
                                                <label className="text-[11px] font-medium text-muted-foreground" htmlFor={`template-field-${f.key}`}>
                                                    {fieldLabel}
                                                </label>
                                                <output className="text-xs tabular-nums text-muted-foreground">
                                                    {fieldValues[f.key] ?? f.value}{f.unit || ''}
                                                </output>
                                            </div>
                                            <input
                                                id={`template-field-${f.key}`}
                                                type="range"
                                                min={f.min}
                                                max={f.max}
                                                step={f.step}
                                                value={fieldValues[f.key] ?? f.value}
                                                className="w-full accent-primary"
                                                onChange={(event) => handleFieldChange(f.key, event.target.value)}
                                            />
                                        </div>
                                    ) : (
                                        <>
                                            <label className="text-[11px] font-medium text-muted-foreground">{fieldLabel}</label>
                                            <EditableField
                                                value={fieldValues[f.key] ?? ''}
                                                onChange={(v) => handleFieldChange(f.key, v)}
                                                type={f.type}
                                                className="text-sm"
                                                inputClassName="w-full"
                                                placeholder={f.placeholder}
                                            />
                                        </>
                                    )}
                                </div>
                                )
                            })}
                        </div>
                    )}
                </div>

                <DeleteConfirmationModal
                    isOpen={isClearConfirmOpen}
                    onClose={() => setIsClearConfirmOpen(false)}
                    onConfirm={() => {
                        setTemplateAnnotations([])
                        setTemplateTexts([])
                        setTemplateImages([])
                        setIsClearConfirmOpen(false)
                    }}
                    title="Clear All Annotations"
                    description="This will permanently delete all hand-drawn notes, text fields, and images from this document. Are you sure you want to clear everything?"
                    itemName="Annotations Layer"
                />

                <Dialog
                    open={isTemplateLabelDialogOpen}
                    onOpenChange={(open) => {
                        if (isSaving) return
                        setIsTemplateLabelDialogOpen(open)
                        if (!open) {
                            setPendingTemplateLayout(null)
                        }
                    }}
                >
                    <DialogContent className="sm:max-w-md">
                        <form onSubmit={handleConfirmTemplateLayoutSave}>
                            <DialogHeader>
                                <DialogTitle>{t('customTemplates.labelDialogTitle', { defaultValue: 'Name Custom Template' })}</DialogTitle>
                                <DialogDescription>
                                    {t('customTemplates.labelDialogDescription', {
                                        defaultValue: 'Enter a label to identify this custom print layout later.'
                                    })}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="grid gap-2 py-4">
                                <Label htmlFor="custom-template-label">
                                    {t('customTemplates.labelField', { defaultValue: 'Template Label' })}
                                </Label>
                                <Input
                                    id="custom-template-label"
                                    value={templateSaveLabel}
                                    onChange={(event) => setTemplateSaveLabel(event.target.value)}
                                    placeholder={t('customTemplates.labelPlaceholder', { defaultValue: 'Enter template label' })}
                                    disabled={isSaving}
                                    autoFocus
                                />
                            </div>

                            <DialogFooter>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => {
                                        setIsTemplateLabelDialogOpen(false)
                                        setPendingTemplateLayout(null)
                                    }}
                                    disabled={isSaving}
                                >
                                    {t('common.cancel', { defaultValue: 'Cancel' })}
                                </Button>
                                <Button type="submit" disabled={!templateSaveLabel.trim() || isSaving}>
                                    {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                    {t('customTemplates.saveLayout', { defaultValue: 'Save Layout' })}
                                </Button>
                            </DialogFooter>
                        </form>
                    </DialogContent>
                </Dialog>
            </div>
        )
    }

    if (showNativePdf) {
        return (
            <div className="flex h-screen w-screen flex-col bg-background overflow-hidden"
                    style={{ marginTop: 'var(--titlebar-height)', height: 'calc(100vh - var(--titlebar-height))' }}>
                    <header className="flex items-center gap-2 border-b px-2 py-1.5 shrink-0 bg-card z-10 md:justify-between md:px-4 md:py-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
                            <button
                                className="inline-flex items-center justify-center rounded-md h-8 w-8 hover:bg-accent transition-colors shrink-0"
                                onClick={handleBack}
                            >
                                <ArrowLeft className="h-4 w-4" />
                            </button>
                            <h1 className="text-sm font-semibold truncate">{title}</h1>
                        </div>
                        <div className="flex shrink-0 items-center gap-1 md:gap-2">
                            <button
                                className="inline-flex items-center justify-center rounded-md h-8 w-8 px-0 text-xs font-medium transition-colors gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 md:w-auto md:px-3"
                                onClick={handleNativePrint}
                                disabled={isSaving}
                                aria-label={source.printActionLabel || t('common.print') || 'Print'}
                            >
                                {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                                <span className="hidden md:inline">{source.printActionLabel || t('common.print') || 'Print'}</span>
                            </button>
                        </div>
                    </header>
                    <div className="min-h-0 flex-1">
                        <PdfJsViewer
                            url={source.url}
                            bytes={source.pdfBytes}
                            title={title}
                            allowPrint={false}
                            showZoom
                        />
                    </div>
                </div>
        )
    }

    return (
            <div className="flex h-screen w-screen flex-col bg-gray-50 overflow-hidden"
                style={{ marginTop: 'var(--titlebar-height)', height: 'calc(100vh - var(--titlebar-height))' }}>
            <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1.5 shrink-0 bg-card z-10 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:px-4 md:py-2">
                <div className="order-1 flex min-w-0 flex-1 items-center gap-2 md:order-none md:justify-self-start md:gap-3">
                    <button
                        className="inline-flex items-center justify-center rounded-md h-8 w-8 hover:bg-accent transition-colors shrink-0"
                        onClick={handleBack}
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </button>
                    <h1 className="text-sm font-semibold truncate">{title}</h1>
                </div>

                <div className="order-3 flex w-full min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain touch-pan-x bg-secondary/50 rounded-md p-0.5 border border-border [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 md:order-none md:w-auto md:justify-self-center md:overflow-visible">
                    {isAdmin && (
                        <>
                            <UiAccessGate>
                                <LanguageSelector
                                    value={tempPrintLang}
                                    onChange={(val) => setTempPrintLang(val)}
                                />
                                <div className="w-px h-4 bg-border mx-0.5" />
                            </UiAccessGate>
                            <button
                                onClick={handleAddImage}
                                className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-primary md:w-auto md:gap-1.5 md:px-2 md:text-[11px] md:font-bold"
                                title="Add Picture"
                                aria-label="Add Picture"
                            >
                                <ImagePlus className="h-3.5 w-3.5" />
                                <span className="hidden md:inline">Add Photo</span>
                            </button>
                            <ShapeToolbarButton onAdd={handleAddShape} />
                            <div className="w-px h-4 bg-border mx-0.5" />
                            <button
                                onClick={handleAddText}
                                className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-primary md:w-auto md:gap-1.5 md:px-2 md:text-[11px] md:font-bold"
                                title="Add Text Field"
                                aria-label="Add Text Field"
                            >
                                <Type className="h-3.5 w-3.5" />
                                <span className="hidden md:inline">Add Text</span>
                            </button>
                            <div className="w-px h-4 bg-border mx-0.5" />
                        </>
                    )}
                    <button
                        onClick={handleZoomOut}
                        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                        title={t('preview.zoomOut') || 'Zoom Out'}
                    >
                        <ZoomOut className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={handleZoomReset}
                        className="h-7 px-2 inline-flex items-center justify-center rounded hover:bg-accent text-[11px] font-medium min-w-[45px]"
                        title={t('preview.zoomReset') || 'Reset Zoom'}
                    >
                        {zoom}%
                    </button>
                    <button
                        onClick={handleZoomIn}
                        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                        title={t('preview.zoomIn') || 'Zoom In'}
                    >
                        <ZoomIn className="h-3.5 w-3.5" />
                    </button>
                    <div className="w-px h-4 bg-border mx-0.5" />
                    <button
                        onClick={handleFitToWidth}
                        className={cn(
                            "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                            isFitToWidth ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                        )}
                        title={t('preview.fitToWidth') || 'Fit to Width'}
                    >
                        <Maximize className="h-3.5 w-3.5" />
                    </button>
                    <div className="w-px h-4 bg-border mx-0.5" />
                    <div className="flex items-center gap-0.5">
                        <button
                            onClick={() => setDrawingMode('none')}
                            className={cn(
                                "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                drawingMode === 'none' ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                            )}
                            title="Hand Mode (Edit Fields)"
                        >
                            <Hand className="h-3.5 w-3.5" />
                        </button>
                        <div className="w-px h-3 bg-border mx-0.5" />
                        {isAdmin && (
                            <>

                                <div className="relative group/tool">
                                    <button
                                        onClick={() => {
                                            setDrawingMode(prev => prev === 'pen' ? 'none' : 'pen')
                                            setBrushSize(2)
                                        }}
                                        className={cn(
                                            "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                            drawingMode === 'pen' ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                                        )}
                                        title="Pen Tool"
                                    >
                                        <PenTool className="h-3.5 w-3.5" />
                                    </button>
                                    <div className="absolute top-full left-1/2 -translate-x-1/2 pt-1.5 opacity-0 pointer-events-none group-hover/tool:opacity-100 group-hover/tool:pointer-events-auto transition-all z-50">
                                        <div className="bg-card border rounded-lg shadow-xl p-1 flex flex-col gap-0.5 min-w-[40px] items-center">
                                            {[1, 2, 3, 5].map(size => (
                                                <button
                                                    key={size}
                                                    onClick={() => {
                                                        setBrushSize(size)
                                                        setDrawingMode('pen')
                                                    }}
                                                    className={cn(
                                                        "w-8 h-6 flex items-center justify-center rounded hover:bg-accent text-[10px] font-bold transition-colors",
                                                        brushSize === size && drawingMode === 'pen' ? "text-primary" : "text-muted-foreground"
                                                    )}
                                                >
                                                    {size}px
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                <div className="relative group/tool">
                                    <button
                                        onClick={() => {
                                            setDrawingMode(prev => prev === 'brush' ? 'none' : 'brush')
                                            setBrushSize(10)
                                        }}
                                        className={cn(
                                            "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                            drawingMode === 'brush' ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                                        )}
                                        title="Brush Tool"
                                    >
                                        <Brush className="h-3.5 w-3.5" />
                                    </button>
                                    <div className="absolute top-full left-1/2 -translate-x-1/2 pt-1.5 opacity-0 pointer-events-none group-hover/tool:opacity-100 group-hover/tool:pointer-events-auto transition-all z-50">
                                        <div className="bg-card border rounded-lg shadow-xl p-1 flex flex-col gap-0.5 min-w-[40px] items-center">
                                            {[8, 12, 16, 24].map(size => (
                                                <button
                                                    key={size}
                                                    onClick={() => {
                                                        setBrushSize(size)
                                                        setDrawingMode('brush')
                                                    }}
                                                    className={cn(
                                                        "w-8 h-6 flex items-center justify-center rounded hover:bg-accent text-[10px] font-bold transition-colors",
                                                        brushSize === size && drawingMode === 'brush' ? "text-primary" : "text-muted-foreground"
                                                    )}
                                                >
                                                    {size}px
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                <div className="relative group">
                                    <button className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground transition-colors group-hover:bg-accent">
                                        <Palette className="h-3.5 w-3.5" style={{ color: brushColor }} />
                                    </button>
                                    <div className="absolute top-full left-0 pt-1.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all z-50">
                                        <div className="p-2 bg-card border rounded-md shadow-lg flex gap-1 items-center">
                                            {['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#000000'].map(c => (
                                                <button
                                                    key={c}
                                                    onClick={() => setBrushColor(c)}
                                                    className="w-5 h-5 rounded-full border border-border hover:scale-110 transition-transform"
                                                    style={{ backgroundColor: c }}
                                                />
                                            ))}
                                            <div className="w-px h-4 bg-border mx-1" />
                                            <input
                                                type="color"
                                                value={brushColor}
                                                onChange={(e) => setBrushColor(e.target.value)}
                                                className="w-5 h-5 border-none p-0 cursor-pointer bg-transparent"
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="relative group/tool">
                                    <button
                                        onClick={() => {
                                            setDrawingMode(prev => prev === 'eraser' ? 'none' : 'eraser')
                                        }}
                                        className={cn(
                                            "h-7 w-7 inline-flex items-center justify-center rounded transition-colors",
                                            drawingMode === 'eraser' ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                                        )}
                                        title="Eraser Tool"
                                    >
                                        <Eraser className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                                <button
                                    onClick={() => setIsClearConfirmOpen(true)}
                                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-destructive"
                                    title="Clear All Annotations"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </>
                        )}
                    </div>
                </div>

                <div className="order-2 flex shrink-0 items-center gap-1 md:order-none md:justify-self-end md:gap-2">
                    {editableData && isAdmin && (
                        <button
                            className="inline-flex items-center justify-center rounded-md h-8 w-8 px-0 text-xs font-medium transition-colors gap-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 md:w-auto md:px-3"
                            onClick={() => setEditPanelOpen(o => !o)}
                            aria-label={editPanelOpen ? (t('common.close') || 'Close') : (t('common.edit') || 'Edit')}
                        >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span className="hidden md:inline">
                                {editPanelOpen ? (t('common.close') || 'Close') : (t('common.edit') || 'Edit')}
                            </span>
                        </button>
                    )}
                    <button
                        className="inline-flex items-center justify-center rounded-md h-8 w-8 px-0 text-xs font-medium transition-colors gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 md:w-auto md:px-3"
                        onClick={handleSave}
                        disabled={isSaving}
                        aria-label={t('print.printAndSave') || 'Print & Save'}
                    >
                        {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                        <span className="hidden md:inline">{t('print.printAndSave') || 'Print & Save'}</span>
                    </button>
                </div>
            </header>
            <div className="flex flex-1 overflow-hidden light" style={{ colorScheme: 'light' }}>
                <div className="flex-1 overflow-auto p-6 bg-slate-100/50 flex flex-col items-center">
                    <div
                        className={cn(
                            "mx-auto transition-all duration-200 ease-in-out origin-top relative group",
                            isFitToWidth ? "w-full" : "w-fit"
                        )}
                        style={{
                            transform: isFitToWidth ? 'none' : `scale(${zoom / 100})`,
                        }}
                    >
                        {/* Drawing Overlay */}
                        {source.printFormat === 'a4' && (
                            <svg
                                className={cn(
                                    "absolute inset-0 z-[40] touch-none",
                                    drawingMode === 'eraser' ? "pointer-events-none cursor-crosshair" :
                                        drawingMode !== 'none' ? "cursor-crosshair" : "pointer-events-none"
                                )}
                                viewBox="0 0 210 297"
                                onPointerDown={handlePointerDown}
                                onPointerMove={handlePointerMove}
                                onPointerUp={handlePointerUp}
                                onPointerLeave={handlePointerUp}
                            >
                                {/* Current active path preview */}
                                {currentPath && (
                                    <path
                                        d={`M ${currentPath.map(p => `${p.x},${p.y}`).join(' L ')}`}
                                        stroke={brushColor}
                                        strokeWidth={brushSize}
                                        fill="none"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                )}
                            </svg>
                        )}

                        {editableData && source.features && source.printFormat && (
                            <EditablePrintPreviewEditor
                                data={editableData}
                                features={{
                                    ...source.features,
                                    print_lang: tempPrintLang !== 'auto' ? tempPrintLang : source.features.print_lang
                                }}
                                workspaceId={source.workspaceId}
                                workspaceName={source.workspaceName}
                                workspaceFooterContacts={source.workspaceFooterContacts}
                                printFormat={source.printFormat === 'receipt' ? 'receipt' : 'a4'}
                                onDataChange={isAdmin ? setEditableData : undefined}
                                drawingMode={drawingMode}
                                hideUnit={fieldValues.hideUnit === 'true'}
                                hideDiscount={fieldValues.hideDiscount === 'true'}
                                showNotes={fieldValues.showNotes === 'true'}
                                tableRowCount={Number(fieldValues.tableRowCount) || 10}
                                hiddenFields={editableData.hiddenPrintFields}
                                onHiddenFieldChange={drawingMode === 'none' ? handleInvoiceHiddenFieldChange : undefined}
                            />
                        )}
                        {source.printFormat === 'a4' && (
                            <TooltipProvider>
                                <Tooltip delayDuration={200}>
                                    <TooltipTrigger asChild>
                                        <div className="absolute bottom-0 left-0 right-0 h-14 bg-red-500/20 z-[35] cursor-help select-none" />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[260px] p-3 text-xs">
                                        {t('printPreviewEditor.bottomWarning')}
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                        )}
                    </div>
                </div>
                {editPanelOpen && editableData && (
                    <div className="w-72 shrink-0 border-l bg-card overflow-y-auto p-4 space-y-4">
                        <div className="flex items-center justify-between z-10 sticky top-0 bg-card pb-2">
                            <h3 className="text-sm font-semibold">{t('common.fields') || 'Editable Fields'}</h3>
                            <button
                                className="inline-flex items-center justify-center rounded-md h-6 w-6 hover:bg-accent transition-colors"
                                onClick={() => setEditPanelOpen(false)}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>

                        <div className="space-y-3">

                            <div className="space-y-1">
                                <label className="text-[11px] font-medium text-muted-foreground">{t('invoice.soldTo')}</label>
                                <EditableField
                                    value={editableData.customer_name || ''}
                                    onChange={(v) => setEditableData(prev => prev ? { ...prev, customer_name: v } : null)}
                                    type="text"
                                    className="text-sm w-full block border border-transparent hover:border-blue-400"
                                    inputClassName="w-full"
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[11px] font-medium text-muted-foreground">{t('invoice.terms')}</label>
                                <EditableField
                                    value={editableData.terms || ''}
                                    onChange={(v) => setEditableData(prev => prev ? { ...prev, terms: v } : null)}
                                    type="textarea"
                                    className="text-sm w-full block border border-transparent hover:border-blue-400 min-h-[60px]"
                                    inputClassName="w-full min-h-[60px]"
                                />
                            </div>

                            <div className="pt-2 border-t">
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-[11px] font-medium text-muted-foreground">
                                        {t('orders.form.hideUnit', { defaultValue: 'Hide Unit' })}
                                    </span>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={fieldValues.hideUnit === 'true'}
                                        onClick={() => handleFieldChange('hideUnit', fieldValues.hideUnit === 'true' ? 'false' : 'true')}
                                        className={cn(
                                            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                                            fieldValues.hideUnit === 'true' ? 'bg-primary' : 'bg-muted'
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                                                fieldValues.hideUnit === 'true' ? 'translate-x-[18px]' : 'translate-x-0.5'
                                            )}
                                        />
                                    </button>
                                </div>
                            </div>

                            <div className="pt-2 border-t">
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-[11px] font-medium text-muted-foreground">
                                        {t('orders.form.hideDiscount', { defaultValue: 'Hide Discount' })}
                                    </span>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={fieldValues.hideDiscount === 'true'}
                                        onClick={() => handleFieldChange('hideDiscount', fieldValues.hideDiscount === 'true' ? 'false' : 'true')}
                                        className={cn(
                                            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                                            fieldValues.hideDiscount === 'true' ? 'bg-primary' : 'bg-muted'
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                                                fieldValues.hideDiscount === 'true' ? 'translate-x-[18px]' : 'translate-x-0.5'
                                            )}
                                        />
                                    </button>
                                </div>
                            </div>

                            {source.features?.a4_template === 'professional' && (
                                <>
                                    <div className="pt-2 border-t">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-[11px] font-medium text-muted-foreground">
                                                {'Show notes'}
                                            </span>
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={fieldValues.showNotes === 'true'}
                                                onClick={() => handleFieldChange('showNotes', fieldValues.showNotes === 'true' ? 'false' : 'true')}
                                                className={cn(
                                                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                                                    fieldValues.showNotes === 'true' ? 'bg-primary' : 'bg-muted'
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        'absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                                                        fieldValues.showNotes === 'true' ? 'translate-x-[18px]' : 'translate-x-0.5'
                                                    )}
                                                />
                                            </button>
                                        </div>
                                    </div>
                                    <div className="pt-2 border-t space-y-1">
                                        <label className="text-[11px] font-medium text-muted-foreground">
                                            {'Table row count'}
                                        </label>
                                        <input
                                            type="number"
                                            min={1}
                                            max={50}
                                            value={fieldValues.tableRowCount ?? '10'}
                                            onChange={(e) => handleFieldChange('tableRowCount', e.target.value)}
                                            className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                        />
                                    </div>
                                </>
                            )}

                            <div className="pt-2">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-tight">
                                        Current Pictures
                                    </label>
                                    <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded-full font-mono font-bold">
                                        {editableData.attached_images?.length || 0}
                                    </span>
                                </div>
                                <div className="space-y-2">
                                    {(editableData.attached_images || []).map((img, idx) => (
                                        <div key={idx} className="flex items-center gap-2 p-2 rounded-md bg-secondary/20 border border-border/50 group">
                                            <div className="h-8 w-8 rounded border border-border overflow-hidden bg-white shrink-0">
                                                <img
                                                    src={platformService.convertFileSrc(img.path)}
                                                    alt=""
                                                    className="h-full w-full object-cover"
                                                />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[9px] text-muted-foreground font-mono">
                                                    {Math.round(img.x)},{Math.round(img.y)} | {Math.round(img.rotation || 0)}°
                                                </p>
                                            </div>
                                            <button
                                                onClick={() => handleRemoveImage(img.path)}
                                                className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </button>
                                        </div>
                                    ))}
                                    {(editableData.attached_images?.length === 0 || !editableData.attached_images) && (
                                        <div className="py-4 border border-dashed rounded-md flex flex-col items-center justify-center text-muted-foreground text-[10px] gap-1">
                                            <ImagePlus className="h-4 w-4 opacity-20" />
                                            <span>No pictures added</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <DeleteConfirmationModal
                isOpen={isClearConfirmOpen}
                onClose={() => setIsClearConfirmOpen(false)}
                onConfirm={() => {
                    setEditableData(prev => prev ? { ...prev, annotations: [] } : null)
                    setIsClearConfirmOpen(false)
                }}
                title="Clear All Annotations"
                description="This will permanently delete all hand-drawn notes and markings from this document. Are you sure you want to clear everything?"
                itemName="Annotations Layer"
            />
        </div>
    )
}
