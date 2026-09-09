import { roundQuantity } from '@/lib/quantity'

type OrderLineQuantityLike = {
  quantity?: unknown
  freeBonusQuantity?: unknown
  /** @deprecated Pre-release alias; normalize it as a bonus quantity if present. */
  freeQuantity?: unknown
  /** Quantity committed from inventory when a sales order is fulfilled. */
  fulfilledQuantity?: unknown
}

export const FULFILLED_UNITS_AVAILABLE_FROM = '2026-09-08T18:00:00.000Z'

function normalizeNonNegativeQuantity(value: unknown) {
  const quantity = Number(value ?? 0)
  return Number.isFinite(quantity)
    ? roundQuantity(Math.max(quantity, 0))
    : 0
}

export function getOrderLinePaidQuantity(item: OrderLineQuantityLike) {
  return normalizeNonNegativeQuantity(item.quantity)
}

export function getOrderLineFreeBonusQuantity(item: OrderLineQuantityLike) {
  return normalizeNonNegativeQuantity(item.freeBonusQuantity ?? item.freeQuantity)
}

export function getOrderLineInventoryQuantity(item: OrderLineQuantityLike) {
  return roundQuantity(getOrderLinePaidQuantity(item) + getOrderLineFreeBonusQuantity(item))
}

/**
 * Checks whether a line affects inventory. This includes a bonus-only line,
 * whose paid quantity is zero but free quantity is positive.
 */
export function hasOrderLineInventoryQuantity(item: OrderLineQuantityLike) {
  return getOrderLineInventoryQuantity(item) > 0
}

/**
 * Returns the quantity fulfilled from a sales-order line. Completed orders
 * saved before `fulfilledQuantity` was introduced fulfilled their whole line,
 * so use the inventory quantity as a read-only compatibility fallback.
 */
export function getOrderLineFulfilledQuantity(item: OrderLineQuantityLike, isCompleted: boolean) {
  if (item.fulfilledQuantity !== null && item.fulfilledQuantity !== undefined) {
    return normalizeNonNegativeQuantity(item.fulfilledQuantity)
  }

  return isCompleted ? getOrderLineInventoryQuantity(item) : 0
}

export function isFulfilledUnitsAvailableForOrder(
  createdAt: string | null | undefined,
  items: OrderLineQuantityLike[] | null | undefined
) {
  const createdAtTimestamp = Date.parse(createdAt || '')
  if (Number.isFinite(createdAtTimestamp)
    && createdAtTimestamp >= Date.parse(FULFILLED_UNITS_AVAILABLE_FROM)) {
    return true
  }

  if (!items?.length) return false

  return items.every((item) =>
    item.fulfilledQuantity !== null && item.fulfilledQuantity !== undefined
  )
}

export function hasOrderLineFreeBonus(items: OrderLineQuantityLike[] | null | undefined) {
  return Boolean(items?.some((item) => getOrderLineFreeBonusQuantity(item) > 0))
}
