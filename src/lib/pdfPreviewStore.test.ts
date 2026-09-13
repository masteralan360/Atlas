import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    clearPendingPDFPreview,
    clearPDFPreviewSource,
    getPendingPDFPreview,
    getPDFPreviewSource,
    setPendingPDFPreview,
    setPDFPreviewSource,
    subscribeToPendingPDFPreview
} from './pdfPreviewStore'

afterEach(() => {
    clearPDFPreviewSource()
    clearPendingPDFPreview()
})

describe('PDF preview state', () => {
    it('stores and clears a standalone PDF preview source', () => {
        const source = { title: 'Saved invoice', pdfBytes: new Uint8Array([1, 2, 3]) }

        setPDFPreviewSource(source)
        expect(getPDFPreviewSource()).toBe(source)

        clearPDFPreviewSource()
        expect(getPDFPreviewSource()).toBeNull()
    })

    it('publishes a pending PDF preview to subscribers', () => {
        const listener = vi.fn()
        const unsubscribe = subscribeToPendingPDFPreview(listener)
        const preview = { url: 'blob:pdf-preview', title: 'Saved document' }

        setPendingPDFPreview(preview)
        expect(getPendingPDFPreview()).toBe(preview)
        expect(listener).toHaveBeenCalledTimes(1)

        unsubscribe()
        clearPendingPDFPreview()
        expect(getPendingPDFPreview()).toBeNull()
        expect(listener).toHaveBeenCalledTimes(1)
    })
})
