export const BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS = 150
export const BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT = 2
export const BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS = 700
export const BARCODE_SCANNER_ACTIVE_KEY_GRACE_MS = 1200
export const BARCODE_SCANNER_STALE_RESET_MS = 4000
export const BARCODE_SCANNER_MIN_SCAN_LENGTH = 3
export const BARCODE_SCANNER_BLUETOOTH_FAST_KEY_THRESHOLD_MS = 350
export const BARCODE_SCANNER_BLUETOOTH_AUTO_COMMIT_DELAY_MS = 1600
export const BARCODE_SCANNER_BLUETOOTH_ACTIVE_KEY_GRACE_MS = 3000
export const BARCODE_SCANNER_BLUETOOTH_STALE_RESET_MS = 9000

const ARABIC_INDIC_ZERO_CODE = 0x0660
const EASTERN_ARABIC_INDIC_ZERO_CODE = 0x06f0
const BIDI_CONTROL_CHARACTERS_PATTERN = /[\u061c\u200e\u200f]/g
const ARABIC_INDIC_DIGITS_PATTERN = /[\u0660-\u0669]/g
const EASTERN_ARABIC_INDIC_DIGITS_PATTERN = /[\u06f0-\u06f9]/g
const DIGIT_CODE_PATTERN = /^Digit([0-9])$/
const NUMPAD_CODE_PATTERN = /^Numpad([0-9])$/
const KEY_CODE_PATTERN = /^Key([A-Z])$/

const UNSHIFTED_CODE_VALUES: Record<string, string> = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: ' ',
    NumpadAdd: '+',
    NumpadSubtract: '-',
    NumpadDecimal: '.',
    NumpadDivide: '/',
    NumpadMultiply: '*'
}

const SHIFTED_CODE_VALUES: Record<string, string> = {
    Backquote: '~',
    Digit1: '!',
    Digit2: '@',
    Digit3: '#',
    Digit4: '$',
    Digit5: '%',
    Digit6: '^',
    Digit7: '&',
    Digit8: '*',
    Digit9: '(',
    Digit0: ')',
    Minus: '_',
    Equal: '+',
    BracketLeft: '{',
    BracketRight: '}',
    Backslash: '|',
    Semicolon: ':',
    Quote: '"',
    Comma: '<',
    Period: '>',
    Slash: '?'
}

type BarcodeScannerKeyboardEvent = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'> & {
    getModifierState?: (keyArg: string) => boolean
}

export type BarcodeScannerCodeIndex = {
    exact: Set<string>
    prefixes: Set<string>
}

export type BarcodeScannerKeyTiming = {
    deltaMs: number | null
    shouldReset: boolean
    isFast: boolean
}

export function shouldIgnoreBarcodeScannerKey(options: {
    hasFocusedEditable: boolean
    isScannerTargetFocused: boolean
}): boolean {
    // A scanner listener must never hijack fast human typing in a different
    // form control. Its target remains eligible so an enabled scanner can
    // still receive a hardware scan directly into the selected field.
    return options.hasFocusedEditable && !options.isScannerTargetFocused
}

export function classifyBarcodeScannerKeyTiming(
    timestamp: number,
    previousTimestamp: number,
    options: {
        hasBufferedValue: boolean
        isActive: boolean
        fastKeyThresholdMs?: number
        activeKeyGraceMs?: number
    }
): BarcodeScannerKeyTiming {
    if (!options.hasBufferedValue) {
        return {
            deltaMs: null,
            shouldReset: true,
            isFast: false
        }
    }

    const deltaMs = timestamp - previousTimestamp
    const isValidDelta = Number.isFinite(deltaMs) && deltaMs >= 0
    const fastKeyThresholdMs = options.fastKeyThresholdMs ?? BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS
    const activeKeyGraceMs = options.activeKeyGraceMs ?? BARCODE_SCANNER_ACTIVE_KEY_GRACE_MS

    return {
        deltaMs,
        shouldReset: !isValidDelta || deltaMs > (
            options.isActive
                ? activeKeyGraceMs
                : fastKeyThresholdMs
        ),
        // Hardware scanners can dispatch several keydowns inside the same
        // millisecond, so a zero-length interval is still a fast interval.
        isFast: isValidDelta && deltaMs <= fastKeyThresholdMs
    }
}

export function normalizeBarcodeDigits(value: string | null | undefined): string {
    return (value ?? '')
        .replace(BIDI_CONTROL_CHARACTERS_PATTERN, '')
        .replace(ARABIC_INDIC_DIGITS_PATTERN, (char) => String(char.charCodeAt(0) - ARABIC_INDIC_ZERO_CODE))
        .replace(EASTERN_ARABIC_INDIC_DIGITS_PATTERN, (char) => String(char.charCodeAt(0) - EASTERN_ARABIC_INDIC_ZERO_CODE))
}

export function normalizeBarcodeScannerText(value: string | null | undefined): string {
    return normalizeBarcodeDigits(value).trim()
}

export function normalizeBarcodeScannerKey(key: string | null | undefined): string {
    return normalizeBarcodeDigits(key)
}

export function isBarcodeScannerTerminatorKey(key: string): boolean {
    return key === 'Enter' || key === 'Tab'
}

export function isBarcodeScannerIgnoredKey(key: string): boolean {
    return key === 'Shift' || key === 'CapsLock' || key === 'Escape'
}

export function getBarcodeScannerEventKey(event: BarcodeScannerKeyboardEvent): string {
    const code = event.code

    const digitMatch = DIGIT_CODE_PATTERN.exec(code)
    if (digitMatch) {
        return event.shiftKey
            ? SHIFTED_CODE_VALUES[code] ?? digitMatch[1]
            : digitMatch[1]
    }

    const numpadMatch = NUMPAD_CODE_PATTERN.exec(code)
    if (numpadMatch) {
        return numpadMatch[1]
    }

    const keyMatch = KEY_CODE_PATTERN.exec(code)
    if (keyMatch) {
        const letter = keyMatch[1]
        const capsLock = event.getModifierState?.('CapsLock') ?? false
        return event.shiftKey !== capsLock ? letter : letter.toLowerCase()
    }

    const mapped = event.shiftKey
        ? SHIFTED_CODE_VALUES[code] ?? UNSHIFTED_CODE_VALUES[code]
        : UNSHIFTED_CODE_VALUES[code]
    if (mapped) {
        return mapped
    }

    return normalizeBarcodeScannerKey(event.key)
}

export function createBarcodeScannerCodeIndex(
    values: Iterable<string | null | undefined>
): BarcodeScannerCodeIndex {
    const exact = new Set<string>()
    const prefixes = new Set<string>()

    for (const value of values) {
        const normalized = normalizeBarcodeScannerText(value)
        if (!normalized) {
            continue
        }

        exact.add(normalized)
        exact.add(normalized.toLowerCase())

        for (const candidate of new Set([normalized, normalized.toLowerCase()])) {
            for (let length = 1; length < candidate.length; length += 1) {
                prefixes.add(candidate.slice(0, length))
            }
        }
    }

    return { exact, prefixes }
}

export function hasBarcodeScannerKnownPrefix(value: string, index?: BarcodeScannerCodeIndex): boolean {
    if (!index) {
        return false
    }

    const normalized = normalizeBarcodeScannerText(value)
    if (!normalized) {
        return false
    }

    return index.prefixes.has(normalized) || index.prefixes.has(normalized.toLowerCase())
}

export function hasBarcodeScannerExactCode(value: string, index?: BarcodeScannerCodeIndex): boolean {
    if (!index) {
        return false
    }

    const normalized = normalizeBarcodeScannerText(value)
    if (!normalized) {
        return false
    }

    return index.exact.has(normalized) || index.exact.has(normalized.toLowerCase())
}

export function shouldCommitBarcodeScannerValue(
    value: string,
    index?: BarcodeScannerCodeIndex,
    options: { hasTerminator?: boolean; allowUnknown?: boolean } = {}
): boolean {
    const normalized = normalizeBarcodeScannerText(value)
    if (normalized.length < BARCODE_SCANNER_MIN_SCAN_LENGTH) {
        return false
    }

    if (!index) {
        return true
    }

    const exact = hasBarcodeScannerExactCode(normalized, index)
    if (exact && (options.hasTerminator || !hasBarcodeScannerKnownPrefix(normalized, index))) {
        return true
    }

    if (options.hasTerminator && options.allowUnknown) {
        return true
    }

    if (options.allowUnknown && !hasBarcodeScannerKnownPrefix(normalized, index)) {
        return true
    }

    return false
}
