import { describe, expect, it } from 'vitest'

import {
  getOrderLineFreeBonusQuantity,
  getOrderLineFulfilledQuantity,
  getOrderLineInventoryQuantity,
  getOrderLinePaidQuantity,
  hasOrderLineInventoryQuantity,
  hasOrderLineFreeBonus,
  isFulfilledUnitsAvailableForOrder
} from './orderLineItems'

describe('order line item quantity normalization', () => {
  it('treats legacy items without free bonus as zero bonus', () => {
    const item = { quantity: 5 }

    expect(getOrderLinePaidQuantity(item)).toBe(5)
    expect(getOrderLineFreeBonusQuantity(item)).toBe(0)
    expect(getOrderLineInventoryQuantity(item)).toBe(5)
    expect(hasOrderLineFreeBonus([item])).toBe(false)
  })

  it('adds free bonus to inventory quantity without changing paid quantity', () => {
    const item = { quantity: 5, freeBonusQuantity: 2 }

    expect(getOrderLinePaidQuantity(item)).toBe(5)
    expect(getOrderLineFreeBonusQuantity(item)).toBe(2)
    expect(getOrderLineInventoryQuantity(item)).toBe(7)
    expect(hasOrderLineFreeBonus([item])).toBe(true)
  })

  it('accepts a bonus-only line while rejecting lines with no valid inventory quantity', () => {
    expect(hasOrderLineInventoryQuantity({ quantity: '', freeBonusQuantity: '2' })).toBe(true)
    expect(hasOrderLineInventoryQuantity({ quantity: '2', freeBonusQuantity: '' })).toBe(true)
    expect(hasOrderLineInventoryQuantity({ quantity: '', freeBonusQuantity: '' })).toBe(false)
    expect(hasOrderLineInventoryQuantity({ quantity: '0', freeBonusQuantity: '0' })).toBe(false)
    expect(hasOrderLineInventoryQuantity({ quantity: '-1', freeBonusQuantity: '-2' })).toBe(false)
    expect(hasOrderLineInventoryQuantity({ quantity: 'invalid', freeBonusQuantity: 'invalid' })).toBe(false)
  })

  it('normalizes null and pre-release freeQuantity aliases to zero-safe values', () => {
    expect(getOrderLineFreeBonusQuantity({ quantity: 3, freeBonusQuantity: null })).toBe(0)
    expect(getOrderLineInventoryQuantity({ quantity: 3, freeQuantity: 1 })).toBe(4)
  })

  it('uses the recorded fulfilled quantity, including an explicit zero', () => {
    expect(getOrderLineFulfilledQuantity({ quantity: 5, fulfilledQuantity: 2 }, true)).toBe(2)
    expect(getOrderLineFulfilledQuantity({ quantity: 5, fulfilledQuantity: 0 }, true)).toBe(0)
  })

  it('falls back to the full inventory quantity only for legacy completed lines', () => {
    const legacyItem = { quantity: 5, freeBonusQuantity: 2 }

    expect(getOrderLineFulfilledQuantity(legacyItem, true)).toBe(7)
    expect(getOrderLineFulfilledQuantity(legacyItem, false)).toBe(0)
  })

  it('makes fulfilled units available only from the rollout timestamp onward', () => {
    const populatedItems = [{ quantity: 2, fulfilledQuantity: 2 }]

    expect(isFulfilledUnitsAvailableForOrder('2026-09-08T17:59:59.999Z', [{ quantity: 2 }])).toBe(false)
    expect(isFulfilledUnitsAvailableForOrder('2026-09-08T18:00:00.000Z', [{ quantity: 2 }])).toBe(true)
    expect(isFulfilledUnitsAvailableForOrder('2026-09-08T18:00:00.001Z', [{ quantity: 2 }])).toBe(true)
    expect(isFulfilledUnitsAvailableForOrder('2026-09-08T17:00:00.000Z', populatedItems)).toBe(true)
    expect(isFulfilledUnitsAvailableForOrder('not-a-date', populatedItems)).toBe(true)
    expect(isFulfilledUnitsAvailableForOrder('not-a-date', [])).toBe(false)
  })
})
