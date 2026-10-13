import { afterEach, describe, expect, it } from 'vitest'
import {
    clearPDFPreviewSource,
    getPDFPreviewSource,
    setPDFPreviewSource
} from './pdfPreviewStore'

afterEach(() => {
    clearPDFPreviewSource()
})

describe('PDF preview state', () => {
    it('stores and clears a standalone PDF preview source', () => {
        const source = { title: 'Saved invoice', pdfBytes: new Uint8Array([1, 2, 3]) }

        setPDFPreviewSource(source)
        expect(getPDFPreviewSource()).toBe(source)

        clearPDFPreviewSource()
        expect(getPDFPreviewSource()).toBeNull()
    })
})
