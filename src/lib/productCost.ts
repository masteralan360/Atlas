/**
 * A zero cost is legitimate. Only null, missing, non-finite, or negative
 * values mean that a product does not have a usable cost basis.
 */
export function hasValidProductCost(costPrice: unknown): costPrice is number {
    return typeof costPrice === 'number'
        && Number.isFinite(costPrice)
        && costPrice >= 0
}
