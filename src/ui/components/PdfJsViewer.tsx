import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { Loader2, Printer, Save } from 'lucide-react'
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
}

export function PdfJsViewer({ url, bytes: suppliedBytes, title, allowPrint = true, allowSave = true }: PdfJsViewerProps) {
    const pagesContainerRef = useRef<HTMLDivElement>(null)
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
    const [errorMessage, setErrorMessage] = useState('')
    const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        let cancelled = false
        let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null

        setStatus('loading')
        setErrorMessage('')
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

                const containerWidth = pagesContainerRef.current?.clientWidth || 900
                // Render at the display scale multiplied by the device pixel ratio. This keeps
                // inline previews crisp on high-density displays without changing their layout.
                const outputScale = Math.min(window.devicePixelRatio || 1, 3)
                for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
                    if (cancelled) return
                    const page = await pdf.getPage(pageNumber)
                    const baseViewport = page.getViewport({ scale: 1 })
                    const scale = Math.max(1, Math.min(3, containerWidth / baseViewport.width))
                    const viewport = page.getViewport({ scale })
                    const canvas = document.createElement('canvas')
                    canvas.width = Math.ceil(viewport.width * outputScale)
                    canvas.height = Math.ceil(viewport.height * outputScale)
                    canvas.style.width = `${Math.ceil(viewport.width)}px`
                    canvas.style.height = `${Math.ceil(viewport.height)}px`
                    canvas.className = 'block h-auto w-full'
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
                    wrapper.className = 'mb-4 w-full bg-white p-2 shadow-sm last:mb-0'
                    wrapper.appendChild(canvas)
                    pagesContainerRef.current?.appendChild(wrapper)
                }
                if (!cancelled) setStatus('ready')
            } catch (err) {
                if (!cancelled) {
                    setErrorMessage(err instanceof Error ? err.message : 'Unknown error')
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
    }, [url, suppliedBytes])

    const handlePrint = async () => {
        if (!pdfBytes || busy) return
        setBusy(true)
        try {
            await printPdfBlob(new Blob([pdfBytes], { type: 'application/pdf' }), { title })
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
                {allowPrint && <button
                    className={toolbarButtonClass}
                    onClick={() => void handlePrint()}
                    disabled={!pdfBytes || busy}
                    title="Print"
                    aria-label="Print"
                >
                    <Printer className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">Print</span>
                </button>}
                {allowSave && <button
                    className={toolbarButtonClass}
                    onClick={() => void handleSave()}
                    disabled={!pdfBytes || busy}
                    title="Save"
                    aria-label="Save"
                >
                    <Save className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">Save</span>
                </button>}
            </div>
            <div className="relative min-h-0 flex-1 overflow-y-auto">
                {status !== 'ready' && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-gray-100 px-6 text-center">
                        {status === 'loading' ? (
                            <>
                                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                <span className="text-sm text-muted-foreground">Loading PDF…</span>
                            </>
                        ) : (
                            <div className="flex flex-col gap-1">
                                <p className="text-sm font-medium text-destructive">{errorMessage}</p>
                                {title ? <p className="text-xs text-muted-foreground">{title}</p> : null}
                            </div>
                        )}
                    </div>
                )}
                <div
                    ref={pagesContainerRef}
                    className={cn('mx-auto w-full max-w-[1100px] p-4', status === 'loading' && 'invisible')}
                />
            </div>
        </div>
    )
}
