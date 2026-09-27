import type { IQDDisplayPreference, Product } from '@/local-db'

export type BarcodeLabelData = {
    id: string
    productName: string
    barcode: string
    displayValue: string
    price: number
    currency: string
    unit: string
    iqdDisplayPreference: IQDDisplayPreference
}

export type BarcodeLabelPriceUnitTranslations = {
    perSquareMeter: string
    perDynamicKilogram: string
    perMeter: string
}

// Code 128 character-set B patterns. Each digit describes the width of an
// alternating black/white bar, beginning with black.
const CODE128_PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
] as const

function getPrintableCode128BValue(value: string) {
    const normalized = Array.from(value).map((character) => {
        const code = character.charCodeAt(0)
        return code >= 32 && code <= 126 ? character : '-'
    }).join('')

    return normalized || '-'
}

export function getCode128BBarWidths(value: string): number[] {
    const printableValue = getPrintableCode128BValue(value)
    const codes = Array.from(printableValue, (character) => character.charCodeAt(0) - 32)
    const checksum = (104 + codes.reduce((total, code, index) => total + code * (index + 1), 0)) % 103

    return [104, ...codes, checksum, 106].flatMap((code) =>
        Array.from(CODE128_PATTERNS[code], (width) => Number(width))
    )
}

export function getCode128BModuleCount(value: string) {
    return getCode128BBarWidths(value).reduce((total, width) => total + width, 0)
}

export function formatBarcodeLabelPrice(
    price: number,
    currency: string,
    iqdDisplayPreference: IQDDisplayPreference = 'IQD',
    unit?: string,
    pricePerUnitTranslations?: Partial<BarcodeLabelPriceUnitTranslations>
) {
    const normalizedCurrency = currency.toUpperCase()
    const maximumFractionDigits = normalizedCurrency === 'IQD' ? 0 : 2
    const formattedPrice = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits
    }).format(Number.isFinite(price) ? price : 0)

    const currencyLabel = normalizedCurrency === 'IQD' ? iqdDisplayPreference : normalizedCurrency
    const pricePerUnitLabel = getBarcodeLabelPricePerUnit(unit, pricePerUnitTranslations)

    return `${formattedPrice} ${currencyLabel}${pricePerUnitLabel ? ` ${pricePerUnitLabel}` : ''}`
}

export function getBarcodeLabelPricePerUnit(unit?: string, translations?: Partial<BarcodeLabelPriceUnitTranslations>) {
    const trimmedUnit = unit?.trim()
    const normalizedUnit = trimmedUnit?.toLowerCase().replace(/\s/g, '')

    if (normalizedUnit === 'm²' || normalizedUnit === 'm2') {
        return translations?.perSquareMeter || 'per 1m²'
    }

    // `Kg` is the dynamic-weight unit in the product form. Lowercase `kg`
    // is the regular/static unit and must remain a plain item price.
    if (trimmedUnit === 'Kg') {
        return translations?.perDynamicKilogram || 'per 1 Kg'
    }

    if (trimmedUnit === 'Meter') {
        return translations?.perMeter || 'per 1 Meter'
    }

    return ''
}

export function getBarcodeLabelData(
    products: Product[],
    iqdDisplayPreference: IQDDisplayPreference = 'IQD'
): BarcodeLabelData[] {
    return products.map((product) => {
        const barcode = product.barcode?.trim() || product.barcodes?.find((value) => value.trim())?.trim() || product.sku

        return {
            id: product.id,
            productName: product.name,
            barcode,
            displayValue: barcode || product.sku,
            price: product.price,
            currency: product.currency,
            unit: product.unit,
            iqdDisplayPreference
        }
    })
}
