import { describe, expect, it } from 'vitest'

import { isValidLabelPrintPageSize, parseLabelDimensionMm } from './labelPrint'

describe('dynamic label page dimensions', () => {
    it('accepts positive decimal millimeter values', () => {
        expect(parseLabelDimensionMm('70')).toBe(70)
        expect(parseLabelDimensionMm('40.5')).toBe(40.5)
        expect(isValidLabelPrintPageSize({ widthMm: 70, heightMm: 40 })).toBe(true)
    })

    it('keeps empty, zero, negative, and non-finite values invalid', () => {
        for (const value of ['', '  ', '0', '-1', 'NaN', 'Infinity']) {
            expect(parseLabelDimensionMm(value)).toBeNull()
        }
        expect(isValidLabelPrintPageSize({ widthMm: 70, heightMm: 0 })).toBe(false)
        expect(isValidLabelPrintPageSize({ widthMm: Number.NaN, heightMm: 40 })).toBe(false)
    })
})
