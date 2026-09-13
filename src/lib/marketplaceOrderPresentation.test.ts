import { describe, expect, it } from 'vitest'

import {
  getMarketplaceInventoryDisplayStatus,
  getMarketplaceOrderDisplayStatus,
} from './marketplaceOrderPresentation'

describe('marketplace order return presentation', () => {
  it('shows a returned delivered order and its restored inventory', () => {
    expect(getMarketplaceOrderDisplayStatus('delivered', 'full')).toBe('returned')
    expect(getMarketplaceInventoryDisplayStatus('delivered', 'full', true)).toBe('returned')
  })

  it('also reflects a partial posted return as returned inventory', () => {
    expect(getMarketplaceOrderDisplayStatus('delivered', 'partial')).toBe('returned')
    expect(getMarketplaceInventoryDisplayStatus('delivered', 'partial', true)).toBe('returned')
  })

  it('preserves the lifecycle and deduction state when no return was posted', () => {
    expect(getMarketplaceOrderDisplayStatus('delivered', 'none')).toBe('delivered')
    expect(getMarketplaceInventoryDisplayStatus('delivered', 'none', true)).toBe('deducted')
    expect(getMarketplaceInventoryDisplayStatus('delivered', 'none', false)).toBe('warning')
  })

  it('does not allow an inconsistent return state to override an undelivered order', () => {
    expect(getMarketplaceOrderDisplayStatus('processing', 'full')).toBe('processing')
    expect(getMarketplaceInventoryDisplayStatus('processing', 'full', true)).toBeNull()
  })
})
