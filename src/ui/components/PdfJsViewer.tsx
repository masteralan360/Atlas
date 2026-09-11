import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { ChevronLeft, ChevronRight, Loader2, Printer, Save, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { isTauri } from '@/lib/platform'
import { platformService } from '@/services/platformService'
import { printPdfBlob } from '@/services/pdfPrintService'
import { r2Service } from '@/services/r2Service'

let isPdfWorkerConfigured = false

function ensurePdfWorkerConfigured() {
    if (isPdfWorkerConfigured) return

    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    isPdfWorkerConfigured = true
}

async function resolvePdfBytes(url: string): Promise<Uint8Array> {
    if (url.startsWith('data:')) {
        const commaIndex = url.indexOf(',')
        if (commaIndex < 0) throw new Error('Invalid PDF data URL.')
        const binary = atob(url.slice(commaIndex + 1))
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        return bytes
    }

    const r2Bytes = await r2Service.downloadFromUrl(url)
    if (r2Bytes !== undefined) return new Uint8Array(r2Bytes)

    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load PDF (${response.status}).`)
    return new Uint8Array(await response.arrayBuffer())
}

function sanitizeFileName(title: string | undefined) {
    const baseName = (title || 'document')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 100)

    return baseName || 'document'
}

type PdfJsViewerProps = {
    url?: string
    bytes?: Uint8Array | null
    title?: string
    allowPrint?: boolean
    allowSave?: boolean
    showNavigation?: boolean
    onPrint?: (blob: Blob) => Promise<void> | void
}

export function PdfJsViewer({
    url,
    bytes: suppliedBytes,
    title,
    allowPrint = true,
    allowSave = true,
    showNavigation = false,
    onPrint
}: PdfJsViewerProps) {
    const { t } = useTranslation()
    const pagesContainerRef = useRef<HTMLDivElement>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const currentPageRef = useRef(1)
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
    const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null)
    const [busy, setBusy] = useState(false)
    const [pageCount, setPageCount] = useState(0)
    const [currentPage, setCurrentPage] = useState(1)
    const [zoom, setZoom] = useState(100)

    useEffect(() => {
        currentPageRef.current = 1
        setCurrentPage(1)
        setZoom(100)
    }, [url, suppliedBytes])

    useEffect(() => {
        let cancelled = false
        let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null

        setStatus('loading')
        setPdfBytes(null)
        setPageCount(0)
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
                    const scale = showNavigation
                        ? Math.max(0.25, Math.min(6, fitScale * (zoom / 100)))
                        : fitScale
                    const viewport = page.getViewport({ scale })
                    const canvas = document.createElement('canvas')
                    canvas.width = Math.ceil(viewport.width * outputScale)
                    canvas.height = Math.ceil(viewport.height * outputScale)
                    canvas.style.width = `${Math.ceil(viewport.width)}px`
                    canvas.style.height = `${Math.ceil(viewport.height)}px`
                    canvas.className = showNavigation ? 'block h-auto max-w-none' : 'block h-auto w-full'
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
                    wrapper.className = showNavigation
                        ? 'mx-auto mb-4 w-fit bg-white p-2 shadow-sm last:mb-0'
                        : 'mb-4 w-full bg-white p-2 shadow-sm last:mb-0'
                    wrapper.dataset.pdfPage = String(pageNumber)
                    wrapper.appendChild(canvas)
                    pagesContainerRef.current?.appendChild(wrapper)
                }
                if (!cancelled) {
                    setPageCount(pdf.numPages)
                    setStatus('ready')
                    window.requestAnimationFrame(() => {
                        const scrollContainer = scrollContainerRef.current
                        const pageContainer = pagesContainerRef.current
                        const page = pageContainer?.children.item(Math.min(currentPageRef.current, pdf.numPages) - 1) as HTMLElement | null
                        if (scrollContainer && pageContainer && page) {
                            scrollContainer.scrollTop = pageContainer.offsetTop + page.offsetTop
                        }
                    })
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
    }, [showNavigation, suppliedBytes, url, zoom])

    const scrollToPage = (pageNumber: number) => {
        const nextPage = Math.max(1, Math.min(pageCount, pageNumber))
        const scrollContainer = scrollContainerRef.current
        const pageContainer = pagesContainerRef.current
        const page = pageContainer?.children.item(nextPage - 1) as HTMLElement | null
        if (!scrollContainer || !pageContainer || !page) return
        currentPageRef.current = nextPage
        setCurrentPage(nextPage)
        scrollContainer.scrollTo({
            top: pageContainer.offsetTop + page.offsetTop,
            behavior: 'smooth'
        })
    }

    const handleScroll = () => {
        if (!showNavigation || !pageCount) return
        const scrollContainer = scrollContainerRef.current
        const pageContainer = pagesContainerRef.current
        if (!scrollContainer || !pageContainer) return
        const target = scrollContainer.scrollTop - pageContainer.offsetTop + scrollContainer.clientHeight * 0.25
        let visiblePage = 1
        Array.from(pageContainer.children).forEach((page, index) => {
            if ((page as HTMLElement).offsetTop <= target) visiblePage = index + 1
        })
        currentPageRef.current = visiblePage
        setCurrentPage(visiblePage)
    }

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

    const handleSave = async () => {
        if (!pdfBytes || busy) return
        setBusy(true)
        try {
            const fileName = `${sanitizeFileName(title)}.pdf`
            const savedPath = await platformService.saveAs(pdfBytes, fileName, [
                { name: 'PDF', extensions: ['pdf'] }
            ])
            if (savedPath) return
            if (isTauri()) return

            const blob = new Blob([pdfBytes], { type: 'application/pdf' })
            const objectUrl = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = objectUrl
            anchor.download = fileName
            anchor.style.display = 'none'
            document.body.appendChild(anchor)
            anchor.click()
            document.body.removeChild(anchor)
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
        } catch (error) {
            console.error('[PdfJsViewer] Save failed:', error)
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
                {showNavigation && <>
                    <button
                        className={toolbarButtonClass}
                        onClick={() => scrollToPage(currentPage - 1)}
                        disabled={status !== 'ready' || currentPage <= 1}
                        title={t('printPreviewEditor.previousPage')}
                        aria-label={t('printPreviewEditor.previousPage')}
                    >
                        <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="min-w-[4.5rem] text-center text-xs font-medium text-muted-foreground">
                        {t('printPreviewEditor.pageOf', { page: currentPage, total: pageCount || 1 })}
                    </span>
                    <button
                        className={toolbarButtonClass}
                        onClick={() => scrollToPage(currentPage + 1)}
                        disabled={status !== 'ready' || currentPage >= pageCount}
                        title={t('printPreviewEditor.nextPage')}
                        aria-label={t('printPreviewEditor.nextPage')}
                    >
                        <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                    <div className="mx-1 h-5 w-px bg-border" />
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
                    <div className="mx-1 h-5 w-px bg-border" />
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
                {allowSave && <button
                    className={toolbarButtonClass}
                    onClick={() => void handleSave()}
                    disabled={!pdfBytes || busy}
                    title={t('common.save')}
                    aria-label={t('common.save')}
                >
                    <Save className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">{t('common.save')}</span>
                </button>}
            </div>
            <div
                ref={scrollContainerRef}
                className="relative min-h-0 flex-1 overflow-auto"
                onScroll={handleScroll}
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
                    className={cn('mx-auto w-full p-4', !showNavigation && 'max-w-[1100px]', status !== 'ready' && 'invisible')}
                />
            </div>
        </div>
    )
}
