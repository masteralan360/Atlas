import { describe, expect, it } from 'vitest'
import { PRINT_PREVIEW_EDITOR_PATH, shouldOpenPrintPreviewEditor } from './printFlow'

describe('print workflow routing', () => {
    it.each(['a4', 'receipt', 'label'] as const)(
        'opens the print editor directly after selecting the %s format',
        (format) => {
            expect(shouldOpenPrintPreviewEditor(true, format, false)).toBe(true)
            expect(PRINT_PREVIEW_EDITOR_PATH).toBe('/print-preview-editor')
        }
    )

    it('waits for a selection and only opens once while the selection flow is active', () => {
        expect(shouldOpenPrintPreviewEditor(true, null, false)).toBe(false)
        expect(shouldOpenPrintPreviewEditor(false, 'a4', false)).toBe(false)
        expect(shouldOpenPrintPreviewEditor(true, 'a4', true)).toBe(false)
    })
})
