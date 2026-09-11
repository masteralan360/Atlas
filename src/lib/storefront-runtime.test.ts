import { describe, expect, it } from 'vitest'

import { storefrontApiUrl } from './storefront-runtime'

describe('storefrontApiUrl', () => {
  it('routes public image requests to JumlaKhaleej and strips Atlas cache suffixes', () => {
    expect(storefrontApiUrl('/api/inquiries/product-image?mode=retail%3Ageneration-1&productId=product-1'))
      .toBe('https://khaleejcosmetic.com/api/inquiries/product-image?mode=retail&productId=product-1')
  })
})
