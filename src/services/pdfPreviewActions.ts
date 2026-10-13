import { downloadPdfBlob } from '@/services/pdfGenerator'

export function getPDFPreviewFileName(title: string) {
    const safeTitle = title
        .trim()
        .replace(/[<>:"/\\|?*]|\p{Cc}/gu, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 120)

    return `${safeTitle || 'pdf-preview'}.pdf`
}

export function savePDFPreviewBlob(blob: Blob, title: string) {
    downloadPdfBlob(blob, getPDFPreviewFileName(title))
}

/** Returns false after preserving PDFPreviewPage's download fallback. */
export async function sharePDFPreviewBlob(blob: Blob, title: string): Promise<boolean> {
    const fileName = getPDFPreviewFileName(title)
    const file = new File([blob], fileName, { type: 'application/pdf' })

    if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: fileName, files: [file] })
        return true
    }

    savePDFPreviewBlob(blob, title)
    return false
}
