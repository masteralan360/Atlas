import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Download, Loader2, Printer, Share2 } from 'lucide-react'
import {
    clearPDFPreviewSource,
    getPDFPreviewSource
} from '@/lib/pdfPreviewStore'
import { resolvePdfBytes } from '@/lib/pdfViewerBytes'
import { downloadPdfBlob } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { PdfJsViewer } from '@/ui/components/PdfJsViewer'
import { useToast } from '@/ui/components/use-toast'

function getPDFPreviewFileName(title: string) {
    const safeTitle = title
        .trim()
        .replace(/[<>:"/\\|?*]|\p{Cc}/gu, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 120)

    return `${safeTitle || 'pdf-preview'}.pdf`
}

export function PDFPreviewPage() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const [isWorking, setIsWorking] = useState(false)
    const sourceRef = useRef(getPDFPreviewSource())
    const source = sourceRef.current
    const title = source?.title || t('pdfPreview.title')

    const getPdfBlob = useCallback(async (): Promise<Blob> => {
        if (!source) throw new Error('Missing PDF preview source.')

        const bytes = source.pdfBytes?.slice()
            || (source.url ? await resolvePdfBytes(source.url) : null)
        if (!bytes) throw new Error('Failed to load PDF.')

        return new Blob([bytes], { type: 'application/pdf' })
    }, [source])

    const handleBack = useCallback(() => {
        clearPDFPreviewSource()
        window.history.back()
    }, [])

    const handleSave = useCallback(async () => {
        if (isWorking) return

        setIsWorking(true)
        try {
            downloadPdfBlob(await getPdfBlob(), getPDFPreviewFileName(title))
        } catch (error) {
            console.error('Failed to save preview PDF:', error)
            toast({
                title: t('pdfPreview.saveErrorTitle'),
                description: t('pdfPreview.saveErrorDescription'),
                variant: 'destructive'
            })
        } finally {
            setIsWorking(false)
        }
    }, [getPdfBlob, isWorking, t, title, toast])

    const handleShare = useCallback(async () => {
        if (isWorking) return

        setIsWorking(true)
        try {
            const blob = await getPdfBlob()
            const fileName = getPDFPreviewFileName(title)
            const file = new File([blob], fileName, { type: 'application/pdf' })

            if (navigator.canShare?.({ files: [file] })) {
                await navigator.share({ title: fileName, files: [file] })
                return
            }

            downloadPdfBlob(blob, fileName)
            toast({
                title: t('pdfPreview.shareUnavailableTitle'),
                description: t('pdfPreview.shareUnavailableDescription')
            })
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return

            console.error('Failed to share preview PDF:', error)
            toast({
                title: t('pdfPreview.shareErrorTitle'),
                description: t('pdfPreview.shareErrorDescription'),
                variant: 'destructive'
            })
        } finally {
            setIsWorking(false)
        }
    }, [getPdfBlob, isWorking, t, title, toast])

    const handlePrint = useCallback(async () => {
        if (isWorking) return

        setIsWorking(true)
        try {
            const blob = await getPdfBlob()
            if (source?.onPrint) await source.onPrint(blob)
            else await printPdfBlob(blob, { title })
        } catch (error) {
            console.error('Failed to print PDF:', error)
            toast({
                title: t('pdfPreview.printErrorTitle'),
                description: t('pdfPreview.printErrorDescription'),
                variant: 'destructive'
            })
        } finally {
            setIsWorking(false)
        }
    }, [getPdfBlob, isWorking, source, t, title, toast])

    if (!source || (!source.url && !source.pdfBytes)) {
        return (
            <div
                className="flex h-screen items-center justify-center bg-background"
                style={{ marginTop: 'var(--titlebar-height)', height: 'calc(100vh - var(--titlebar-height))' }}
            >
                <p className="text-muted-foreground">{t('pdfPreview.unavailable')}</p>
            </div>
        )
    }

    const saveLabel = t('pdfPreview.save')
    const shareLabel = t('pdfPreview.share')
    const printLabel = source.printActionLabel || t('pdfPreview.print')

    return (
        <div
            className="flex h-screen w-screen flex-col overflow-hidden bg-background"
            style={{ marginTop: 'var(--titlebar-height)', height: 'calc(100vh - var(--titlebar-height))' }}
        >
            <header className="flex items-center gap-2 border-b bg-card px-2 py-1.5 md:justify-between md:px-4 md:py-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
                    <button
                        type="button"
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
                        onClick={handleBack}
                        aria-label={t('pdfPreview.back')}
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </button>
                    <h1 className="truncate text-sm font-semibold">{title}</h1>
                </div>
                <div className="flex shrink-0 items-center gap-1 md:gap-2">
                    <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center gap-1.5 rounded-md bg-secondary px-0 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:opacity-50 md:w-auto md:px-3"
                        onClick={handleSave}
                        disabled={isWorking}
                        aria-label={saveLabel}
                    >
                        {isWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                        <span className="hidden md:inline">{saveLabel}</span>
                    </button>
                    <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-0 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 md:w-auto md:px-3"
                        onClick={handleShare}
                        disabled={isWorking}
                        aria-label={shareLabel}
                    >
                        {isWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
                        <span className="hidden md:inline">{shareLabel}</span>
                    </button>
                    <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center gap-1.5 rounded-md bg-primary px-0 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 md:w-auto md:px-3"
                        onClick={handlePrint}
                        disabled={isWorking}
                        aria-label={printLabel}
                    >
                        {isWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                        <span className="hidden md:inline">{printLabel}</span>
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
