import { describe, expect, it } from 'vitest'

import { isOrderUnitConfigurationError } from './orderUnitErrors'

describe('order unit save errors', () => {
  it('recognizes authoritative relationship, selection, and conversion failures', () => {
    expect(isOrderUnitConfigurationError(new Error('Order item unit conversion does not match the product configuration'))).toBe(true)
    expect(isOrderUnitConfigurationError({ message: 'Product unit relationship is unavailable' })).toBe(true)
    expect(isOrderUnitConfigurationError('Order unit selection cannot change after Draft')).toBe(true)
  })

  it('does not hide unrelated save failures behind the unit message', () => {
    expect(isOrderUnitConfigurationError(new Error('Insufficient inventory'))).toBe(false)
  })
})
