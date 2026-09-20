import { describe, it, expect } from 'vitest'
import { convertArabicIndicToLatin, sanitizeNumericInput, parseFormattedNumber } from './utils'

describe('Arabic/Persian Numeral Conversion', () => {
    describe('convertArabicIndicToLatin', () => {
        it('should convert Arabic-Indic digits', () => {
            expect(convertArabicIndicToLatin('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
        })

        it('should convert Persian digits', () => {
            expect(convertArabicIndicToLatin('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789')
        })

        it('should handle mixed input', () => {
            expect(convertArabicIndicToLatin('١٢٣ Main St 456')).toBe('123 Main St 456')
        })

        it('should handle empty input', () => {
            expect(convertArabicIndicToLatin('')).toBe('')
        })

        it('should handle null/undefined', () => {
            expect(convertArabicIndicToLatin(null as any)).toBe(null)
        })
    })

    describe('sanitizeNumericInput with Arabic digits', () => {
        it('should convert and sanitize whole numbers', () => {
            expect(sanitizeNumericInput('١،٢٣٤')).toBe('1234')
        })

        it('should handle decimals with Arabic digits', () => {
            expect(sanitizeNumericInput('١٢.٣٤')).toBe('12.34')
        })

        it('should preserve Arabic decimal separators and remove Arabic grouping separators', () => {
            expect(sanitizeNumericInput('١٬٢٣٤٫٥٦')).toBe('1234.56')
            expect(sanitizeNumericInput('۱۲٫۵')).toBe('12.5')
        })

        it('should accept a comma decimal separator during unformatted editing', () => {
            expect(sanitizeNumericInput('12,5', { commaAsDecimal: true })).toBe('12.5')
            expect(sanitizeNumericInput('1,234.5')).toBe('1234.5')
        })
    })

    describe('parseFormattedNumber with Arabic digits', () => {
        it('should parse Arabic numbers with commas', () => {
            expect(parseFormattedNumber('١،٢٣٤.٥٦')).toBe(1234.56)
        })

        it('should parse Arabic decimal and grouping separators', () => {
            expect(parseFormattedNumber('١٬٢٣٤٫٥٦')).toBe(1234.56)
        })
    })
})
