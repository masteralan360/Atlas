import { describe, expect, it } from 'vitest'

import {
  getMarketplaceDeliveryActorName,
  getMarketplaceInventoryDisplayStatus,
  getMarketplaceOrderDisplayStatus,
} from './marketplaceOrderPresentation'

describe('marketplace order return presentation', () => {
  it('shows a returned shipped order and its restored inventory', () => {
    expect(getMarketplaceOrderDisplayStatus('shipped', 'full')).toBe('returned')
    expect(getMarketplaceInventoryDisplayStatus('shipped', 'full', true)).toBe('returned')
  })

  it('also reflects a partial posted return as returned inventory after shipment', () => {
    expect(getMarketplaceOrderDisplayStatus('shipped', 'partial')).toBe('returned')
    expect(getMarketplaceInventoryDisplayStatus('shipped', 'partial', true)).toBe('returned')
  })

  it('preserves the shipped lifecycle and deduction state when no return was posted', () => {
    expect(getMarketplaceOrderDisplayStatus('shipped', 'none')).toBe('shipped')
    expect(getMarketplaceInventoryDisplayStatus('shipped', 'none', true)).toBe('deducted')
    expect(getMarketplaceInventoryDisplayStatus('shipped', 'none', false)).toBe('warning')
  })

  it('does not allow an inconsistent return state to override an undelivered order', () => {
    expect(getMarketplaceOrderDisplayStatus('processing', 'full')).toBe('processing')
    expect(getMarketplaceInventoryDisplayStatus('processing', 'full', true)).toBeNull()
  })

  it('uses the delivery-time actor snapshot when it is present', () => {
    expect(getMarketplaceDeliveryActorName('  Ava Ahmed  ', 'Unknown')).toBe('Ava Ahmed')
  })

  it('shows the localized unknown label for historical orders without attribution', () => {
    expect(getMarketplaceDeliveryActorName(null, 'Unknown')).toBe('Unknown')
    expect(getMarketplaceDeliveryActorName('   ', 'غير معروف')).toBe('غير معروف')
  })
})
