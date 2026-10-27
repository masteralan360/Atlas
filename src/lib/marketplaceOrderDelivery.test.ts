import { describe, expect, it } from 'vitest'

import { getJumlaKhaleejMarketplaceDeliveryFee } from './marketplaceOrderDelivery'

describe('Jumla Khaleej order delivery snapshots', () => {
    it('preserves zero as a saved free-delivery fee', () => {
        expect(getJumlaKhaleejMarketplaceDeliveryFee([
            { metadata_type: 'jumla_khaleej_delivery_fee', delivery_fee: 0 }
        ], 'jumla-khaleej')).toBe(0)
    })

    it('keeps existing city fees and ignores unrelated storefronts', () => {
        const delivery = { metadata_type: 'jumla_khaleej_delivery_fee', delivery_fee: 5000 }
        expect(getJumlaKhaleejMarketplaceDeliveryFee([delivery], 'jumla-khaleej')).toBe(5000)
        expect(getJumlaKhaleejMarketplaceDeliveryFee([delivery], 'other-storefront')).toBeNull()
        expect(getJumlaKhaleejMarketplaceDeliveryFee([
            { metadata_type: 'jumla_khaleej_delivery_fee', delivery_fee: -1 }
        ], 'jumla-khaleej')).toBeNull()
    })
})
