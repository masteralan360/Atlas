export const BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS = 150
export const BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT = 2
export const BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS = 300

const ARABIC_INDIC_ZERO_CODE = 0x0660
const EASTERN_ARABIC_INDIC_ZERO_CODE = 0x06f0
const BIDI_CONTROL_CHARACTERS_PATTERN = /[\u061c\u200e\u200f]/g
const ARABIC_INDIC_DIGITS_PATTERN = /[\u0660-\u0669]/g
const EASTERN_ARABIC_INDIC_DIGITS_PATTERN = /[\u06f0-\u06f9]/g

export function normalizeBarcodeDigits(value: string): string {
    return value
        .replace(BIDI_CONTROL_CHARACTERS_PATTERN, '')
        .replace(ARABIC_INDIC_DIGITS_PATTERN, (char) => String(char.charCodeAt(0) - ARABIC_INDIC_ZERO_CODE))
        .replace(EASTERN_ARABIC_INDIC_DIGITS_PATTERN, (char) => String(char.charCodeAt(0) - EASTERN_ARABIC_INDIC_ZERO_CODE))
}

export function normalizeBarcodeScannerText(value: string): string {
    return normalizeBarcodeDigits(value).trim()
}

export function normalizeBarcodeScannerKey(key: string): string {
    return normalizeBarcodeDigits(key)
}
