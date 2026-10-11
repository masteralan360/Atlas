const PRICE_BOOK_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

export function isValidPriceBookColor(value: unknown): value is string {
    return typeof value === 'string' && PRICE_BOOK_COLOR_PATTERN.test(value)
}

export function normalizePriceBookColor(value: string | null | undefined): string | null {
    if (value == null || value.trim() === '') {
        return null
    }

    const color = value.trim()
    if (!isValidPriceBookColor(color)) {
        throw new Error('Price Book color must be a six-digit hex color')
    }

    return color.toLowerCase()
}
