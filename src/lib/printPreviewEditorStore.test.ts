import { afterEach, describe, expect, it } from 'vitest'
import {
    A4_PAGE_HEIGHT_MM,
    clearPrintPreviewEditorSource,
    getCustomTemplateLayoutHeightMm,
    getCustomTemplateLayoutOverflowHeightMm,
    getCustomTemplateLayoutPageCount,
    getPrintPreviewEditorSource,
    setPrintPreviewEditorSource,
    shouldReflowCustomTemplateText,
    isTemplateTextFlowEnabled
} from './printPreviewEditorStore'
import type { CustomTemplateLayout, TemplatePreview } from './printPreviewEditorStore'

describe('optional native text-position anchor', () => {
    it('keeps saved text absolute when disabled without changing text or other templates', () => {
        const preview = { reflowLowerPageText: true, textFlowAnchorField: 'enableTextPositionAnchor' } as TemplatePreview
        const text = { id: 'note', text: 'Saved note', x: 10, y: 250, width: 80, rotation: 0, anchor: 'afterContent' as const }
        expect(isTemplateTextFlowEnabled(preview, {})).toBe(true)
        expect(shouldReflowCustomTemplateText(text, 297, isTemplateTextFlowEnabled(preview, { enableTextPositionAnchor: 'false' }))).toBe(false)
        expect(text.y).toBe(250)
        expect(text.text).toBe('Saved note')
        expect(isTemplateTextFlowEnabled({ reflowLowerPageText: true } as TemplatePreview, { enableTextPositionAnchor: 'false' })).toBe(true)
    })
})

function createLayout(overrides: Partial<CustomTemplateLayout> = {}): CustomTemplateLayout {
    return {
        version: 1,
        moduleTypeKey: 'test.A4',
        page: { widthMm: 210, heightMm: A4_PAGE_HEIGHT_MM },
        fields: {},
        annotations: [],
        texts: [],
        images: [],
        shapes: [],
        updatedAt: '2026-06-23T00:00:00.000Z',
        ...overrides
    }
}

afterEach(() => {
    clearPrintPreviewEditorSource()
})

describe('print preview editor state', () => {
    it('stores and clears the active editor source', () => {
        const source = { title: 'Print Preview Editor' }

        setPrintPreviewEditorSource(source)
        expect(getPrintPreviewEditorSource()).toBe(source)

        clearPrintPreviewEditorSource()
        expect(getPrintPreviewEditorSource()).toBeNull()
    })
})

describe('custom template page extents', () => {
    it('keeps an empty A4 template to one fixed page', () => {
        const layout = createLayout()

        expect(getCustomTemplateLayoutOverflowHeightMm(layout)).toBe(0)
        expect(getCustomTemplateLayoutHeightMm(layout)).toBe(A4_PAGE_HEIGHT_MM)
        expect(getCustomTemplateLayoutPageCount(layout)).toBe(1)
    })

    it('creates another A4 page when a moved component crosses the page bottom', () => {
        const layout = createLayout({
            componentPositions: {
                totals: { x: 0, y: A4_PAGE_HEIGHT_MM + 5 }
            }
        })

        expect(getCustomTemplateLayoutPageCount(layout)).toBe(2)
    })

    it('creates another A4 page when an annotation crosses the page bottom', () => {
        const layout = createLayout({
            annotations: [{
                type: 'pen',
                color: '#000000',
                brushSize: 2,
                points: [{ x: 10, y: A4_PAGE_HEIGHT_MM + 1 }]
            }]
        })

        expect(getCustomTemplateLayoutPageCount(layout)).toBe(2)
    })

    it('creates another A4 page when a shape crosses the page bottom', () => {
        const layout = createLayout({
            shapes: [{
                id: 'shape-1',
                kind: 'circle',
                color: '#ef4444',
                x: 10,
                y: A4_PAGE_HEIGHT_MM,
                width: 20,
                rotation: 0
            }]
        })

        expect(getCustomTemplateLayoutPageCount(layout)).toBe(2)
    })
})

describe('lower-page text reflow', () => {
    const footerText = {
        id: 'footer-note',
        text: 'Footer note',
        x: 20,
        y: 260,
        width: 140,
        rotation: 0
    }

    it('reflows legacy lower-page text only when the template supports it', () => {
        expect(shouldReflowCustomTemplateText(footerText, A4_PAGE_HEIGHT_MM, true)).toBe(true)
        expect(shouldReflowCustomTemplateText(footerText, A4_PAGE_HEIGHT_MM, false)).toBe(false)
    })

    it('respects explicit absolute and after-content anchors', () => {
        expect(shouldReflowCustomTemplateText({ ...footerText, anchor: 'absolute' }, A4_PAGE_HEIGHT_MM, true)).toBe(false)
        expect(shouldReflowCustomTemplateText({ ...footerText, y: 20, anchor: 'afterContent' }, A4_PAGE_HEIGHT_MM, true)).toBe(true)
    })
})
