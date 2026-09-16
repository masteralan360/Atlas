import { describe, expect, it } from 'vitest'

import {
    ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM,
    classifyAtlasStandardOverlay,
    floorAtlasStandardHeaderStep,
    getAtlasStandardOverlayPageSnapMm,
    getAtlasStandardHeaderDeltaMm,
    resolveAtlasStandardOverlayDrag,
    resolveAtlasStandardHeaderRange
} from './atlasStandardHeaderLayout'

describe('Atlas Standard adjustable header layout', () => {
    it('uses only the unused space inside the natural page count', () => {
        const range = resolveAtlasStandardHeaderRange({
            requestedHeightMm: 80,
            currentHeightMm: 80,
            minHeightMm: 13,
            contentBottomMm: 290
        })

        expect(range.naturalPageCount).toBe(1)
        expect(range.maxHeightMm).toBe(79)
        expect(range.effectiveHeightMm).toBe(79)
    })

    it('keeps a naturally two-page document at two pages', () => {
        const range = resolveAtlasStandardHeaderRange({
            requestedHeightMm: 180,
            currentHeightMm: 180,
            minHeightMm: 13,
            contentBottomMm: 700
        })

        expect(range.naturalPageCount).toBe(2)
        expect(range.maxHeightMm).toBe(66)
        expect(range.effectiveHeightMm).toBe(66)
    })

    it('clamps only as much as necessary when content returns', () => {
        const range = resolveAtlasStandardHeaderRange({
            requestedHeightMm: 180,
            currentHeightMm: 180,
            minHeightMm: 13,
            contentBottomMm: 324
        })

        expect(range.maxHeightMm).toBe(145)
        expect(range.effectiveHeightMm).toBe(145)
    })

    it('rounds the effective maximum downward to the slider step', () => {
        expect(floorAtlasStandardHeaderStep(145.49)).toBe(145)
        expect(floorAtlasStandardHeaderStep(145.51)).toBe(145.5)
    })

    it('never shrinks below the content-safe minimum', () => {
        const range = resolveAtlasStandardHeaderRange({
            requestedHeightMm: 2,
            currentHeightMm: ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM,
            minHeightMm: 18.5,
            contentBottomMm: 250
        })

        expect(range.minHeightMm).toBe(18.5)
        expect(range.effectiveHeightMm).toBe(18.5)
    })

    it('classifies overlays relative to the original divider', () => {
        expect(classifyAtlasStandardOverlay(3, 18)).toBe('header')
        expect(classifyAtlasStandardOverlay(21, 30)).toBe('body')
        expect(classifyAtlasStandardOverlay(18, 24)).toBe('crossing')
    })

    it('keeps a dragged image under the cursor when it crosses into the enlarged-header body', () => {
        const headerHeightMm = 80
        const visualTopMm = 90
        const position = resolveAtlasStandardOverlayDrag({
            visualTopMm,
            heightMm: 18,
            headerHeightMm
        })

        expect(position.anchor).toBe('body')
        expect(position.storedTopMm + getAtlasStandardHeaderDeltaMm(headerHeightMm)).toBe(visualTopMm)
    })

    it('keeps header and divider-crossing images in visual coordinates', () => {
        expect(resolveAtlasStandardOverlayDrag({
            visualTopMm: 20,
            heightMm: 18,
            headerHeightMm: 80
        })).toEqual({ anchor: 'header', storedTopMm: 20 })
        expect(resolveAtlasStandardOverlayDrag({
            visualTopMm: 82,
            heightMm: 18,
            headerHeightMm: 80
        })).toEqual({ anchor: 'crossing', storedTopMm: 82 })
    })

    it('snaps a shifted body object intact below the next printable page edge', () => {
        expect(getAtlasStandardOverlayPageSnapMm(285, 305)).toBe(20)
        expect(getAtlasStandardOverlayPageSnapMm(270, 280)).toBe(0)
    })
})
