import { isIosPwa } from '@/lib/platform'

interface PrintPdfBlobOptions {
    title?: string
    printWindow?: Window | null
}

/** Opens a top-level browsing context during the user's print tap. */
export function preparePdfPrintWindow(): Window | null | undefined {
    if (!isIosPwa()) return undefined

    try {
        const printWindow = window.open('about:blank', '_blank')
        if (printWindow) printWindow.opener = null
        return printWindow
    } catch {
        return null
    }
}

export function closeUnusedPdfPrintWindow(printWindow?: Window | null) {
    if (!printWindow) return

    try {
        if (!printWindow.closed && printWindow.location.href === 'about:blank') {
            printWindow.close()
        }
    } catch {
        // The target may already have navigated away from the app's origin.
    }
}

export async function printPdfBlob(pdfBlob: Blob, { title = 'Receipt', printWindow }: PrintPdfBlobOptions = {}) {
    const pdfUrl = URL.createObjectURL(pdfBlob)

    if (isIosPwa()) {
        try {
            if (printWindow && !printWindow.closed) {
                printWindow.location.replace(pdfUrl)
            } else {
                // If iOS blocks the new tab, use the current top-level PDF viewer
                // rather than falling back to the hidden iframe print path.
                window.location.assign(pdfUrl)
            }
            window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 5 * 60_000)
            return
        } catch (error) {
            URL.revokeObjectURL(pdfUrl)
            closeUnusedPdfPrintWindow(printWindow)
            throw error
        }
    }

    const iframe = document.createElement('iframe')

    iframe.title = title
    iframe.src = pdfUrl
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    iframe.style.opacity = '0'

    document.body.appendChild(iframe)

    await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            reject(new Error('Timed out while loading the receipt PDF for printing.'))
        }, 10_000)

        iframe.onload = () => {
            window.clearTimeout(timeout)

            try {
                iframe.contentWindow?.focus()
                iframe.contentWindow?.print()
                resolve()
            } catch (error) {
                reject(error)
            }
        }
    })

    window.setTimeout(() => {
        iframe.remove()
        URL.revokeObjectURL(pdfUrl)
    }, 60_000)
}
