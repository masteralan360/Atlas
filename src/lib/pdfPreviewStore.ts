export type PDFPreviewSource = {
    title: string
    /** A remote, data, or object URL for the PDF document. */
    url?: string
    /** In-memory PDF bytes, used without creating a long-lived object URL. */
    pdfBytes?: Uint8Array
    /** Opens the browser or native print dialog for the current PDF. */
    onPrint?: (blob: Blob) => Promise<void>
    printActionLabel?: string
}

let pdfPreviewSource: PDFPreviewSource | null = null

export function setPDFPreviewSource(source: PDFPreviewSource) {
    pdfPreviewSource = source
}

export function getPDFPreviewSource(): PDFPreviewSource | null {
    return pdfPreviewSource
}

export function clearPDFPreviewSource() {
    pdfPreviewSource = null
}
