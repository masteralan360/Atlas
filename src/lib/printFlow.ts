import type { PrintFormat } from '@/services/pdfGenerator'

export const PRINT_PREVIEW_EDITOR_PATH = '/print-preview-editor'

export function shouldOpenPrintPreviewEditor(
    isOpen: boolean,
    selectedFormat: PrintFormat | null,
    alreadyOpened: boolean
) {
    return isOpen && selectedFormat !== null && !alreadyOpened
}
