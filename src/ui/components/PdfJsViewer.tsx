import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { Loader2, Printer, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { resolvePdfBytes } from '@/lib/pdfViewerBytes'
import { printPdfBlob } from '@/services/pdfPrintService'

let isPdfWorkerConfigured = false

function ensurePdfWorkerConfigured() {
    if (isPdfWorkerConfigured) return

    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    isPdfWorkerConfigured = true
}

type PdfJsViewerProps = {
    url?: string
    bytes?: Uint8Array | null
    title?: string
    allowPrint?: boolean
    showZoom?: boolean
    onPrint?: (blob: Blob) => Promise<void> | void
}

export function PdfJsViewer({
    url,
    bytes: suppliedBytes,
    title,
    allowPrint = true,
    showZoom = false,
    onPrint
}: PdfJsViewerProps) {
    const { t } = useTranslation()
    const pagesContainerRef = useRef<HTMLDivElement>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
    const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null)
    const [busy, setBusy] = useState(false)
    const [zoom, setZoom] = useState(100)

    useEffect(() => {
        setZoom(100)
    }, [url, suppliedBytes])

    useEffect(() => {
        let cancelled = false
        let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null

        setStatus('loading')
        setPdfBytes(null)
        const container = pagesContainerRef.current
        if (container) container.innerHTML = ''

        const render = async () => {
            try {
                ensurePdfWorkerConfigured()
                const bytes = suppliedBytes ? suppliedBytes.slice() : url ? await resolvePdfBytes(url) : null
                if (!bytes) throw new Error('No PDF source was provided.')
                if (cancelled) return

                setPdfBytes(bytes)

                loadingTask = pdfjsLib.getDocument({ data: bytes.slice() })
                const pdf = await loadingTask.promise
                if (cancelled) return

                const containerWidth = scrollContainerRef.current?.clientWidth || pagesContainerRef.current?.clientWidth || 900
                // Render at the display scale multiplied by the device pixel ratio. This keeps
                // inline previews crisp on high-density displays without changing their layout.
                const outputScale = Math.min(window.devicePixelRatio || 1, 3)
                for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
                    if (cancelled) return
                    const page = await pdf.getPage(pageNumber)
                    const baseViewport = page.getViewport({ scale: 1 })
                    const fitScale = Math.max(0.25, Math.min(3, (containerWidth - 32) / baseViewport.width))
                    const scale = showZoom
                        ? Math.max(0.25, Math.min(6, fitScale * (zoom / 100)))
                        : fitScale
                    const viewport = page.getViewport({ scale })
                    const canvas = document.createElement('canvas')
                    canvas.width = Math.ceil(viewport.width * outputScale)
                    canvas.height = Math.ceil(viewport.height * outputScale)
                    canvas.style.width = `${Math.ceil(viewport.width)}px`
                    canvas.style.height = `${Math.ceil(viewport.height)}px`
                    canvas.className = showZoom ? 'block h-auto max-w-none' : 'block h-auto w-full'
                    const context = canvas.getContext('2d', { alpha: false })
                    if (!context) throw new Error('Unable to create a canvas context for PDF viewing.')
                    context.fillStyle = '#ffffff'
                    context.fillRect(0, 0, canvas.width, canvas.height)
                    await page.render({
                        canvas,
                        viewport,
                        background: '#ffffff',
                        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
                    }).promise
                    if (cancelled) return

                    const wrapper = document.createElement('div')
                    wrapper.className = showZoom
                        ? 'mx-auto mb-4 w-fit bg-white p-2 shadow-sm last:mb-0'
                        : 'mb-4 w-full bg-white p-2 shadow-sm last:mb-0'
                    wrapper.dataset.pdfPage = String(pageNumber)
                    wrapper.appendChild(canvas)
                    pagesContainerRef.current?.appendChild(wrapper)
                }
                if (!cancelled) {
                    setStatus('ready')
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('[PdfJsViewer] Unable to render PDF:', err)
                    setStatus('error')
                }
            } finally {
                if (loadingTask && !cancelled) {
                    try {
                        void loadingTask.destroy()
                    } catch {
                        // already destroyed
                    }
                }
            }
        }

        void render()

        return () => {
            cancelled = true
            if (loadingTask) {
                try {
                    void loadingTask.destroy()
                } catch {
                    // already destroyed
                }
            }
        }
    }, [showZoom, suppliedBytes, url, zoom])

    const handlePrint = async () => {
        if (!pdfBytes || busy) return
        setBusy(true)
        try {
            const blob = new Blob([pdfBytes], { type: 'application/pdf' })
            if (onPrint) await onPrint(blob)
            else await printPdfBlob(blob, { title })
        } catch (error) {
            console.error('[PdfJsViewer] Print failed:', error)
        } finally {
            setBusy(false)
        }
    }

    const toolbarButtonClass = cn(
        'inline-flex items-center justify-center rounded-md h-8 w-8 px-0 text-xs font-medium transition-colors gap-1.5',
        'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 md:w-auto md:px-3'
    )

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-gray-100">
            <div className="z-10 flex shrink-0 items-center gap-1 border-b bg-card px-2 py-1.5 md:gap-2 md:px-4">
                {showZoom && <>
                    <button
                        className={toolbarButtonClass}
                        onClick={() => setZoom((value) => Math.max(50, value - 25))}
                        disabled={status === 'loading' || zoom <= 50}
                        title={t('printPreviewEditor.zoomOut')}
                        aria-label={t('printPreviewEditor.zoomOut')}
                    >
                        <ZoomOut className="h-3.5 w-3.5" />
                    </button>
                    <button
                        className={toolbarButtonClass}
                        onClick={() => setZoom(100)}
                        disabled={status === 'loading' || zoom === 100}
                        title={t('printPreviewEditor.resetZoom')}
                        aria-label={t('printPreviewEditor.resetZoom')}
                    >
                        <span>{zoom}%</span>
                    </button>
                    <button
                        className={toolbarButtonClass}
                        onClick={() => setZoom((value) => Math.min(300, value + 25))}
                        disabled={status === 'loading' || zoom >= 300}
                        title={t('printPreviewEditor.zoomIn')}
                        aria-label={t('printPreviewEditor.zoomIn')}
                    >
                        <ZoomIn className="h-3.5 w-3.5" />
                    </button>
                    {allowPrint ? <div className="mx-1 h-5 w-px bg-border" /> : null}
                </>}
                {allowPrint && <button
                    className={toolbarButtonClass}
                    onClick={() => void handlePrint()}
                    disabled={!pdfBytes || busy}
                    title={t('common.print')}
                    aria-label={t('common.print')}
                >
                    <Printer className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">{t('common.print')}</span>
                </button>}
            </div>
            <div
                ref={scrollContainerRef}
                className="relative min-h-0 flex-1 overflow-auto"
            >
                {status !== 'ready' && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-gray-100 px-6 text-center">
                        {status === 'loading' ? (
                            <>
                                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                <span className="text-sm text-muted-foreground">{t('printPreviewEditor.loadingPdf')}</span>
                            </>
                        ) : (
                            <div className="flex flex-col gap-1">
                                <p className="text-sm font-medium text-destructive">{t('printPreviewEditor.pdfUnavailable')}</p>
                                {title ? <p className="text-xs text-muted-foreground">{title}</p> : null}
                            </div>
                        )}
                    </div>
                )}
                <div
                    ref={pagesContainerRef}
                    className={cn('mx-auto w-full p-4', !showZoom && 'max-w-[1100px]', status !== 'ready' && 'invisible')}
                />
            </div>
        </div>
    )
}
