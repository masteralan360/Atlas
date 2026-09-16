import { DEFAULT_UNITS, normalizeUnitCode } from '@/local-db/models'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** Returns the translated built-in unit label, while preserving workspace-defined units. */
export function getProductUnitLabel(unit: string | null | undefined, t: Translate) {
    const normalizedUnit = normalizeUnitCode(unit)
    if (!normalizedUnit) return ''

    const builtInUnit = DEFAULT_UNITS.find(
        ({ code }) => normalizeUnitCode(code).toLocaleLowerCase() === normalizedUnit.toLocaleLowerCase()
    )
    const unitCode = builtInUnit?.code ?? normalizedUnit.toLowerCase()
    return t(`products.units.${unitCode}`, { defaultValue: normalizedUnit })
}

export function formatProductQuantity(
    quantity: number | null | undefined,
    unit: string | null | undefined,
    language: string,
    t: Translate
) {
    if (quantity === null || quantity === undefined) return '—'

    const value = new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(quantity)
    const unitLabel = getProductUnitLabel(unit, t)
    return unitLabel ? `${value} ${unitLabel}` : value
}
