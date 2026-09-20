import { describe, expect, it } from 'vitest'

import {
    BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT,
    BARCODE_SCANNER_ACTIVE_KEY_GRACE_MS,
    BARCODE_SCANNER_BLUETOOTH_ACTIVE_KEY_GRACE_MS,
    BARCODE_SCANNER_BLUETOOTH_FAST_KEY_THRESHOLD_MS,
    BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS,
    classifyBarcodeScannerKeyTiming,
    createBarcodeScannerCodeIndex,
    getBarcodeScannerEventKey,
    normalizeBarcodeScannerText,
    shouldIgnoreBarcodeScannerKey,
    shouldCommitBarcodeScannerValue
} from './barcodeScanner'

function keyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
    return {
        key: '',
        code: '',
        shiftKey: false,
        getModifierState: () => false,
        ...overrides
    } as KeyboardEvent
}

describe('barcode scanner utilities', () => {
    it('keeps a complete same-timestamp hardware burst in one scan', () => {
        const barcode = '1234567890123'
        const timestamp = 100
        let previousTimestamp = 0
        let buffer = ''
        let fastKeyCount = 0
        let isActive = false

        for (const key of barcode) {
            const timing = classifyBarcodeScannerKeyTiming(timestamp, previousTimestamp, {
                hasBufferedValue: Boolean(buffer),
                isActive
            })

            if (timing.shouldReset) {
                buffer = ''
                fastKeyCount = 0
                isActive = false
            }
            if (timing.isFast) {
                fastKeyCount += 1
            }

            buffer += key
            isActive ||= fastKeyCount >= BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT
            previousTimestamp = timestamp
        }

        expect(buffer).toBe(barcode)
        expect(isActive).toBe(true)
    })

    it('honors fast and active scanner timing boundaries', () => {
        expect(classifyBarcodeScannerKeyTiming(BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS, 0, {
            hasBufferedValue: true,
            isActive: false
        })).toMatchObject({ shouldReset: false, isFast: true })
        expect(classifyBarcodeScannerKeyTiming(BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS + 1, 0, {
            hasBufferedValue: true,
            isActive: false
        }).shouldReset).toBe(true)
        expect(classifyBarcodeScannerKeyTiming(BARCODE_SCANNER_ACTIVE_KEY_GRACE_MS, 0, {
            hasBufferedValue: true,
            isActive: true
        })).toMatchObject({ shouldReset: false, isFast: false })
        expect(classifyBarcodeScannerKeyTiming(BARCODE_SCANNER_ACTIVE_KEY_GRACE_MS + 1, 0, {
            hasBufferedValue: true,
            isActive: true
        }).shouldReset).toBe(true)
    })

    it('does not let scanner capture hijack typing in another editable field', () => {
        expect(shouldIgnoreBarcodeScannerKey({
            hasFocusedEditable: true,
            isScannerTargetFocused: false
        })).toBe(true)
        expect(shouldIgnoreBarcodeScannerKey({
            hasFocusedEditable: true,
            isScannerTargetFocused: true
        })).toBe(false)
        expect(shouldIgnoreBarcodeScannerKey({
            hasFocusedEditable: false,
            isScannerTargetFocused: false
        })).toBe(false)
    })

    it('resets scanner timing after a clock discontinuity', () => {
        expect(classifyBarcodeScannerKeyTiming(99, 100, {
            hasBufferedValue: true,
            isActive: false
        }).shouldReset).toBe(true)
    })

    it('supports a wider Bluetooth scanner timing profile', () => {
        expect(classifyBarcodeScannerKeyTiming(BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS + 50, 0, {
            hasBufferedValue: true,
            isActive: false,
            fastKeyThresholdMs: BARCODE_SCANNER_BLUETOOTH_FAST_KEY_THRESHOLD_MS,
            activeKeyGraceMs: BARCODE_SCANNER_BLUETOOTH_ACTIVE_KEY_GRACE_MS
        })).toMatchObject({ shouldReset: false, isFast: true })

        expect(classifyBarcodeScannerKeyTiming(BARCODE_SCANNER_ACTIVE_KEY_GRACE_MS + 500, 0, {
            hasBufferedValue: true,
            isActive: true,
            fastKeyThresholdMs: BARCODE_SCANNER_BLUETOOTH_FAST_KEY_THRESHOLD_MS,
            activeKeyGraceMs: BARCODE_SCANNER_BLUETOOTH_ACTIVE_KEY_GRACE_MS
        })).toMatchObject({ shouldReset: false, isFast: false })
    })

    it('normalizes Arabic and Persian digits plus bidi marks', () => {
        expect(normalizeBarcodeScannerText('\u200f١٢٣۴۵۶\u200e')).toBe('123456')
    })

    it('ignores nullish stored barcode values while building the known-code index', () => {
        expect(normalizeBarcodeScannerText(null)).toBe('')

        const index = createBarcodeScannerCodeIndex([
            null,
            undefined,
            '1234567890123'
        ])

        expect(index.exact).not.toContain('')
        expect(shouldCommitBarcodeScannerValue('1234567890123', index)).toBe(true)
    })

    it('decodes scanner keys from physical keyboard codes', () => {
        expect(getBarcodeScannerEventKey(keyboardEvent({ key: 'ش', code: 'KeyA' }))).toBe('a')
        expect(getBarcodeScannerEventKey(keyboardEvent({ key: '!', code: 'Digit1', shiftKey: true }))).toBe('!')
        expect(getBarcodeScannerEventKey(keyboardEvent({ key: '١', code: 'Digit1' }))).toBe('1')
    })

    it('waits on known prefixes instead of committing idle partial scans', () => {
        const index = createBarcodeScannerCodeIndex(['1234567890123', 'ABC-42'])

        expect(shouldCommitBarcodeScannerValue('12345', index)).toBe(false)
        expect(shouldCommitBarcodeScannerValue('1234567890123', index)).toBe(true)
        expect(shouldCommitBarcodeScannerValue('ABC', index)).toBe(false)
        expect(shouldCommitBarcodeScannerValue('ABC-42', index)).toBe(true)
    })

    it('allows explicit terminators to submit unknown complete scans', () => {
        const index = createBarcodeScannerCodeIndex(['1234567890123'])

        expect(shouldCommitBarcodeScannerValue('99887766', index)).toBe(false)
        expect(shouldCommitBarcodeScannerValue('99887766', index, { hasTerminator: true, allowUnknown: true })).toBe(true)
    })
})
