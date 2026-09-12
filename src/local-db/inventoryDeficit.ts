export function isFiniteInventoryQuantity(value: number) {
  return Number.isFinite(value)
}

/**
 * New stock may never be negative. This is intentionally stricter than the
 * rounding epsilon: even a tiny negative value is a deficit and must not be
 * persisted.
 */
export function isValidNewInventoryQuantity(value: number) {
  return isFiniteInventoryQuantity(value) && value >= 0
}

/**
 * Legacy-compatible transition used by the database mirrors. Existing
 * negative values may stay unchanged or move toward zero, but can never be
 * made more negative. New rows and previously non-negative rows are strict.
 */
export function isAllowedInventoryQuantityTransition(
  previousValue: number | null | undefined,
  nextValue: number,
) {
  if (!isFiniteInventoryQuantity(nextValue)) return false
  if (nextValue >= 0) return true
  return typeof previousValue === 'number'
    && isFiniteInventoryQuantity(previousValue)
    && previousValue < 0
    && nextValue >= previousValue
}
